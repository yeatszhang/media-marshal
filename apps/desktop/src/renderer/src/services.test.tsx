// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  ContainerProvider,
  useServiceState,
  useService,
} from "@yeatz/app-framework/react";
import type { DesktopApi, DesktopRuntime } from "@media-marshal/contracts";
import { createRendererApplication, RuntimeViewModel } from "./services";
import { App } from "./App";
import { i18nReady } from "./i18n";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});
describe("React createRoot 与框架状态", () => {
  it("核心离线提供显式恢复，重复点击只重启一次且旧轮询不能覆盖恢复结果", async () => {
    vi.useFakeTimers(); await i18nReady;
    const failed: DesktopRuntime = { appVersion: "test", protocolVersion: 1, core: "failed", detail: "核心已中断", status: null };
    const ready: DesktopRuntime = { ...failed, core: "ready", detail: null, status: { schemaVersion: 13, sourceCount: 0, taskCount: 0, mode: "manual-only", parser: "unavailable" } };
    let releaseRestart!: () => void, releaseOld!: (value: DesktopRuntime) => void;
    const api = { getRuntime: vi.fn(async () => failed), restartCore: vi.fn(() => new Promise<void>((resolve) => { releaseRestart = resolve; })), getSettings: vi.fn(async () => ({ language: "zh-CN", embyUrl: "", tmdbProxy: "", embyKeyConfigured: false, tmdbKeyConfigured: false })) };
    const application = createRendererApplication(api as unknown as DesktopApi); await application.start();
    const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
    try {
      await act(async () => root.render(<StrictMode><ContainerProvider value={application.container}><App /></ContainerProvider></StrictMode>));
      const retry = [...element.querySelectorAll("button")].find((button) => button.textContent === "重试")!; expect(retry).toBeTruthy();
      api.getRuntime.mockImplementationOnce(() => new Promise((resolve) => { releaseOld = resolve; }));
      await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
      await act(async () => { retry.click(); retry.click(); }); expect(api.restartCore).toHaveBeenCalledTimes(1);
      api.getRuntime.mockResolvedValue(ready);
      await act(async () => { releaseRestart(); await Promise.resolve(); });
      expect(element.textContent).toContain("核心已连接");
      await act(async () => { releaseOld(failed); }); expect(element.textContent).toContain("核心已连接"); expect(api.restartCore).toHaveBeenCalledTimes(1);
    } finally { await act(async () => root.unmount()); await application.stop(); }
  });
  it("StrictMode 重挂载只保留一条轮询，卸载释放轮询且不误停应用", async () => {
    vi.useFakeTimers();
    const getRuntime = vi.fn().mockResolvedValue({
      appVersion: "test",
      protocolVersion: 1,
      core: "ready",
      detail: null,
      status: {
        schemaVersion: 1,
        sourceCount: 0,
        taskCount: 0,
        mode: "manual-only",
        parser: "unavailable",
      },
    });
    const application = createRendererApplication({
      getRuntime,
    } as unknown as DesktopApi);
    await application.start();
    const element = document.createElement("div");
    document.body.append(element);
    const root = createRoot(element);
    function Probe() {
      const model = useService(RuntimeViewModel);
      const runtime = useServiceState(model, (state) => state.runtime);
      useEffect(() => model.watch(), [model]);
      return <span>{runtime?.core ?? "starting"}</span>;
    }
    await act(async () => {
      root.render(
        <StrictMode>
          <ContainerProvider value={application.container}>
            <Probe />
          </ContainerProvider>
        </StrictMode>,
      );
      await Promise.resolve();
    });
    expect(element.textContent).toBe("ready");
    expect(getRuntime).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(getRuntime).toHaveBeenCalledTimes(2);
    await act(async () => root.unmount());
    await vi.advanceTimersByTimeAsync(10000);
    expect(getRuntime).toHaveBeenCalledTimes(2);
    expect(application.state).toBe("running");
    await application.stop();
  });
});
