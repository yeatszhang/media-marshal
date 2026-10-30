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
  type MenuItemConstructorOptions,
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
import { nativeFilesLaunch } from "./native-files";
import { Credentials } from "./credentials";
import { APP_ORIGIN, assetPath, requireEmbyItemUrl, requireTrustedRequest } from "./security";
import { trayIcon } from "./tray-icon";
import { windowPresentation } from "./window-presentation";
import { HostPreferencesController } from "./host-preferences";
import { DesktopAboutController } from "./desktop-about";
import { RendererReloadController } from "./renderer-reload";
import { NativePauseControls, type PauseKind } from "./native-pause-controls";
import { SidecarSupervisor } from "./cloud/sidecar-supervisor";
import { AccountCredentials } from "./cloud/account-credentials";
import { defaultDiagnostic } from "./cloud/diagnostics";
import { CloudAccountController } from "./cloud/accounts";
import { QuarkLoginController } from "./cloud/quark-login";
import { DownloadRootController } from "./cloud/roots";
import { cloudCredentialDraftSchema } from "@media-marshal/contracts";
import { parserLaunchSchema } from "@media-marshal/contracts/internal";
import { createHash } from "node:crypto";
import { probeManagedVolume, probeReadOnlyVolume } from "./cloud/volume-probe";

async function installServiceCredentials(supervisor: CoreSupervisor, vault: Credentials) {
  const { values, unavailable } = await vault.readServices();
  await supervisor.requestPrivate("media.credentials.install", values);
  supervisor.detail = unavailable.length ? `${unavailable.map((kind) => kind === "tmdb" ? "TMDB" : "Emby").join("、")} 的本机凭据无法解密，请进入设置重新保存对应密钥。原密文已保留；其他可用连接可继续使用。` : null;
}

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
windowPresentation.prepare(app);
windowPresentation.guardNativeUi(dialog, shell);
const single = app.requestSingleInstanceLock();
if (!single) app.quit();
else void app.whenReady().then(bootstrap);

async function bootstrap() {
  const coreToken = createIdentifier<CoreSupervisor>("desktop.core");
  const credentialToken = createIdentifier<Credentials>("desktop.credentials");
  const sidecarToken = createIdentifier<SidecarSupervisor>("desktop.sidecars");
  const accountCredentialToken = createIdentifier<AccountCredentials>("desktop.account-credentials");
  const cloudAccountsToken = createIdentifier<CloudAccountController>("desktop.cloud-accounts");
  const quarkLoginToken = createIdentifier<QuarkLoginController>("desktop.quark-login");
  const downloadRootsToken = createIdentifier<DownloadRootController>("desktop.download-roots");
  const developmentUrl = !app.isPackaged
    ? process.env.ELECTRON_RENDERER_URL
    : undefined;
  let window: BrowserWindow | undefined;
  let tray: Tray | undefined;
  let exiting = false;
  let maintenance = false;
  let nativePauses: NativePauseControls | undefined;
  let refreshNativePauses: (() => void) | undefined;
  let rendererReload: RendererReloadController | undefined;
  let reloadFlight: Promise<void> | undefined;
  const requestReload = (ignoreCache = false) => {
    if (reloadFlight || !rendererReload || exiting || maintenance || window?.webContents.isLoadingMainFrame()) return;
    reloadFlight = rendererReload.request(ignoreCache).catch((error) => {
      if (!exiting && !maintenance && window && !window.isDestroyed()) dialog.showErrorBox("界面未重载", error instanceof DesktopError ? error.message : "界面重载未完成，请退出客户端后重新打开");
    }).finally(() => { reloadFlight = undefined; });
  };
  const backups = new ManagedUpgradeBackups(app.getPath("userData"));
  const hostPreferences = new HostPreferencesController(join(app.getPath("userData"), "host-preferences.json"), {
    supported: process.platform === "darwin" && app.isPackaged,
    get: () => { const value = app.getLoginItemSettings(); return { openAtLogin: value.openAtLogin, status: value.status }; },
    set: (openAtLogin) => app.setLoginItemSettings({ openAtLogin }), trayAvailable: () => !!tray && !tray.isDestroyed(),
  });
  await hostPreferences.get().catch(() => {});
  const about = new DesktopAboutController({ appRoot: app.getAppPath(), resourcesRoot: process.resourcesPath, packaged: app.isPackaged, target: `${process.platform}-${process.arch}`, appVersion: app.getVersion(), electronVersion: process.versions.electron });
  const parserLaunch = async () => {
    const target = `${process.platform}-${process.arch}`, directory = app.isPackaged ? join(app.getAppPath(), "resources/parser") : join(app.getAppPath(), "resources/parser", target);
    try { const data = await readFile(join(directory, "manifest.json")); if (data.length > 1024 * 1024) return undefined; return parserLaunchSchema.parse({ root: app.isPackaged ? join(process.resourcesPath, "parser") : join(directory, "runtime"), manifest: JSON.parse(data.toString("utf8")) }); }
    catch { return undefined; }
  };
  const nativeFiles = () => nativeFilesLaunch(app.getAppPath(), process.resourcesPath, app.isPackaged);
  const runtimeVersion = async (): Promise<RuntimeVersion> => {
    const target = `${process.platform}-${process.arch}`, root = app.isPackaged ? join(app.getAppPath(), "resources/sidecars") : join(app.getAppPath(), "resources/sidecars", target);
    try {
      const [manifest, guardian] = await Promise.all([readFile(join(root, "manifest.json"), "utf8"), readFile(join(root, "guardian.json"), "utf8")]);
      const resource = JSON.parse(manifest), guard = JSON.parse(guardian);
      const parser = await parserLaunch(), files = await nativeFiles();
      return { appVersion: app.getVersion(), schemaVersion: CORE_DATA_SCHEMA_VERSION, target, components: { ...(files ? { nativeFiles: files.manifestSha256 } : {}), openlist: resource.components.openlist.binary.sha256, rclone: resource.components.rclone.binary.sha256, guardian: guard.binary.sha256, ...(parser ? { parser: createHash("sha256").update(JSON.stringify(parser.manifest)).digest("hex") } : {}) } };
    } catch (error) {
      if (app.isPackaged || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return { appVersion: app.getVersion(), schemaVersion: CORE_DATA_SCHEMA_VERSION, target, components: {} };
    }
  };
  let closing = false;
  let didExplainClose = false;
  const grants = new Map<string, Set<"source" | "target">>();
  const rememberGrant = (path: string, purpose: "source" | "target") => { const purposes = grants.get(path) ?? new Set<"source" | "target">(); purposes.add(purpose); grants.set(path, purposes); };
  const show = () => {
    if (window && !window.isDestroyed()) {
      windowPresentation.show(window);
    }
  };
  const showWindow = async () => {
    if (exiting) return;
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
      ...windowPresentation.windowOptions,
      title: "Media Marshal",
      backgroundColor: "#f7f8fa",
      webPreferences: {
        ...windowPresentation.webPreferences,
        preload: join(__dirname, "../preload/index.js"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    rendererReload = new RendererReloadController(window.webContents, ipcMain, () => !exiting && !maintenance, developmentUrl);
    window.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.isComposing || input.alt) return;
      if (input.key === "F5" || (input.code === "KeyR" && (process.platform === "darwin" ? input.meta : input.control))) {
        event.preventDefault(); if (!input.isAutoRepeat) requestReload(input.shift || (input.key === "F5" && input.control));
      }
    });
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
      if (!didExplainClose && hostPreferences.remindOnClose) {
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
      rendererReload?.dispose(); rendererReload = undefined;
      window = undefined;
      grants.clear();
    });
    window.webContents.on("did-start-navigation", (event) => { if (event.isMainFrame && !event.isSameDocument) grants.clear(); });
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
          nativeFiles,
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
      const quarkLogin = new QuarkLoginController((input) => accounts.authorize(input), (requestKey) => supervisor.request("cloud.authorizations.get", { requestKey }));
      ctx.container.bind(quarkLoginToken).toConstantValue(quarkLogin);
      ctx.container.bind(downloadRootsToken).toConstantValue(roots);
      let recovering: Promise<void> | undefined, recoverAgain = false;
      const recover = (fresh = false): Promise<void> => {
        if (recovering) { if (fresh) recoverAgain = true; return recovering; }
        return recovering = (async () => {
        if (exiting || supervisor.state !== "ready") return;
        await roots.restore();
        for (const previous of await supervisor.requestPrivate("configuration.bootstrap", {})) {
          try { const path = await roots.validateDirectory(previous.grant.path), grant = await (previous.kind === "ordinary" ? probeReadOnlyVolume(path, previous.grant.id) : probeManagedVolume(path, previous.grant.id)); await supervisor.requestPrivate("configuration.authorize", { kind: previous.kind, grant }); }
          catch { /* 保留原目录身份和不可用状态，等待用户恢复原磁盘。 */ }
        }
        for (const previous of await supervisor.requestPrivate("media.targets.bootstrap", {})) {
          try { const target = await probeManagedVolume(await roots.validateDirectory(previous.path), previous.id); await supervisor.requestPrivate("media.targets.authorize", target); }
          catch { /* 每个媒体目标独立恢复；单个目标缺盘不阻断同下载根的其他策略。 */ }
        }
        for (const previous of await supervisor.requestPrivate("media.library.bootstrap", {})) {
          try { const target = await probeManagedVolume(await roots.validateDirectory(previous.target.path), previous.target.id); await supervisor.requestPrivate("media.library.authorize", { mediaType: previous.mediaType, target }); }
          catch { /* 缺盘保持目标不可用，不能给同名替代卷重新授权。 */ }
        }
        for (const previous of await supervisor.requestPrivate("media.sources.bootstrap", {})) {
          try {
            const source = await probeReadOnlyVolume(await roots.validateDirectory(previous.source.path), previous.source.id);
            if (previous.mode === "managed") { await supervisor.requestPrivate("media.sources.authorize-managed", { sourceId: previous.sourceId, sourceVersion: previous.sourceVersion, source }); continue; }
            const target = await probeManagedVolume(await roots.validateDirectory(previous.target.path), previous.target.id);
            await supervisor.requestPrivate("media.sources.authorize", { ...previous, source, target });
          } catch { /* 原卷或授权未恢复时保持未验证，不重新绑定相同路径的新硬盘。 */ }
        }
        await supervisor.requestPrivate("recognition.restore", {});
        if (await backups.reconciliationNeeded()) { await supervisor.requestPrivate("desktop.state.reconcile-restored", {}); await backups.acknowledgeReconciliation(); }
        await accounts.restore();
        await supervisor.requestPrivate("cloud.runtime.wake", { hostGeneration: ctx.get(sidecarToken).generation });
        })().finally(() => {
          recovering = undefined;
          // 唤醒时目录可能刚恢复；不能把这次新探测合并进先前看到缺盘的恢复轮次。
          if (recoverAgain) { recoverAgain = false; void recover().catch(() => {}); }
        });
      };
      supervisor.onReady = async () => {
        // ready 已证明 Core 完成数据库迁移；服务或账号恢复失败不能留下旧 Schema 元数据。
        await backups.recordVersion(await runtimeVersion());
        const vault = ctx.get(credentialToken);
        await installServiceCredentials(supervisor, vault);
        await recover();
        refreshNativePauses?.();
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
      const resume = () => {
        if (exiting || supervisor.state !== "ready") return;
        void ctx.effects.run(async () => {
          await supervisor.requestPrivate("media.observations.reset", {});
          if (!exiting && !ctx.signal.aborted) await recover(true);
        }, "唤醒后恢复媒体观察").catch(() => {});
      };
      powerMonitor.on("resume", resume);
      ctx.disposables.add(() => { powerMonitor.removeListener("resume", resume); });
      ctx.disposables.add(() => accounts.stop());
      ctx.disposables.add(() => quarkLogin.stop());
      ctx.disposables.add(() => supervisor.stop());
      // 首次、显式及自动重启共用同一栅栏；备份失败不能通过“重启核心”绕过。
      supervisor.beforeStart = async () => {
        nativePauses?.invalidate();
        await backups.recover();
        if (exiting || ctx.signal.aborted) throw new DesktopError("INTERRUPTED", "客户端正在停止", true);
        const version = await runtimeVersion(), previous = await backups.previousVersion();
        if ((previous && JSON.stringify(previous) !== JSON.stringify(version)) || (!previous && await backups.hasDatabase())) {
          host.retainForBackup(); await host.prepareOfflineBackup(); await ctx.get(credentialToken).drain();
          await backups.capture(previous ?? { ...version, appVersion: "legacy", schemaVersion: 0, components: {} }); await host.releaseBackupState();
        }
        if (exiting || ctx.signal.aborted) throw new DesktopError("INTERRUPTED", "客户端正在停止", true);
        await backups.markCoreStarting();
      };
      // 启动受跟踪但不阻挡窗口，失败由状态页提供重试入口。
      void ctx.effects.run(
        async () => {
          try {
            if (exiting || ctx.signal.aborted) return;
            await supervisor.start();
          } catch { if (!exiting && !ctx.signal.aborted) { supervisor.state = "failed"; supervisor.detail = "启动或升级检查失败。请使用应用菜单恢复匹配备份，或检查安装包。"; } }
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
            if (action === "desktop.cloud.login") return { ok: true, result: await ctx.get(quarkLoginToken).login(nativeActions["desktop.cloud.login"].parse(parsed.data), window!) };
            if (action === "desktop.cloud.cancel-login") { ctx.get(quarkLoginToken).cancel(nativeActions["desktop.cloud.cancel-login"].parse(parsed.data).requestKey); return { ok: true, result: null }; }
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
                rememberGrant(canonical, purpose);
                return { ok: true, result: canonical };
              }
              return { ok: true, result: null };
            }
            if (action === "desktop.configuration.choose-directory") {
              const { kind } = nativeActions["desktop.configuration.choose-directory"].parse(parsed.data);
              const selected = await dialog.showOpenDialog(window!, { title: kind === "managed" ? "选择本地下载目录" : kind === "media" ? "选择识别映射媒体目标" : "选择本机输入目录", properties: ["openDirectory", "createDirectory"] });
              if (selected.canceled || !selected.filePaths[0]) return { ok: true, result: null };
              const controller = ctx.get(downloadRootsToken), path = await controller.validateDirectory(selected.filePaths[0]);
              const known = (await supervisor.request("configuration.directories", {})).find((row) => row.path === path);
              const managed = (await supervisor.request("cloud.roots.list", {})).find((row) => row.path === path);
              if (kind === "media" && (managed || known?.kind === "managed")) throw new DesktopError("UNSAFE_PATH", "受管下载根不能同时作为媒体目标，请选择独立媒体目录");
              if (kind === "managed" || managed || known?.kind === "managed") {
                const root = await controller.choose(path), grant = (await supervisor.requestPrivate("cloud.roots.bootstrap", {})).find((row) => row.id === root.id)!;
                await supervisor.requestPrivate("configuration.authorize", { kind: "managed", grant });
                return { ok: true, result: (await supervisor.request("configuration.directories", {})).find((row) => row.id === root.id)! };
              }
              const previousTarget = kind === "media" ? await supervisor.requestPrivate("media.targets.find", { path }) : null;
              const grant = await (kind === "media" ? probeManagedVolume(path, known?.id ?? previousTarget?.id) : probeReadOnlyVolume(path, known?.id));
              await supervisor.requestPrivate("configuration.authorize", { kind, grant });
              return { ok: true, result: (await supervisor.request("configuration.directories", {})).find((row) => row.id === grant.id)! };
            }
            if (action === "desktop.credentials.save") {
              const { kind, value } = parsed.data as {
                kind: "tmdb" | "emby";
                value: string;
              };
              await vault.save(kind, value);
              await installServiceCredentials(supervisor, vault);
              return { ok: true, result: null };
            }
            if (action === "desktop.ingestion.configure") throw new DesktopError("CONFLICT", "整理绑定已并入来源配置，请重新预览确认");
            if (action === "desktop.media.choose-target") {
              const { mediaType } = nativeActions["desktop.media.choose-target"].parse(parsed.data);
              const selected = await dialog.showOpenDialog(window!, { title: mediaType === "MOVIE" ? "选择电影媒体库目录" : "选择剧集媒体库目录", properties: ["openDirectory"] });
              if (!selected.canceled && selected.filePaths[0]) {
                const path = await ctx.get(downloadRootsToken).validateDirectory(selected.filePaths[0]);
                const known = (await supervisor.requestPrivate("media.sources.bootstrap", {})).map((row) => row.target).concat((await supervisor.requestPrivate("media.library.bootstrap", {})).map((row) => row.target));
                const target = await probeManagedVolume(path, known.find((row) => row.path === path)?.id);
                await supervisor.requestPrivate("media.library.authorize", { mediaType, target }); rememberGrant(path, "target");
              }
              return { ok: true, result: await supervisor.request("media.libraries", {}) };
            }
            if (action === "desktop.emby.open") {
              const { taskId } = nativeActions["desktop.emby.open"].parse(parsed.data), address = await supervisor.requestPrivate("media.emby.open-url", { taskId });
              const saved = await supervisor.request("settings.get", {}), url = requireEmbyItemUrl(address, saved.embyUrl);
              await shell.openExternal(url.href); return { ok: true, result: null };
            }
            if (action === "desktop.host-preferences.get") return { ok: true, result: await hostPreferences.get() };
            if (action === "desktop.host-preferences.save") { if (maintenance || exiting) throw new DesktopError("INTERRUPTED", "客户端正在停止，运行设置未应用"); const previousReminder = hostPreferences.remindOnClose, result = await hostPreferences.save(nativeActions["desktop.host-preferences.save"].parse(parsed.data)); if (result.remindOnClose !== previousReminder) didExplainClose = false; return { ok: true, result }; }
            if (action === "desktop.about") return { ok: true, result: await about.get() };
            if (action === "desktop.license") return { ok: true, result: await about.license(nativeActions["desktop.license"].parse(parsed.data).id) };
            if (action === "desktop.settings")
              return {
                ok: true,
                result: {
                  ...(await supervisor.request("settings.get", {})),
                  ...(await vault.configured()),
                },
              };
            if (action === "desktop.restart-core") {
              nativePauses?.invalidate();
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
          if (["sources.save", "sources.pause", "cloud.subscriptions.configure", "cloud.subscriptions.control", "cloud.downloads.preview", "cloud.downloads.confirm"].includes(request.action)) throw new DesktopError("CONFLICT", "该配置入口已并入来源配置，请重新预览确认或使用来源控制");
          if (request.action === "source-rules.apply") {
            const input = coreActions["source-rules.apply"].input.parse(request.payload);
            const preview = await supervisor.request("source-rules.get-preview", { id: input.previewId });
            if (!preview) throw new DesktopError("CONFLICT", "来源预览已不存在，请重新预览");
            if (preview.state === "APPLIED") return { ok: true, result: await supervisor.requestPrivate("source-rules.apply", input) };
            const rule = await supervisor.request("source-rules.get", { id: preview.sourceId });
            if (!rule) throw new DesktopError("CONFLICT", "来源配置已不存在");
            const configuration = preview.configuration;
            if (!configuration.organization) return { ok: true, result: await supervisor.requestPrivate("source-rules.apply", input) };
            const authorizations = await supervisor.requestPrivate("media.sources.bootstrap", {});
            const previous = authorizations.find((row) => row.sourceId === (rule.localSourceId ?? rule.ingestionSourceId));
            const targetPath = await realpath(configuration.organization.targetPath);
            const knownTarget = await supervisor.requestPrivate("media.targets.find", { path: targetPath });
            if (!grants.get(targetPath)?.has("target") && !knownTarget) throw new DesktopError("FORBIDDEN", "请通过系统对话框选择媒体目标目录");
            const policy = ctx.get(downloadRootsToken);
            const target = await probeManagedVolume(await policy.validateDirectory(targetPath), knownTarget?.id);
            let source;
            if (configuration.type === "local") {
              const sourcePath = await realpath(configuration.sourcePath);
              if (!grants.get(sourcePath)?.has("source") && previous?.source.path !== sourcePath) throw new DesktopError("FORBIDDEN", "请通过系统对话框选择本地来源目录");
              source = await probeReadOnlyVolume(await policy.validateDirectory(sourcePath), previous?.source.path === sourcePath ? previous.source.id : undefined);
            } else {
              source = (await supervisor.requestPrivate("cloud.roots.bootstrap", {})).find((row) => row.id === configuration.downloadRootId);
              if (!source) throw new DesktopError("CONFLICT", "请先授权本地下载目录");
            }
            return { ok: true, result: await supervisor.requestPrivate("source-rules.apply", { ...input, grants: { source, target } }) };
          }
          if (request.action === "ingestion.set-paused" || request.action === "cloud.downloads.set-paused") {
            nativePauses?.invalidate();
            try { return { ok: true, result: await supervisor.request(request.action, request.payload as never) }; }
            finally { refreshNativePauses?.(); }
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
        rendererReload?.dispose();
        tray?.destroy();
        if (window && !window.isDestroyed()) window.destroy();
      });
      await showWindow();
      if (exiting || ctx.signal.aborted) return;
      tray = new Tray(trayIcon());
      tray.setToolTip("Media Marshal");
      const supervisor = ctx.get(coreToken), labels = { organize: "暂停全部整理", downloads: "暂停云端下载" };
      const schedule = (task: () => Promise<void>) => { if (!exiting && !maintenance && !ctx.signal.aborted) void ctx.effects.run(task, "核对或保存原生暂停控制").catch(() => {}); };
      const report = (kind: PauseKind, message?: string) => { const problem = message ?? nativePauses?.view[kind].problem; if (problem && !exiting && !maintenance) dialog.showErrorBox(`${kind === "organize" ? "整理" : "云端下载"}控制问题`, problem); };
      const pauseEntries = (): MenuItemConstructorOptions[] => [
        ...(["organize", "downloads"] as const).map(kind => ({ id: `desktop.pause.${kind}`, label: labels[kind] + "（状态未核对）", type: "checkbox" as const, checked: false, enabled: false, click: (item: Electron.MenuItem) => { const paused = item.checked; schedule(() => nativePauses!.set(kind, paused)); } })),
        { id: "desktop.pause.status", label: "正在核对暂停状态", enabled: false },
        { id: "desktop.pause.refresh", label: "重新核对暂停状态", click: () => refreshNativePauses?.() },
        ...(["organize", "downloads"] as const).map(kind => ({ id: `desktop.pause.problem.${kind}`, label: `查看上次${kind === "organize" ? "整理" : "云端下载"}控制问题…`, visible: false, click: () => report(kind) })),
      ];
      const trayMenu = Menu.buildFromTemplate([{ label: "打开 Media Marshal", click: show }, { type: "separator" }, ...pauseEntries(), { type: "separator" }, { label: "退出", click: () => app.quit() }]);
      tray.setContextMenu(trayMenu);
      tray.on("double-click", show);
      const applicationMenu = Menu.buildFromTemplate([
          {
            label: "Media Marshal",
            submenu: [
              { label: "显示主窗口", click: show },
              { label: "恢复升级备份…", click: () => { void performUpgrade(true).catch(() => {}); } },
              { role: "quit", label: "退出" },
            ],
          },
          { role: "editMenu", label: "编辑" },
          { id: "desktop.tasks", label: "任务", submenu: pauseEntries() },
          { label: "视图", submenu: [
            { id: "desktop.reload", label: "重新加载界面", accelerator: "CmdOrCtrl+R", click: () => requestReload() },
            { id: "desktop.reload-ignoring-cache", label: "忽略缓存并重新加载界面", accelerator: "CmdOrCtrl+Shift+R", click: () => requestReload(true) },
            { type: "separator" }, { role: "toggleDevTools", label: "开发者工具" },
            { type: "separator" }, { role: "resetZoom", label: "实际大小" }, { role: "zoomIn", label: "放大" }, { role: "zoomOut", label: "缩小" },
            { type: "separator" }, { role: "togglefullscreen", label: "切换全屏" },
          ] },
        ]);
      Menu.setApplicationMenu(applicationMenu);
      const menus = [trayMenu, applicationMenu];
      nativePauses = new NativePauseControls({
        ready: () => !exiting && !maintenance && !ctx.signal.aborted && supervisor.state === "ready",
        read: kind => kind === "organize" ? supervisor.request("ingestion.pause-status", {}) : supervisor.request("cloud.downloads.pause-status", {}),
        write: (kind, paused, requestKey) => kind === "organize" ? supervisor.request("ingestion.set-paused", { paused, requestKey }) : supervisor.request("cloud.downloads.set-paused", { paused, requestKey }),
        report,
        publish: view => {
          for (const menu of menus) {
            for (const kind of ["organize", "downloads"] as const) {
              const item = menu.getMenuItemById(`desktop.pause.${kind}`)!; item.label = labels[kind] + (view[kind].paused === null ? "（状态未核对）" : ""); item.checked = view[kind].paused === true; item.enabled = view[kind].enabled;
              menu.getMenuItemById(`desktop.pause.problem.${kind}`)!.visible = !!view[kind].problem;
            }
            const status = menu.getMenuItemById("desktop.pause.status")!; status.visible = !!view.status; status.label = view.status ?? "暂停状态已核对";
            menu.getMenuItemById("desktop.pause.refresh")!.enabled = !exiting && !maintenance && !ctx.signal.aborted;
          }
          if (process.platform === "linux" && tray && !tray.isDestroyed()) tray.setContextMenu(trayMenu);
        },
      });
      let pauseRefreshFlight: Promise<void> | undefined;
      refreshNativePauses = () => {
        if (pauseRefreshFlight || exiting || maintenance || ctx.signal.aborted) return;
        pauseRefreshFlight = ctx.effects.run(() => nativePauses!.refresh(), "核对原生暂停状态").catch(() => {}).finally(() => { pauseRefreshFlight = undefined; });
      };
      const openMenu = () => refreshNativePauses?.(), taskMenu = applicationMenu.getMenuItemById("desktop.tasks")!.submenu!;
      trayMenu.on("menu-will-show", openMenu); taskMenu.on("menu-will-show", openMenu);
      const pauseTimer = setInterval(openMenu, 10000);
      ctx.disposables.add(() => { clearInterval(pauseTimer); trayMenu.removeListener("menu-will-show", openMenu); taskMenu.removeListener("menu-will-show", openMenu); refreshNativePauses = undefined; nativePauses?.freeze(); });
      refreshNativePauses();
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
      const pick = await dialog.showMessageBox({ type: "question", title: "恢复升级备份", message: "选择与待运行客户端匹配的数据备份。下载文件和媒体库会保留。", buttons: [...choices.map((item) => `${item.appVersion} · ${item.schemaVersion ? `数据 v${item.schemaVersion}` : "数据版本待核对"} · ${new Date(item.createdAt).toLocaleString()}`), "取消"], cancelId: choices.length, defaultId: choices.length });
      chosen = choices[pick.response]?.id; if (!chosen) return;
      const confirm = await dialog.showMessageBox({ type: "question", title: "确认恢复并退出", message: "将先停写并备份当前数据，再恢复所选业务库、凭据密文与组件状态。", detail: "应用随后退出。安装匹配版本后再打开；恢复后会核对现存下载文件，不删除或覆盖媒体文件。", buttons: ["取消", "恢复并退出"], defaultId: 0, cancelId: 0 }); if (confirm.response !== 1) return;
    }
    if (!restore) {
      const confirm = await dialog.showMessageBox({ type: "question", title: "确认备份并退出", message: "将停止新接入，等待文件处理到达安全点，保存升级备份后退出应用。", detail: "下载文件和媒体库会保留；取消不会停止核心或创建备份。", buttons: ["取消", "备份并退出"], defaultId: 0, cancelId: 0 }); if (confirm.response !== 1) return;
    }
    if (maintenance || exiting) throw new DesktopError("CONFLICT", "客户端正在停止");
    maintenance = true;
    nativePauses?.freeze();
    try {
      await hostPreferences.stop();
      await desktop.container.get(quarkLoginToken).stop();
      const host = desktop.container.get(sidecarToken); host.retainForBackup();
      await desktop.container.get(cloudAccountsToken).stop(); await desktop.container.get(coreToken).stop(); await nativePauses?.stop(); await host.stop(); await host.prepareOfflineBackup(); await desktop.container.get(credentialToken).drain();
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
    nativePauses?.freeze();
    // 在框架 drain 前显式停止核心，避免已跟踪启动/任务阻止资源清理。
    void (async () => {
      try {
        // 扫码／账号作业可能正在等 Core；并发停接入与 Core，避免互相等待。
        await Promise.allSettled([
          hostPreferences.stop(),
          nativePauses?.stop(),
          Promise.resolve().then(() => desktop.container.isBound(quarkLoginToken) ? desktop.container.get(quarkLoginToken).stop() : undefined),
          Promise.resolve().then(() => desktop.container.isBound(cloudAccountsToken) ? desktop.container.get(cloudAccountsToken).stop() : undefined),
          Promise.resolve().then(() => desktop.container.isBound(coreToken) ? desktop.container.get(coreToken).stop() : undefined),
        ]);
      } finally {
        await desktop.stop().catch(() => {});
        app.quit();
      }
    })().catch(() => app.quit());
  });
  await desktop.start().catch(async () => {
    await desktop.stop().catch(() => {});
    if (exiting) return;
    dialog.showErrorBox(
      "客户端启动失败",
      "无法初始化客户端，请重新启动或检查安装包。",
    );
    exiting = true;
    app.quit();
  });
}
