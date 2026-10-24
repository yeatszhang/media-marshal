import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  session,
  Tray,
} from "electron";
import {
  createApplication,
  type ApplicationModule,
} from "@yeatz/app-framework/application";
import { createIdentifier } from "@yeatz/app-framework/ioc";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { realpath, writeFile } from "node:fs/promises";
import {
  DESKTOP_CHANNEL,
  DesktopError,
  PROTOCOL_VERSION,
  coreActions,
  nativeActions,
  parseCoreRequest,
  publicError,
  type DesktopRuntime,
} from "@media-marshal/contracts";
import { CoreSupervisor } from "./core-supervisor";
import { Credentials } from "./credentials";
import { APP_ORIGIN, assetPath, requireTrustedRequest } from "./security";
import { trayIcon } from "./tray-icon";
import { SidecarSupervisor } from "./cloud/sidecar-supervisor";
import { AccountCredentials } from "./cloud/account-credentials";
import { defaultDiagnostic } from "./cloud/diagnostics";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "marshal",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
const dataArgument = process.argv.find((value) =>
  value.startsWith("--user-data-dir="),
);
if (dataArgument)
  app.setPath("userData", dataArgument.slice("--user-data-dir=".length));
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
else void app.whenReady().then(bootstrap);

async function bootstrap() {
  const coreToken = createIdentifier<CoreSupervisor>("desktop.core");
  const credentialToken = createIdentifier<Credentials>("desktop.credentials");
  const sidecarToken = createIdentifier<SidecarSupervisor>("desktop.sidecars");
  const accountCredentialToken = createIdentifier<AccountCredentials>("desktop.account-credentials");
  const developmentUrl = !app.isPackaged
    ? process.env.ELECTRON_RENDERER_URL
    : undefined;
  let window: BrowserWindow | undefined;
  let tray: Tray | undefined;
  let exiting = false;
  let closing = false;
  let didExplainClose = false;
  const grants = new Map<string, "source" | "target">();
  const show = () => {
    if (window && !window.isDestroyed()) {
      window.show();
      window.focus();
    }
  };
  const showWindow = async () => {
    if (window && !window.isDestroyed()) {
      show();
      return;
    }
    window = new BrowserWindow({
      width: 1240,
      height: 820,
      minWidth: 920,
      minHeight: 640,
      show: false,
      title: "Media Marshal",
      backgroundColor: "#f7f8fa",
      webPreferences: {
        preload: join(__dirname, "../preload/index.js"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, url) => {
      try {
        requireTrustedRequest({}, url, true, developmentUrl);
      } catch {
        event.preventDefault();
      }
    });
    window.webContents.on("will-attach-webview", (event) =>
      event.preventDefault(),
    );
    window.on("close", (event) => {
      if (exiting) return;
      event.preventDefault();
      if (closing) return;
      if (!didExplainClose) {
        closing = true;
        void dialog
          .showMessageBox(window!, {
            type: "info",
            title: "应用将在后台运行",
            message: "关闭窗口后，Media Marshal 仍在托盘中运行。",
            detail: "从托盘重新打开窗口；选择“退出”会停止应用。",
            buttons: ["留在后台", "退出应用"],
            defaultId: 0,
            cancelId: 0,
          })
          .then((result) => {
            didExplainClose = true;
            closing = false;
            if (result.response === 1) app.quit();
            else window?.hide();
          });
      } else window?.hide();
    });
    window.on("closed", () => {
      window = undefined;
      grants.clear();
    });
    window.webContents.on("did-start-navigation", () => grants.clear());
    window.once("ready-to-show", show);
    if (developmentUrl) await window.loadURL(developmentUrl);
    else await window.loadURL(`${APP_ORIGIN}/index.html`);
  };
  const host: ApplicationModule = {
    id: "desktop.host",
    start(ctx) {
      session.defaultSession.setPermissionRequestHandler(
        (_contents, _permission, callback) => callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      protocol.handle("marshal", (request) => {
        try {
          return net.fetch(
            pathToFileURL(
              assetPath(join(__dirname, "../renderer"), request.url),
            ).toString(),
          );
        } catch {
          return new Response("页面不存在", { status: 404 });
        }
      });
      ctx.disposables.add(() => protocol.unhandle("marshal"));
    },
  };
  const credentials: ApplicationModule = {
    id: "desktop.credentials",
    register(bind) {
      bind(credentialToken).toConstantValue(
        new Credentials(join(app.getPath("userData"), "credentials.json")),
      );
    },
  };
  const sidecars: ApplicationModule = {
    id: "desktop.sidecars",
    dependencies: ["desktop.host"],
    register(bind) {
      const target = `${process.platform}-${process.arch}`;
      bind(sidecarToken).toConstantValue(new SidecarSupervisor({
        workerPath: join(__dirname, "sidecar-host.js"), appPath: app.getAppPath(),
        resourceRoot: app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "resources/sidecars", target),
        privateRoot: join(app.getPath("userData"), "sidecars"),
      }));
    },
    start(ctx) { ctx.disposables.add(() => ctx.get(sidecarToken).stop()); },
  };
  const accountCredentials: ApplicationModule = {
    id: "desktop.account-credentials", dependencies: ["desktop.credentials", "desktop.sidecars"],
    start(ctx) { ctx.container.bind(accountCredentialToken).toConstantValue(new AccountCredentials(ctx.get(credentialToken), ctx.get(sidecarToken))); },
  };
  const core: ApplicationModule = {
    id: "desktop.core",
    dependencies: ["desktop.host", "desktop.credentials", "desktop.sidecars"],
    register(bind) {
      bind(coreToken).toConstantValue(
        new CoreSupervisor(
          join(__dirname, "worker.js"),
          app.getPath("userData"),
        ),
      );
    },
    start(ctx) {
      const supervisor = ctx.get(coreToken);
      // 对象仍按需启动；本地目录流程不会启动 Host 或 Go 组件。
      supervisor.attachHostBridge(ctx.get(sidecarToken));
      ctx.disposables.add(() => supervisor.stop());
      // 启动受跟踪但不阻挡窗口，失败由状态页提供重试入口。
      void ctx.effects.run(
        () => supervisor.start().catch(() => {}),
        "启动媒体核心",
      );
    },
  };
  const bridge: ApplicationModule = {
    id: "desktop.bridge",
    dependencies: ["desktop.core"],
    start(ctx) {
      const supervisor = ctx.get(coreToken),
        vault = ctx.get(credentialToken);
      ipcMain.handle(DESKTOP_CHANNEL, async (event, value: unknown) => {
        try {
          requireTrustedRequest(
            value,
            event.senderFrame?.url ?? "",
            Boolean(
              window &&
                event.sender === window.webContents &&
                event.senderFrame === window.webContents.mainFrame,
            ),
            developmentUrl,
          );
          if (
            !value ||
            typeof value !== "object" ||
            !("action" in value) ||
            typeof value.action !== "string" ||
            !("payload" in value)
          )
            throw new DesktopError("INVALID_REQUEST", "请求格式无效");
          if (
            !("protocolVersion" in value) ||
            value.protocolVersion !== PROTOCOL_VERSION
          )
            throw new DesktopError(
              "PROTOCOL_MISMATCH",
              "页面与应用版本不一致，请重新打开窗口",
            );
          const action = value.action;
          if (Object.prototype.hasOwnProperty.call(nativeActions, action)) {
            const schema = nativeActions[action as keyof typeof nativeActions];
            const parsed = schema.safeParse(value.payload);
            if (!parsed.success)
              throw new DesktopError("INVALID_REQUEST", "参数无效");
            if (action === "desktop.runtime") {
              const status =
                supervisor.state === "ready"
                  ? await supervisor
                      .request("runtime.get", {})
                      .catch(() => null)
                  : null;
              return {
                ok: true,
                result: {
                  appVersion: app.getVersion(),
                  protocolVersion: PROTOCOL_VERSION,
                  core: supervisor.state,
                  detail: supervisor.detail,
                  status,
                } satisfies DesktopRuntime,
              };
            }
            if (action === "desktop.choose-directory") {
              const purpose = (parsed.data as { purpose: "source" | "target" })
                .purpose;
              const chosen = await dialog.showOpenDialog(window!, {
                title:
                  purpose === "source"
                    ? "选择下载来源目录"
                    : "选择 Emby 媒体目标目录",
                properties: ["openDirectory"],
              });
              const path = chosen.canceled
                ? null
                : (chosen.filePaths[0] ?? null);
              if (path) {
                const canonical = await realpath(path);
                grants.set(canonical, purpose);
                return { ok: true, result: canonical };
              }
              return { ok: true, result: null };
            }
            if (action === "desktop.credentials.save") {
              const { kind, value } = parsed.data as {
                kind: "tmdb" | "emby";
                value: string;
              };
              await vault.save(kind, value);
              return { ok: true, result: null };
            }
            if (action === "desktop.settings")
              return {
                ok: true,
                result: {
                  ...(await supervisor.request("settings.get", {})),
                  ...(await vault.configured()),
                },
              };
            if (action === "desktop.restart-core") {
              await supervisor.restart();
              return { ok: true, result: null };
            }
            if (action === "desktop.diagnostics.export") {
              const selected = await dialog.showSaveDialog(window!, { title: "导出诊断", defaultPath: "media-marshal-diagnostics.json", filters: [{ name: "JSON", extensions: ["json"] }] });
              if (selected.canceled || !selected.filePath) return { ok: true, result: false };
              const activity = supervisor.state === "ready" ? await supervisor.request("cloud.diagnostics", {}).catch(() => null) : null;
              const diagnostic = defaultDiagnostic({ appVersion: app.getVersion(), electronVersion: process.versions.electron, target: `${process.platform}-${process.arch}`, core: supervisor.state, cloud: ctx.get(sidecarToken).diagnostic(), activity });
              await writeFile(selected.filePath, diagnostic, { mode: 0o600 });
              return { ok: true, result: true };
            }
          }
          const request = parseCoreRequest({ ...value, kind: "request" });
          if (request.action === "sources.save") {
            const draft = coreActions["sources.save"].input.parse(
              request.payload,
            );
            const existing = draft.id
              ? (await supervisor.request("sources.list", {})).find(
                  (source) => source.id === draft.id,
                )
              : undefined;
            const paths = await Promise.all([
              realpath(draft.sourcePath),
              realpath(draft.targetPath),
            ]);
            if (
              (grants.get(paths[0]!) !== "source" &&
                existing?.sourcePath !== paths[0]) ||
              (grants.get(paths[1]!) !== "target" &&
                existing?.targetPath !== paths[1])
            )
              throw new DesktopError(
                "FORBIDDEN",
                "请通过系统对话框选择来源与目标目录",
              );
          }
          return {
            ok: true,
            result: await supervisor.request(
              request.action,
              request.payload as never,
            ),
          };
        } catch (error) {
          return { ok: false, error: publicError(error) };
        }
      });
      ctx.disposables.add(() => ipcMain.removeHandler(DESKTOP_CHANNEL));
    },
  };
  const windows: ApplicationModule = {
    id: "desktop.windows",
    dependencies: ["desktop.bridge"],
    async start(ctx) {
      ctx.disposables.add(() => {
        tray?.destroy();
        if (window && !window.isDestroyed()) window.destroy();
      });
      await showWindow();
      tray = new Tray(trayIcon());
      tray.setToolTip("Media Marshal");
      tray.setContextMenu(
        Menu.buildFromTemplate([
          { label: "打开 Media Marshal", click: show },
          { type: "separator" },
          { label: "退出", click: () => app.quit() },
        ]),
      );
      tray.on("double-click", show);
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: "Media Marshal",
            submenu: [
              { label: "显示主窗口", click: show },
              { role: "quit", label: "退出" },
            ],
          },
          { role: "editMenu", label: "编辑" },
          { role: "viewMenu", label: "视图" },
        ]),
      );
    },
  };
  const desktop = createApplication({
    modules: [host, credentials, sidecars, accountCredentials, core, bridge, windows],
  });
  app.on("second-instance", () => {
    void showWindow();
  });
  app.on("activate", () => {
    void showWindow();
  });
  app.on("window-all-closed", () => {});
  app.on("before-quit", (event) => {
    if (exiting) return;
    event.preventDefault();
    exiting = true;
    // 在框架 drain 前显式停止核心，避免已跟踪启动/任务阻止资源清理。
    void (async () => {
      try {
        await desktop.container.get(coreToken).stop();
      } finally {
        await desktop.stop().catch(() => {});
        app.quit();
      }
    })().catch(() => app.quit());
  });
  await desktop.start().catch(async () => {
    await desktop.stop().catch(() => {});
    dialog.showErrorBox(
      "客户端启动失败",
      "无法初始化客户端，请重新启动或检查安装包。",
    );
    exiting = true;
    app.quit();
  });
}
