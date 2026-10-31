// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { DesktopApi, DownloadCleanup } from "@media-marshal/contracts";
import { DownloadCleanupContent } from "./components/DownloadCleanupPanel";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const closers: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close(); sessionStorage.clear(); document.body.innerHTML = ""; });
function fixture() {
  const receiptId = crypto.randomUUID(), previewId = crypto.randomUUID(), id = crypto.randomUUID(), path = "/Volumes/隔离下载/completed/" + "中文长路径/".repeat(20) + "01.mp4";
  const row: DownloadCleanup = { kind: "SOURCE", id, receiptId, taskId: null, phase: "NEEDS_ATTENTION", resumePhase: "REMOVING", sourcePath: path, targetPath: "/媒体库/作品 - S01E01.mp4", size: 1024 ** 3, freedBytes: 0, waitingReason: null, failure: `${path}：原目标卷失联，请恢复原卷后重试此项清理`, updatedAt: new Date().toISOString() };
  const preview = { id: previewId, state: "READY" as const, items: [{ receiptId, sourcePath: path, targetPath: row.targetPath, size: row.size }], failure: null, expiresAt: Date.now() + 600000 };
  const client = {
    listDownloadCleanup: vi.fn<DesktopApi["listDownloadCleanup"]>().mockResolvedValue([row]), getDownloadCleanupScope: vi.fn<DesktopApi["getDownloadCleanupScope"]>().mockResolvedValue([{ receiptId, sourcePath: path, size: row.size }]),
    previewDownloadCleanup: vi.fn<DesktopApi["previewDownloadCleanup"]>().mockResolvedValue({ ...preview, state: "PREPARING", items: [] }), getDownloadCleanupPreview: vi.fn<DesktopApi["getDownloadCleanupPreview"]>().mockResolvedValue(preview),
    confirmDownloadCleanup: vi.fn<DesktopApi["confirmDownloadCleanup"]>().mockResolvedValue({}), cancelDownloadCleanupPreview: vi.fn<DesktopApi["cancelDownloadCleanupPreview"]>().mockResolvedValue({}), retryDownloadCleanup: vi.fn<DesktopApi["retryDownloadCleanup"]>().mockResolvedValue({}),
  };
  return { client, row, preview, receiptId, previewId, path };
}
async function mount(client: ReturnType<typeof fixture>["client"]) {
  const div = document.createElement("div"); document.body.appendChild(div); const root = createRoot(div); await act(async () => root.render(<StrictMode><DownloadCleanupContent client={client} /></StrictMode>));
  const close = async () => { await act(async () => root.unmount()); div.remove(); }; closers.push(close); return { div, close };
}
async function click(name: string) { const button = [...document.querySelectorAll("button")].find((item) => item.textContent === name); expect(button, name).toBeTruthy(); await act(async () => button!.click()); }
it("显示长路径、当前阶段、释放大小和持久错误，重试只提交业务 ID", async () => {
  const f = fixture(); await mount(f.client);
  expect(document.body.textContent).toContain(f.path); expect(document.body.textContent).toContain("原目标卷失联"); expect(document.body.textContent).toContain("已释放 0 B / 1.00 GiB");
  await click("重试此项清理"); expect(f.client.retryDownloadCleanup).toHaveBeenCalledExactlyOnceWith(f.row.id);
  expect(f.client.confirmDownloadCleanup).not.toHaveBeenCalled(); expect(f.client.previewDownloadCleanup).not.toHaveBeenCalled();
});
it("先选择范围再预览，重载只查询原预览，不自动确认或重复创建作业", async () => {
  const f = fixture(), view = await mount(f.client); await click("选择历史清理范围");
  const input = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!; await act(async () => input.click()); await click("预览所选清理范围");
  expect(f.client.previewDownloadCleanup).toHaveBeenCalledExactlyOnceWith({ receiptIds: [f.receiptId], requestKey: expect.any(String) });
  await view.close(); closers.pop(); await mount(f.client);
  expect(f.client.getDownloadCleanupPreview).toHaveBeenCalledWith(f.previewId); expect(f.client.previewDownloadCleanup).toHaveBeenCalledTimes(1); expect(f.client.confirmDownloadCleanup).not.toHaveBeenCalled();
  await click("确认清理上述下载副本"); expect(f.client.confirmDownloadCleanup).toHaveBeenCalledExactlyOnceWith(f.previewId);
});
it("取消预览不提交清理，确认失败展示对象与恢复动作且仍可查询原预览", async () => {
  const f = fixture(); sessionStorage.setItem("media-marshal.cleanup-preview.all", f.previewId); f.client.confirmDownloadCleanup.mockRejectedValue(new Error("媒体库副本的绑定已变化，请重新预览本范围")); await mount(f.client);
  await click("确认清理上述下载副本"); expect(document.querySelector('[role="alert"]')?.textContent).toContain("绑定已变化");
  await click("取消本次预览"); expect(f.client.cancelDownloadCleanupPreview).toHaveBeenCalledExactlyOnceWith(f.previewId); expect(sessionStorage.getItem("media-marshal.cleanup-preview.all")).toBeNull();
  expect(f.client.confirmDownloadCleanup).toHaveBeenCalledTimes(1);
});
