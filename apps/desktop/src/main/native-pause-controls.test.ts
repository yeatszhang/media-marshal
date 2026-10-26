import { describe, expect, it, vi } from "vitest";
import { DesktopError } from "@media-marshal/contracts";
import { NativePauseControls, type PauseKind } from "./native-pause-controls";

function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function fixture() {
  let ready = true;
  const values = { organize: false, downloads: false }, read = vi.fn(async (kind: PauseKind) => ({ paused: values[kind] })), write = vi.fn(async (kind: PauseKind, paused: boolean, _requestKey: string) => { values[kind] = paused; return { paused }; }), publish = vi.fn(), report = vi.fn();
  const controls = new NativePauseControls({ ready: () => ready, read, write, publish, report });
  return { controls, values, read, write, publish, report, ready: (value: boolean) => { ready = value; } };
}
describe("原生暂停控制", () => {
  it("初始未知状态禁用并解释，读取及重复刷新不替用户写入", async () => {
    const f = fixture(); f.values.organize = true;
    expect(f.controls.view.organize.enabled).toBe(false); expect(f.controls.view.status).toContain("尚未核对");
    await f.controls.set("organize", false); expect(f.write).not.toHaveBeenCalled();
    await f.controls.refresh(); expect(f.controls.view.organize).toMatchObject({ enabled: true, paused: true }); expect(f.controls.view.downloads).toMatchObject({ enabled: true, paused: false });
    await f.controls.refresh(); expect(f.write).not.toHaveBeenCalled(); expect(f.read).toHaveBeenCalledTimes(4);
  });
  it("每项只接受一个在途意图，两种暂停独立且恢复不解除另一项", async () => {
    const f = fixture(); await f.controls.refresh(); const gate = deferred<{ paused: boolean }>();
    f.write.mockImplementationOnce(async (kind, paused) => { await gate.promise; f.values[kind] = paused; return { paused }; });
    const organize = f.controls.set("organize", true); expect(f.controls.view.organize.busy).toBe(true);
    await f.controls.set("organize", false); await f.controls.set("downloads", true); expect(f.write).toHaveBeenCalledTimes(2);
    gate.resolve({ paused: true }); await organize; expect(f.values).toEqual({ organize: true, downloads: true });
    await f.controls.set("organize", false); expect(f.values).toEqual({ organize: false, downloads: true });
    const keys = f.write.mock.calls.map(call => call[2]); expect(new Set(keys).size).toBe(3); for (const key of keys) expect(key).toMatch(/^[a-f0-9-]{36}$/);
  });
  it("写入已提交但响应丢失时重新读取，不自动重试并保留具体控制问题", async () => {
    const f = fixture(); await f.controls.refresh();
    f.write.mockImplementationOnce(async (kind, paused) => { f.values[kind] = paused; throw new DesktopError("INTERRUPTED", "核心响应已中断"); });
    await f.controls.set("organize", true); expect(f.controls.view.organize).toMatchObject({ paused: true, enabled: true, problem: expect.stringContaining("核心响应已中断") });
    await f.controls.refresh(); expect(f.write).toHaveBeenCalledOnce(); expect(f.controls.view.organize.problem).toContain("设置未确认"); expect(f.report).toHaveBeenCalledOnce();
    await f.controls.set("organize", false); expect(f.controls.view.organize.problem).toBeNull(); expect(f.controls.view.downloads.paused).toBe(false);
  });
  it("未知写入和读取异常不泄露原始内容，两种原因有界保留且成功重查只清除读取问题", async () => {
    const f = fixture(); await f.controls.refresh(); const secret = "cookie=private-token-in-raw-error";
    f.write.mockRejectedValueOnce(new Error(secret)); f.read.mockImplementation(async kind => { if (kind === "organize") throw new Error(secret); return { paused: false }; });
    await f.controls.set("organize", true); expect(f.controls.view.organize.enabled).toBe(false); expect(f.controls.view.downloads.enabled).toBe(true);
    const failed = JSON.stringify({ view: f.controls.view, reports: f.report.mock.calls }); expect(failed).not.toContain(secret); expect(failed).toContain("原因尚未确认"); expect(failed).toContain("暂停状态未读取");
    f.read.mockImplementation(async kind => ({ paused: f.values[kind] })); await f.controls.refresh(); expect(f.controls.view.organize.enabled).toBe(true); expect(f.controls.view.organize.problem).toContain("设置未确认"); expect(f.controls.view.organize.problem).not.toContain("状态未读取"); expect(f.report).toHaveBeenCalledOnce();
  });
  it("并发刷新合并为一轮，核心代际改变丢弃旧结果并读取新状态", async () => {
    const f = fixture(), first = deferred<{ paused: boolean }>(), second = deferred<{ paused: boolean }>();
    f.read.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise);
    const reading = f.controls.refresh(); for (let i = 0; i < 100; i++) expect(f.controls.refresh()).toBe(reading); expect(f.read).toHaveBeenCalledTimes(2);
    f.controls.invalidate(); f.values.organize = true; first.resolve({ paused: false }); second.resolve({ paused: false }); await reading;
    expect(f.controls.view.organize.paused).toBe(true); expect(f.read).toHaveBeenCalledTimes(4); expect(f.write).not.toHaveBeenCalled();
  });
  it("旧只读结果不能覆盖点击后的确认，新读取在写入结束后完成", async () => {
    const f = fixture(); await f.controls.refresh(); const old = deferred<{ paused: boolean }>(); f.read.mockImplementationOnce(() => old.promise);
    const reading = f.controls.refresh(), writing = f.controls.set("organize", true); await Promise.resolve(); old.resolve({ paused: false }); await Promise.all([reading, writing]);
    expect(f.controls.view.organize.paused).toBe(true); expect(f.write).toHaveBeenCalledOnce();
  });
  it("核心重启期间旧写入成功不冒充新状态，恢复只读真实值", async () => {
    const f = fixture(); await f.controls.refresh(); const old = deferred<{ paused: boolean }>(); f.write.mockImplementationOnce(() => old.promise);
    const writing = f.controls.set("organize", true); f.ready(false); f.controls.invalidate(); await f.controls.refresh(); expect(f.controls.view.status).toContain("核心未就绪");
    f.ready(true); f.controls.invalidate(); old.resolve({ paused: true }); await writing; expect(f.controls.view.organize.paused).toBe(false); expect(f.write).toHaveBeenCalledOnce();
  });
  it("停止排空原读写等待，停止后的迟到失败不弹窗、不接新命令", async () => {
    const f = fixture(); await f.controls.refresh(); const gate = deferred<{ paused: boolean }>(), read = deferred<{ paused: boolean }>(); f.write.mockImplementationOnce(() => gate.promise);
    const writing = f.controls.set("organize", true); f.read.mockImplementationOnce(() => read.promise); const reading = f.controls.refresh(); let stopped = false; const stop = f.controls.stop().then(() => { stopped = true; });
    await Promise.resolve(); expect(stopped).toBe(false); await f.controls.set("downloads", true); await f.controls.refresh(); expect(f.write).toHaveBeenCalledOnce();
    gate.reject(new Error("private-late-error")); await writing; expect(stopped).toBe(false); read.resolve({ paused: false }); await Promise.all([reading, stop]);
    expect(stopped).toBe(true); expect(f.report).not.toHaveBeenCalled(); expect(f.controls.view.status).toContain("正在停止");
  });
  it("一侧读取失败显示具体原因，另一侧仍可控制；核心离线时不发送读取", async () => {
    const f = fixture(); f.read.mockImplementation(async kind => { if (kind === "organize") throw new DesktopError("STORAGE_ERROR", "业务库暂不可读取"); return { paused: true }; });
    await f.controls.refresh(); expect(f.controls.view.organize.problem).toContain("业务库暂不可读取"); expect(f.controls.view.downloads).toMatchObject({ enabled: true, paused: true });
    f.ready(false); f.read.mockClear(); await f.controls.refresh(); expect(f.read).not.toHaveBeenCalled(); expect(f.controls.view.downloads.enabled).toBe(false); expect(f.controls.view.status).toContain("打开主窗口");
  });
});
