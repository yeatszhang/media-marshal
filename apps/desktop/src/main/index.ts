import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  powerMonitor,
  session,
  Tray,
  shell,
} from "electron";
import {
  createApplication,
  type ApplicationModule,
} from "@yeatz/app-framework/application";
import { createIdentifier } from "@yeatz/app-framework/ioc";
import { join, dirname } from "node:path";
import { pathToFileURL } from "node:url";
import { realpath, writeFile, readFile } from "node:fs/promises";
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
import { CORE_DATA_SCHEMA_VERSION } from "@media-marshal/contracts/internal/core";
import { ManagedUpgradeBackups, type RuntimeVersion } from "./cloud/upgrades";
import { CoreSupervisor } from "./core-supervisor";
import { Credentials } from "./credentials";
import { APP_ORIGIN, assetPath, requireTrustedRequest } from "./security";
import { trayIcon } from "./tray-icon";
import { SidecarSupervisor } from "./cloud/sidecar-supervisor";
import { AccountCredentials } from "./cloud/account-credentials";
import { defaultDiagnostic } from "./cloud/diagnostics";
import { CloudAccountController } from "./cloud/accounts";
import { DownloadRootController } from "./cloud/roots";
import { cloudCredentialDraftSchema } from "@media-marshal/contracts";
import { parserLaunchSchema } from "@media-marshal/contracts/internal";
import { createHash } from "node:crypto";
import { probeManagedVolume, probeReadOnlyVolume } from "./cloud/volume-probe";

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
  const cloudAccountsToken = createIdentifier<CloudAccountController>("desktop.cloud-accounts");
  const downloadRootsToken = createIdentifier<DownloadRootController>("desktop.download-roots");
  const developmentUrl = !app.isPackaged
    ? process.env.ELECTRON_RENDERER_URL
    : undefined;
  let window: BrowserWindow | undefined;
  let tray: Tray | undefined;
  let exiting = false;
  let maintenance = false;
  const backups = new ManagedUpgradeBackups(app.getPath("userData"));
  const parserLaunch = async () => {
    const target = `${process.platform}-${process.arch}`, directory = app.isPackaged ? join(app.getAppPath(), "resources/parser") : join(app.getAppPath(), "resources/parser", target);
    try { const data = await readFile(join(directory, "manifest.json")); if (data.length > 1024 * 1024) return undefined; return parserLaunchSchema.parse({ root: app.isPackaged ? join(process.resourcesPath, "parser") : join(directory, "runtime"), manifest: JSON.parse(data.toString("utf8")) }); }
    catch { return undefined; }
  };
  const runtimeVersion = async (): Promise<RuntimeVersion> => {
    const target = `${process.platform}-${process.arch}`, root = app.isPackaged ? join(app.getAppPath(), "resources/sidecars") : join(app.getAppPath(), "resources/sidecars", target);
    try {
      const [manifest, guardian] = await Promise.all([readFile(join(root, "manifest.json"), "utf8"), readFile(join(root, "guardian.json"), "utf8")]);
      const resource = JSON.parse(manifest), guard = JSON.parse(guardian);
      const parser = await parserLaunch();
      return { appVersion: app.getVersion(), schemaVersion: CORE_DATA_SCHEMA_VERSION, target, components: { openlist: resource.components.openlist.binary.sha256, rclone: resource.components.rclone.binary.sha256, guardian: guard.binary.sha256, ...(parser ? { parser: createHash("sha256").update(JSON.stringify(parser.manifest)).digest("hex") } : {}) } };
    } catch (error) {
      if (app.isPackaged || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { appVersion: app.getVersion(), schemaVersion: CORE_DATA_SCHEMA_VERSION, target, components: {} };
    }
  };
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
        metadataRoot: app.isPackaged ? join(app.getAppPath(), "resources/sidecars") : undefined,
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
    dependencies: ["desktop.host", "desktop.credentials", "desktop.sidecars", "desktop.account-credentials"],
    register(bind) {
      bind(coreToken).toConstantValue(
        new CoreSupervisor(
          join(__dirname, "worker.js"),
          app.getPath("userData"),
          undefined,
          parserLaunch,
        ),
      );
    },
    start(ctx) {
      const supervisor = ctx.get(coreToken);
      // 对象仍按需启动；本地目录流程不会启动 Host 或 Go 组件。
      supervisor.attachHostBridge(ctx.get(sidecarToken));
      const accounts = new CloudAccountController(supervisor, ctx.get(accountCredentialToken), ctx.get(credentialToken));
      const privateData = app.getPath("userData"), installation = app.isPackaged ? process.platform === "darwin" ? join(process.resourcesPath, "../..") : dirname(app.getPath("exe")) : app.getAppPath();
      const protectedPaths = [installation, join(privateData, "sidecars"), join(privateData, "private-backups"), ...["desktop.sqlite3", "credentials.json", "runtime-version.json"].map((name) => join(privateData, name))];
      const roots = new DownloadRootController(supervisor, ctx.get(sidecarToken), undefined, protectedPaths);
      ctx.container.bind(cloudAccountsToken).toConstantValue(accounts);
      ctx.container.bind(downloadRootsToken).toConstantValue(roots);
      let recovering: Promise<void> | undefined;
      const recover = () => recovering ??= (async () => {
        if (exiting || supervisor.state !== "ready") return;
        await roots.restore();
        for (const previous of await supervisor.requestPrivate("media.library.bootstrap", {})) {
          try { const target = await probeManagedVolume(await roots.validateDirectory(previous.target.path), previous.target.id); await supervisor.requestPrivate("media.library.authorize", { mediaType: previous.mediaType, target }); }
          catch { /* 缺盘保持目标不可用，不能给同名替代卷重新授权。 */ }
        }
        for (const previous of await supervisor.requestPrivate("media.sources.bootstrap", {})) {
          try {
            const source = await probeReadOnlyVolume(await roots.validateDirectory(previous.source.path), previous.source.id);
            const target = await probeManagedVolume(await roots.validateDirectory(previous.target.path), previous.target.id);
            await supervisor.requestPrivate("media.sources.authorize", { ...previous, source, target });
          } catch { /* 原卷或授权未恢复时保持未验证，不重新绑定相同路径的新硬盘。 */ }
        }
        if (await backups.reconciliationNeeded()) { await supervisor.requestPrivate("cloud.downloads.reconcile-restored", {}); await backups.acknowledgeReconciliation(); }
        await accounts.restore();
        await supervisor.requestPrivate("cloud.runtime.wake", { hostGeneration: ctx.get(sidecarToken).generation });
      })().finally(() => { recovering = undefined; });
      supervisor.onReady = async () => {
        const vault = ctx.get(credentialToken);
        const [tmdb, emby] = await Promise.all([vault.readService("tmdb"), vault.readService("emby")]);
        await supervisor.requestPrivate("media.credentials.install", { tmdb, emby });
        await recover(); await backups.recordVersion(await runtimeVersion());
      };
      let capacityMaintenance: Promise<void> | undefined;
      const host = ctx.get(sidecarToken);
      host.onCapacity = () => {
        if (capacityMaintenance || exiting || maintenance || supervisor.state !== "ready") return;
        const generation = host.generation;
        capacityMaintenance = (async () => {
          await supervisor.requestPrivate("cloud.downloads.quiesce", {}).catch(() => {}); await accounts.waitIdle();
          if (!exiting && !maintenance && generation === host.generation && supervisor.state === "ready") await supervisor.restart();
        })().catch(() => { if (!exiting && !maintenance) { supervisor.state = "failed"; supervisor.detail = "组件维护未完成，请重启核心后继续。"; } }).finally(() => { capacityMaintenance = undefined; });
      };
      ctx.disposables.add(() => { host.onCapacity = undefined; });
      const resume = () => { void recover().catch(() => {}); };
      powerMonitor.on("resume", resume);
      ctx.disposables.add(() => { powerMonitor.removeListener("resume", resume); });
      ctx.disposables.add(() => accounts.stop());
      ctx.disposables.add(() => supervisor.stop());
      // 启动受跟踪但不阻挡窗口，失败由状态页提供重试入口。
      void ctx.effects.run(
        async () => {
          try {
            await backups.recover();
            const version = await runtimeVersion(), previous = await backups.previousVersion();
            if ((previous && JSON.stringify(previous) !== JSON.stringify(version)) || (!previous && await backups.hasDatabase())) {
              const host = ctx.get(sidecarToken); host.retainForBackup(); await host.prepareOfflineBackup(); await ctx.get(credentialToken).drain();
              await backups.capture(previous ?? { ...version, appVersion: "legacy", schemaVersion: 0, components: {} }); await host.releaseBackupState();
            }
            await supervisor.start();
          } catch { supervisor.state = "failed"; supervisor.detail = "启动或升级检查失败。请使用应用菜单恢复匹配备份，或检查安装包。"; }
        },
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
          if (maintenance || exiting) throw new DesktopError("INTERRUPTED", "正在停止客户端，请等待操作完成");
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
            if (action === "desktop.cloud.authorize") return { ok: true, result: await ctx.get(cloudAccountsToken).authorize(cloudCredentialDraftSchema.parse(parsed.data)) };
            if (action === "desktop.cloud.choose-root") {
              const chosen = await dialog.showOpenDialog(window!, { title: "选择受管下载根目录", properties: ["openDirectory", "createDirectory"] });
              const path = chosen.canceled ? null : chosen.filePaths[0];
              return { ok: true, result: path ? await ctx.get(downloadRootsToken).choose(path) : null };
            }
            if (action === "desktop.cloud.open-completed") {
              const path = await supervisor.requestPrivate("cloud.downloads.completed-root", parsed.data as { jobId: string });
              if (await shell.openPath(path)) throw new DesktopError("LOCAL_UNAVAILABLE", "下载目录不可用");
              return { ok: true, result: null };
            }
            if (action === "desktop.cloud.disconnect") { await ctx.get(cloudAccountsToken).disconnect((parsed.data as { accountId: string }).accountId); return { ok: true, result: null }; }
            if (action === "desktop.cloud.restore") { await ctx.get(downloadRootsToken).restore(); await ctx.get(cloudAccountsToken).restore(); await supervisor.requestPrivate("cloud.runtime.wake", { hostGeneration: ctx.get(sidecarToken).generation }); return { ok: true, result: null }; }
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
              const [tmdb, emby] = await Promise.all([vault.readService("tmdb"), vault.readService("emby")]);
              await supervisor.requestPrivate("media.credentials.install", { tmdb, emby });
              return { ok: true, result: null };
            }
            if (action === "desktop.ingestion.configure") {
              const input = nativeActions["desktop.ingestion.configure"].parse(parsed.data), path = await realpath(input.targetPath);
              const sources = await supervisor.requestPrivate("media.sources.bootstrap", {}), existing = sources.find((row) => row.downloadRootId === input.downloadRootId);
              const configured = (await supervisor.requestPrivate("media.library.bootstrap", {})).find((row) => row.target.path === path);
              if (grants.get(path) !== "target" && existing?.target.path !== path && !configured) throw new DesktopError("FORBIDDEN", "请通过系统对话框选择媒体目标目录");
              const source = (await supervisor.requestPrivate("cloud.roots.bootstrap", {})).find((row) => row.id === input.downloadRootId);
              if (!source) throw new DesktopError("CONFLICT", "请先选择受管下载目录");
              const target = await probeManagedVolume(await ctx.get(downloadRootsToken).validateDirectory(path), existing?.target.path === path ? existing.target.id : configured?.target.id);
              const sourceId = await supervisor.requestPrivate("media.sources.configure-managed", { ...input, source, target });
              return { ok: true, result: (await supervisor.request("sources.list", {})).find((row) => row.id === sourceId) };
            }
            if (action === "desktop.media.choose-target") {
              const { mediaType } = nativeActions["desktop.media.choose-target"].parse(parsed.data);
              const selected = await dialog.showOpenDialog(window!, { title: mediaType === "MOVIE" ? "选择电影媒体库目录" : "选择剧集媒体库目录", properties: ["openDirectory"] });
              if (!selected.canceled && selected.filePaths[0]) {
                const path = await ctx.get(downloadRootsToken).validateDirectory(selected.filePaths[0]);
                const known = (await supervisor.requestPrivate("media.sources.bootstrap", {})).map((row) => row.target).concat((await supervisor.requestPrivate("media.library.bootstrap", {})).map((row) => row.target));
                const target = await probeManagedVolume(path, known.find((row) => row.path === path)?.id);
                await supervisor.requestPrivate("media.library.authorize", { mediaType, target }); grants.set(path, "target");
              }
              return { ok: true, result: await supervisor.request("media.libraries", {}) };
            }
            if (action === "desktop.emby.open") {
              const { taskId } = nativeActions["desktop.emby.open"].parse(parsed.data), address = await supervisor.requestPrivate("media.emby.open-url", { taskId });
              const saved = await supervisor.request("settings.get", {}), url = new URL(address), base = new URL(saved.embyUrl);
              if (!["http:", "https:"].includes(url.protocol) || url.origin !== base.origin || url.username || url.password || url.search || !url.pathname.endsWith("/web/index.html")) throw new DesktopError("FORBIDDEN", "Emby 页面地址未通过核验");
              await shell.openExternal(url.href); return { ok: true, result: null };
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
            if (action === "desktop.upgrade.prepare" || action === "desktop.upgrade.restore") {
              await performUpgrade(action === "desktop.upgrade.restore"); return { ok: true, result: null };
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
            const policy = ctx.get(downloadRootsToken);
            await Promise.all(paths.map((path) => policy.validateDirectory(path)));
            const authorizations = await supervisor.requestPrivate("media.sources.bootstrap", {}), previous = authorizations.find((row) => row.sourceId === draft.id);
            if (previous?.mode === "managed") throw new DesktopError("INVALID_REQUEST", "受管来源请通过下载目录配置修改");
            const saved = await supervisor.request("sources.save", draft);
            const source = await probeReadOnlyVolume(paths[0]!, previous?.source.path === paths[0] ? previous.source.id : undefined);
            const configuredTargets = await supervisor.requestPrivate("media.library.bootstrap", {});
            const target = await probeManagedVolume(paths[1]!, previous?.target.path === paths[1] ? previous.target.id : configuredTargets.find((row) => row.target.path === paths[1])?.target.id);
            await supervisor.requestPrivate("media.sources.authorize", { sourceId: saved.id, sourceVersion: saved.version, mode: "local", downloadRootId: null, source, target });
            return { ok: true, result: (await supervisor.request("sources.list", {})).find((row) => row.id === saved.id) };
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
              { label: "恢复升级备份…", click: () => { void performUpgrade(true).catch(() => {}); } },
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
  async function performUpgrade(restore: boolean) {
    if (maintenance || exiting) throw new DesktopError("CONFLICT", "客户端正在停止");
    let chosen: string | undefined;
    if (restore) {
      const choices = (await backups.list()).slice(0, 8);
      if (!choices.length) { await dialog.showMessageBox({ type: "info", message: "没有可恢复的升级备份。" }); return; }
      const pick = await dialog.showMessageBox({ type: "question", title: "恢复升级备份", message: "选择与待运行客户端匹配的数据备份。下载文件和媒体库会保留。", buttons: [...choices.map((item) => `${item.appVersion} · 数据 v${item.schemaVersion} · ${new Date(item.createdAt).toLocaleString()}`), "取消"], cancelId: choices.length, defaultId: choices.length });
      chosen = choices[pick.response]?.id; if (!chosen) return;
      const confirm = await dialog.showMessageBox({ type: "question", title: "确认恢复并退出", message: "将先停写并备份当前数据，再恢复所选业务库、凭据密文与组件状态。", detail: "应用随后退出。安装匹配版本后再打开；恢复后会核对现存下载文件，不删除或覆盖媒体文件。", buttons: ["取消", "恢复并退出"], defaultId: 0, cancelId: 0 }); if (confirm.response !== 1) return;
    }
    maintenance = true;
    try {
      const host = desktop.container.get(sidecarToken); host.retainForBackup();
      await desktop.container.get(cloudAccountsToken).stop(); await desktop.container.get(coreToken).stop(); await host.stop(); await host.prepareOfflineBackup(); await desktop.container.get(credentialToken).drain();
      const version = await runtimeVersion(); await backups.capture(version);
      if (chosen) await backups.restore(chosen, version);
      await dialog.showMessageBox({ type: "info", title: restore ? "恢复完成" : "升级备份完成", message: restore ? "数据已恢复，应用将退出。请安装与备份匹配的客户端。" : "已停写并保存私有备份，应用将退出。现在可以替换整个 App。", detail: "备份只保存在本机受限数据目录，不包含下载文件或媒体库，也不会进入普通诊断导出。" });
      setTimeout(() => app.quit(), 100);
    } catch (error) {
      dialog.showErrorBox("升级操作未完成", "已保持停止状态，请退出客户端。可以重新打开并从应用菜单恢复备份；不要手动覆盖业务数据库。"); throw error;
    }
  }
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
