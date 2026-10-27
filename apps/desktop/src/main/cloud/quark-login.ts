import { randomUUID } from "node:crypto";
import { BrowserWindow, session, type Session } from "electron";
import {
  DesktopError, cloudCredentialDraftSchema, cloudLoginDraftSchema,
  type CloudAuthorization, type CloudCredentialDraft, type CloudLoginDraft,
} from "@media-marshal/contracts";

const LOGIN_URL = "https://pan.quark.cn/";
const LOGIN_TIMEOUT = 5 * 60 * 1000;

function isQuarkPage(address: string) {
  try {
    const url = new URL(address);
    return url.protocol === "https:" && !url.username && !url.password && !url.port &&
      (url.hostname === "quark.cn" || url.hostname.endsWith(".quark.cn"));
  } catch { return false; }
}

interface LoginAttempt {
  input: CloudLoginDraft;
  abort: AbortController;
  window?: BrowserWindow;
  promise: Promise<CloudAuthorization | null>;
}

/** 仅 Main 持有网页登录态，Renderer 只能启动、取消或查询业务授权结果。 */
export class QuarkLoginController {
  private active?: LoginAttempt;
  private stopped = false;

  constructor(
    private readonly authorize: (input: CloudCredentialDraft) => Promise<CloudAuthorization>,
    private readonly lookup: (requestKey: string) => Promise<CloudAuthorization | null>,
  ) {}

  login(value: CloudLoginDraft, parent: BrowserWindow): Promise<CloudAuthorization | null> {
    const input = cloudLoginDraftSchema.parse(value);
    if (this.stopped || parent.isDestroyed()) return Promise.reject(new DesktopError("INTERRUPTED", "登录已中断，请重试。"));
    if (this.active) {
      if (JSON.stringify(this.active.input) !== JSON.stringify(input))
        return Promise.reject(new DesktopError("CONFLICT", "请先完成或取消当前夸克登录。"));
      if (this.active.window && !this.active.window.isDestroyed()) this.active.window.focus();
      return this.active.promise;
    }
    const attempt: LoginAttempt = { input, abort: new AbortController(), promise: Promise.resolve(null) };
    this.active = attempt;
    attempt.promise = this.run(attempt, parent).finally(() => { if (this.active === attempt) this.active = undefined; });
    return attempt.promise;
  }

  cancel(requestKey: string) {
    if (this.active?.input.requestKey === requestKey) this.active.abort.abort();
  }

  async stop() {
    this.stopped = true;
    this.active?.abort.abort();
    await this.active?.promise.catch(() => {});
  }

  private async run(attempt: LoginAttempt, parent: BrowserWindow) {
    // 重复 IPC 或页面重载不重新打开已提交的授权，也不再次轮换凭据。
    const previous = await this.lookup(attempt.input.requestKey);
    if (attempt.abort.signal.aborted || parent.isDestroyed()) return null;
    if (previous) return previous;
    let cookie = await this.capture(attempt, parent);
    try {
      if (!cookie || attempt.abort.signal.aborted) return null;
      return await this.authorize(cloudCredentialDraftSchema.parse({ ...attempt.input, cookie }));
    } finally { cookie = null; }
  }

  private async capture(attempt: LoginAttempt, parent: BrowserWindow): Promise<string | null> {
    const isolated = session.fromPartition(`quark-login-${randomUUID()}`, { cache: false });
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    isolated.setUserAgent(isolated.getUserAgent().replace(/\sElectron\/\S+/g, ""));
    const denyDownload = (event: Electron.Event) => event.preventDefault();
    isolated.on("will-download", denyDownload);
    let login: BrowserWindow | undefined;
    try {
      login = new BrowserWindow({
        width: 1000, height: 760, minWidth: 760, minHeight: 600,
        parent, show: false, title: "扫码连接夸克网盘", autoHideMenuBar: true,
        webPreferences: {
          session: isolated, sandbox: true, contextIsolation: true,
          nodeIntegration: false, webSecurity: true,
        },
      });
      attempt.window = login;
      return await this.waitForLogin(attempt, login, parent, isolated);
    } catch (error) {
      if (error instanceof DesktopError) throw error;
      throw new DesktopError("NETWORK_UNAVAILABLE", "夸克登录页面暂不可用，请重试或使用手动 Cookie 连接。", true);
    } finally {
      attempt.window = undefined;
      if (login && !login.isDestroyed()) login.destroy();
      isolated.removeListener("will-download", denyDownload);
      await Promise.allSettled([isolated.clearStorageData(), isolated.clearCache(), isolated.closeAllConnections()]);
    }
  }

  private waitForLogin(attempt: LoginAttempt, login: BrowserWindow, parent: BrowserWindow, isolated: Session): Promise<string | null> {
    const contents = login.webContents, parentContents = parent.webContents;
    return new Promise((resolve, reject) => {
      let finished = false, reading = false, readAgain = false;
      const finish = (cookie: string | null, error?: DesktopError) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        isolated.cookies.removeListener("changed", changed);
        attempt.abort.signal.removeEventListener("abort", cancel);
        parent.removeListener("hide", cancel);
        parentContents.removeListener("did-start-navigation", reload);
        login.removeListener("closed", cancel);
        contents.removeListener("render-process-gone", crashed);
        contents.removeListener("did-fail-load", failed);
        contents.removeListener("did-finish-load", check);
        if (error) reject(error); else resolve(cookie);
      };
      const cancel = () => finish(null);
      const reload = (_event: Electron.Event, _url: string, isInPlace: boolean, isMainFrame: boolean) => {
        if (isMainFrame && !isInPlace) cancel();
      };
      const crashed = () => finish(null, new DesktopError("INTERRUPTED", "夸克登录窗口已中断，请重试。"));
      const failed = (_event: Electron.Event, errorCode: number, _description: string, _url: string, isMainFrame: boolean) => {
        if (isMainFrame && errorCode !== -3) finish(null, new DesktopError("NETWORK_UNAVAILABLE", "夸克登录页面加载失败，请检查网络后重试。", true));
      };
      const check = async () => {
        if (finished) return;
        if (reading) { readAgain = true; return; }
        reading = true;
        readAgain = false;
        try {
          const cookies = await isolated.cookies.get({ url: LOGIN_URL });
          if (finished || !["__pus", "__puus"].every((name) => cookies.some((entry) => entry.name === name && entry.value))) return;
          // 只读取夸克目标地址的 Cookie，不触及默认会话或用户已有浏览器。
          const cookie = cookies.map((entry) => `${entry.name}=${entry.value}`).join("; ");
          if (!cloudCredentialDraftSchema.shape.cookie.safeParse(cookie).success)
            return finish(null, new DesktopError("AUTH_REQUIRED", "未能获取有效登录状态，请重新扫码。"));
          finish(cookie);
        } catch { finish(null, new DesktopError("AUTH_REQUIRED", "未能获取登录状态，请重新扫码。")); }
        finally { reading = false; if (readAgain && !finished) void check(); }
      };
      const changed = () => { void check(); };
      const timeout = setTimeout(() => finish(null, new DesktopError("TIMEOUT", "扫码登录已超时，请重新打开登录窗口。", true)), LOGIN_TIMEOUT);
      isolated.cookies.on("changed", changed);
      attempt.abort.signal.addEventListener("abort", cancel, { once: true });
      parent.on("hide", cancel);
      parentContents.on("did-start-navigation", reload);
      login.once("closed", cancel);
      contents.once("render-process-gone", crashed);
      contents.on("did-fail-load", failed);
      contents.on("did-finish-load", check);
      contents.setWindowOpenHandler(() => ({ action: "deny" }));
      const guard = (event: Electron.Event, address: string) => { if (!isQuarkPage(address)) event.preventDefault(); };
      contents.on("will-navigate", guard);
      contents.on("will-redirect", guard);
      contents.on("will-attach-webview", (event) => event.preventDefault());
      login.once("ready-to-show", () => { if (!finished && !login.isDestroyed()) { login.show(); login.focus(); } });
      if (attempt.abort.signal.aborted) return cancel();
      void login.loadURL(LOGIN_URL).catch(() => finish(null, new DesktopError("NETWORK_UNAVAILABLE", "夸克登录页面加载失败，请检查网络后重试。", true)));
    });
  }
}
