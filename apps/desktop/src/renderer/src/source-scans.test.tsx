// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ContainerProvider } from "@yeatz/app-framework/react";
import { MemoryRouter } from "react-router-dom";
import { sourceConfigurationSchema, type DesktopApi, type SourceRule, type SourceScan } from "@media-marshal/contracts";
import { createRendererApplication } from "./services";
import { SourceScansViewModel } from "./source-scans-model";
import { SourceScansPanel } from "./components/SourceScansPanel";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); document.body.innerHTML = ""; vi.useRealTimers(); });
async function mount() {
  vi.useFakeTimers(); const sourceId = crypto.randomUUID(), stamp = new Date().toISOString(), configuration = sourceConfigurationSchema.parse({ type: "local", name: "中文输入目录", sourcePath: "/输入", organization: { targetPath: "/媒体库" } });
  const source: SourceRule = { id: sourceId, type: "local", version: 1, draftRevision: 1, draft: configuration, configuration, paused: false, reviewRequired: false, localSourceId: sourceId, subscriptionId: null, ingestionSourceId: null, createdAt: stamp, updatedAt: stamp };
  let rows: SourceScan[] = []; const job = (): SourceScan => ({ id: crypto.randomUUID(), sourceId, sourceName: configuration.name, state: "RUNNING", discovered: 0, failed: 0, failure: null, createdAt: stamp, updatedAt: stamp });
  const api = { listIngestionScans: vi.fn(async () => ({ items: structuredClone(rows), total: rows.length })), scanIngestion: vi.fn(async (_id: string, _key: string) => { const row = job(); rows = [row, ...rows]; return row; }), getIngestionScan: vi.fn(async ({ id }: { id: string; page?: number }) => ({ job: rows.find((row) => row.id === id)!, total: 1, issues: [{ relativePath: "子目录/不可读.mp4", failure: "请检查原文件读取权限" }] })) };
  const app = createRendererApplication(api as unknown as DesktopApi); await app.start(); const model = app.container.get(SourceScansViewModel), element = document.createElement("div"); document.body.append(element); let root = createRoot(element), mounted = true;
  const render = () => act(async () => root.render(<StrictMode><MemoryRouter><ContainerProvider value={app.container}><SourceScansPanel sources={[source]} /></ContainerProvider></MemoryRouter></StrictMode>));
  const unmount = async () => { if (mounted) { mounted = false; await act(async () => root.unmount()); } }; const remount = async () => { await unmount(); root = createRoot(element); mounted = true; await render(); };
  await render(); cleanup.push(async () => { await unmount(); await app.stop(); }); return { api, app, model, element, source, job, unmount, remount, setRows(value: SourceScan[]) { rows = value; } };
}
const click = async (name: string) => { const button = [...document.querySelectorAll<HTMLButtonElement>("button")].find((value) => value.textContent?.trim() === name)!; expect(button).toBeTruthy(); await act(async () => button.click()); };
describe("持久目录扫描页面", () => {
  it("首次与 StrictMode 只查询，回执丢失保留同一请求键，轮询恢复同一作业且不显示虚构总量", async () => {
    const f = await mount(), row = f.job(); expect(f.api.scanIngestion).not.toHaveBeenCalled();
    f.api.scanIngestion.mockImplementationOnce(async () => { f.setRows([row]); throw new Error("扫描响应未收到，请先查询原扫描记录"); });
    await click("扫描目录 · 中文输入目录"); expect(f.element.textContent).toContain("扫描响应未收到"); await act(async () => { await vi.advanceTimersByTimeAsync(2000); }); expect(f.element.textContent).toContain(row.id); expect(f.element.textContent).toContain("完整枚举前数量尚未确定"); expect(f.element.querySelector("progress")).toBeNull();
    f.api.scanIngestion.mockResolvedValueOnce(row); await click("扫描目录 · 中文输入目录"); expect(f.api.scanIngestion.mock.calls[1]).toEqual(f.api.scanIngestion.mock.calls[0]);
    f.setRows([{ ...row, state: "PARTIAL_FAILED", discovered: 3, failed: 1, failure: "部分文件未能核对，请查看逐项问题" }]); await act(async () => f.model.refresh()); await click("查看扫描问题"); expect(f.element.textContent).toContain("子目录/不可读.mp4"); expect(f.element.textContent).toContain("读取权限"); expect(f.element.textContent).toContain("本次核对媒体项 3");
    await click("重新扫描"); expect(f.api.scanIngestion.mock.calls[2]![1]).not.toBe(f.api.scanIngestion.mock.calls[1]![1]);
  });
  it("离页停止轮询和忽略迟到查询，重挂载只读原作业，未停止共享 Application", async () => {
    const f = await mount(), row = { ...f.job(), state: "WAITING_SOURCE" as const, failure: "来源暂停，请恢复后继续" }; f.setRows([row]); await act(async () => f.model.refresh());
    let release!: (value: { items: SourceScan[]; total: number }) => void; f.api.listIngestionScans.mockImplementationOnce(() => new Promise((done) => { release = done; })); const flight = f.model.refresh(); await f.unmount(); const reads = f.api.listIngestionScans.mock.calls.length;
    await act(async () => { release({ items: [{ ...row, state: "FAILED", failure: "不应展示的旧读取" }], total: 1 }); await flight; await vi.advanceTimersByTimeAsync(10000); }); expect(f.api.listIngestionScans).toHaveBeenCalledTimes(reads); expect(f.model.state.items[0]?.state).toBe("WAITING_SOURCE"); expect(f.app.state).toBe("running");
    await f.remount(); expect(f.element.textContent).toContain(row.id); expect(f.element.textContent).toContain("来源暂停"); expect(f.api.scanIngestion).not.toHaveBeenCalled();
  });
  it("关闭逐项问题后旧请求不能重新展开；暂停时禁用新增补扫并说明恢复动作", async () => {
    const f = await mount(), row = { ...f.job(), state: "PARTIAL_FAILED" as const, failed: 1 }; f.setRows([row]); await act(async () => f.model.refresh()); await click("查看扫描问题");
    let release!: (value: Awaited<ReturnType<DesktopApi["getIngestionScan"]>>) => void; f.api.getIngestionScan.mockImplementationOnce(() => new Promise((done) => { release = done; })); const flight = f.model.refresh(); await click("收起扫描问题"); await act(async () => { release({ job: row, issues: [{ relativePath: "旧结果.mp4", failure: "旧错误" }], total: 1 }); await flight; }); expect(f.element.textContent).not.toContain("旧结果.mp4"); expect(f.model.state.detail).toBeNull();
    f.source.paused = true; await f.remount(); const start = [...f.element.querySelectorAll<HTMLButtonElement>("button")].find((value) => value.textContent?.includes("扫描目录 ·"))!; expect(start.disabled).toBe(true); expect(f.element.textContent).toContain("恢复或重新预览"); expect(f.api.scanIngestion).not.toHaveBeenCalled();
  });
});
