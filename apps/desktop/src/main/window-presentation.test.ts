import { describe, expect, it, vi } from "vitest";
import { WindowPresentation } from "./window-presentation";

describe("桌面 E2E 呈现模式", () => {
  it("后台模式禁止主窗口和后续登录窗口的原生呈现与焦点请求", () => {
    const policy = new WindowPresentation("background"), app = { setActivationPolicy: vi.fn() };
    policy.prepare(app, "darwin");
    expect(app.setActivationPolicy).toHaveBeenCalledExactlyOnceWith("accessory");
    for (let index = 0; index < 2; index++) {
      const window = { show: vi.fn(), focus: vi.fn() };
      policy.show(window); policy.focus(window);
      expect(window.show).not.toHaveBeenCalled(); expect(window.focus).not.toHaveBeenCalled();
    }
    expect(policy.windowOptions).toEqual({ focusable: false, skipTaskbar: true });
    expect(policy.webPreferences.backgroundThrottling).toBe(false);
  });
  it.each(["foreground", undefined])("前台或普通启动 %s 保留真实呈现与焦点行为", (mode) => {
    const policy = new WindowPresentation(mode), app = { setActivationPolicy: vi.fn() }, window = { show: vi.fn(), focus: vi.fn() };
    policy.prepare(app, "darwin"); policy.show(window);
    expect(app.setActivationPolicy).not.toHaveBeenCalled();
    expect(window.show).toHaveBeenCalledTimes(1); expect(window.focus).toHaveBeenCalledTimes(1);
    expect(policy.windowOptions).toEqual({ focusable: true, skipTaskbar: false });
  });
  it("非 Mac 后台启动不调用 Mac 激活策略，非法模式明确报错", () => {
    const app = { setActivationPolicy: vi.fn() };
    new WindowPresentation("background").prepare(app, "win32");
    expect(app.setActivationPolicy).not.toHaveBeenCalled();
    expect(() => new WindowPresentation("silent")).toThrow(/仅支持/);
  });
});

it("后台未提供替身的原生 UI 与外部应用请求明确拒绝，前台保持原实现", async () => {
  const dialog = { showOpenDialog: vi.fn(), showSaveDialog: vi.fn(), showMessageBox: vi.fn(), showErrorBox: vi.fn() }, shell = { openExternal: vi.fn(), openPath: vi.fn() };
  const original = dialog.showMessageBox;
  new WindowPresentation("foreground").guardNativeUi(dialog, shell);
  expect(dialog.showMessageBox).toBe(original);
  new WindowPresentation("background").guardNativeUi(dialog, shell);
  await expect(dialog.showMessageBox({ message: "不可隐式确认" })).rejects.toThrow(/受控替身/);
  await expect(dialog.showOpenDialog({})).rejects.toThrow(/前台模式/);
  await expect(shell.openExternal("https://example.com")).rejects.toThrow(/外部应用/);
  expect(original).not.toHaveBeenCalled();
});
