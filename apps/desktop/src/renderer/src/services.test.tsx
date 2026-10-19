// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import {
  ContainerProvider,
  useServiceState,
  useService,
} from "@yeatz/app-framework/react";
import type { DesktopApi } from "@media-marshal/contracts";
import { createRendererApplication, RuntimeViewModel } from "./services";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});
describe("React createRoot 与框架状态", () => {
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
