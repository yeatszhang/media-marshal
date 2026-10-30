import type { App, BrowserWindow, Dialog, Shell } from "electron";

type PresentableWindow = Pick<BrowserWindow, "show" | "focus">;

/** E2E 后台模式仍创建真实窗口，仅关闭原生呈现与焦点请求。普通启动保持前台行为。 */
export class WindowPresentation {
  readonly background: boolean;
  constructor(mode?: string) {
    if (mode !== undefined && mode !== "background" && mode !== "foreground") throw new Error("MARSHAL_E2E_MODE 仅支持 background 或 foreground");
    this.background = mode === "background";
  }
  prepare(app: Pick<App, "setActivationPolicy">, platform = process.platform) {
    if (this.background && platform === "darwin") app.setActivationPolicy("accessory");
  }
  guardNativeUi(dialog: Pick<Dialog, "showOpenDialog" | "showSaveDialog" | "showMessageBox" | "showErrorBox">, shell: Pick<Shell, "openExternal" | "openPath">) {
    if (!this.background) return;
    const blocked = async () => { throw new Error("后台 E2E 不允许弹出原生界面或打开外部应用；请在用例中提供受控替身，或显式切换到前台模式"); };
    dialog.showOpenDialog = blocked as Dialog["showOpenDialog"];
    dialog.showSaveDialog = blocked as Dialog["showSaveDialog"];
    dialog.showMessageBox = blocked as Dialog["showMessageBox"];
    dialog.showErrorBox = (title, message) => { console.error(`[后台 E2E 原生错误] ${title}：${message}`); };
    shell.openExternal = blocked;
    shell.openPath = blocked;
  }
  get windowOptions() { return { focusable: !this.background, skipTaskbar: this.background }; }
  get webPreferences() { return { backgroundThrottling: !this.background }; }
  show(window: PresentableWindow) {
    if (this.background) return;
    window.show(); window.focus();
  }
  focus(window: Pick<BrowserWindow, "focus">) { if (!this.background) window.focus(); }
}

export const windowPresentation = new WindowPresentation(process.env.MARSHAL_E2E_MODE);
