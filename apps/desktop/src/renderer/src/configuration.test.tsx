// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ContainerProvider } from "@yeatz/app-framework/react";
import type { CoreInput, CoreOutput, DesktopApi } from "@media-marshal/contracts";
import { createRendererApplication } from "./services";
import { DownloadDirectorySettings } from "./components/DownloadDirectorySettings";
import { ConfigurationViewModel } from "./configuration-model";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers(); document.body.innerHTML = ""; });
async function fixture() {
  vi.useFakeTimers(); const directory = { id: crypto.randomUUID(), version: 1, kind: "managed" as const, path: "/中文 空格/" + "长目录".repeat(30), available: true }; let defaults: CoreOutput<"configuration.default"> = { version: 0, directory: null };
  const api = { listConfigurationDirectories: vi.fn(async () => [directory]), getDefaultDownloadDirectory: vi.fn(async () => defaults), chooseConfigurationDirectory: vi.fn(async () => directory as typeof directory | null), setDefaultDownloadDirectory: vi.fn(async (input: CoreInput<"configuration.set-default">) => { defaults = { version: input.expectedVersion + 1, directory: input.directoryId ? { id: directory.id, version: 1, path: directory.path } : null }; return defaults; }) };
  const app = createRendererApplication(api as unknown as DesktopApi); await app.start(); const element = document.createElement("div"); document.body.append(element); const root = createRoot(element);
  await act(async () => root.render(<StrictMode><ContainerProvider value={app.container}><DownloadDirectorySettings /></ContainerProvider></StrictMode>));
  cleanup.push(async () => { await act(async () => root.unmount()); await app.stop(); });
  const button = (text: string) => [...element.querySelectorAll("button")].find((value) => value.textContent === text)!;
  return { api, app, element, directory, model: app.container.get(ConfigurationViewModel), button };
}
describe("默认目录选择、明确保存与持久读取", () => {
  it("应用停止后丢弃迟到查询，停止的视图不再读取或保存", async () => {
    const f = await fixture(); let release!: (value: CoreOutput<"configuration.default">) => void;
    f.api.getDefaultDownloadDirectory.mockImplementationOnce(() => new Promise((done) => { release = done; })); let pending!: Promise<void>;
    await act(async () => { pending = f.model.refresh(true); await Promise.resolve(); });
    await act(async () => { await f.app.stop(); release({ version: 3, directory: { id: f.directory.id, version: 1, path: f.directory.path } }); await pending; });
    expect(f.model.state.defaults?.version).toBe(0); const reads = f.api.getDefaultDownloadDirectory.mock.calls.length;
    await f.model.refresh(); expect(await f.model.saveDefault(f.directory.id)).toBe(false); expect(f.api.getDefaultDownloadDirectory).toHaveBeenCalledTimes(reads); expect(f.api.setDefaultDownloadDirectory).not.toHaveBeenCalled();
  });
  it("StrictMode 和轮询只查询，选择及取消不改默认；保存明确写入版本", async () => {
    const f = await fixture(); expect(f.api.getDefaultDownloadDirectory).toHaveBeenCalledTimes(1); expect(f.button("保存默认目录").disabled).toBe(true);
    f.api.chooseConfigurationDirectory.mockResolvedValueOnce(null); await act(async () => f.button("选择本地下载目录").click()); expect(f.api.setDefaultDownloadDirectory).not.toHaveBeenCalled();
    await act(async () => f.button("选择本地下载目录").click()); expect(f.element.textContent).toContain("有未保存"); expect(f.element.textContent).toContain(f.directory.path);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); expect(f.api.setDefaultDownloadDirectory).not.toHaveBeenCalled();
    await act(async () => f.button("保存默认目录").click()); expect(f.api.setDefaultDownloadDirectory).toHaveBeenCalledExactlyOnceWith({ expectedVersion: 0, directoryId: f.directory.id, requestKey: expect.any(String) }); expect(f.element.textContent).toContain("已有绑定和文件保持原位置");
    await act(async () => { await vi.advanceTimersByTimeAsync(6000); }); expect(f.api.setDefaultDownloadDirectory).toHaveBeenCalledTimes(1);
  });
  it("原卷错误保留原因，回执丢失使用同一请求重试，查询恢复不吞掉操作失败", async () => {
    const f = await fixture(); await act(async () => f.button("选择本地下载目录").click());
    f.api.setDefaultDownloadDirectory.mockRejectedValueOnce(new Error("原目录尚未恢复，请连接原磁盘"));
    await act(async () => f.button("保存默认目录").click()); const command = f.api.setDefaultDownloadDirectory.mock.calls[0];
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); }); expect(f.element.textContent).toContain("原目录尚未恢复");
    await act(async () => f.button("保存默认目录").click()); expect(f.api.setDefaultDownloadDirectory.mock.calls[1]).toEqual(command); expect(f.element.textContent).not.toContain("原目录尚未恢复");
  });
});
