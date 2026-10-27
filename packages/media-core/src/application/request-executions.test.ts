import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestExecutions } from "./request-executions";
afterEach(() => vi.useRealTimers());
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
describe("核心请求执行与等待边界", () => {
  it("执行超过期限及时结束等待，迟到成功仍只执行一次且 drain 等待真实完成", async () => {
    vi.useFakeTimers(); const owner = new RequestExecutions(), work = deferred<string>(), execute = vi.fn(() => work.promise);
    const response = expect(owner.run("原请求", execute)).rejects.toMatchObject({ code: "TIMEOUT" });
    await vi.advanceTimersByTimeAsync(14999); expect(execute).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); await response;
    let drained = false; const drain = owner.drain().then(() => { drained = true; }); await Promise.resolve(); expect(drained).toBe(false);
    await expect(owner.run("原请求", execute)).rejects.toMatchObject({ code: "CONFLICT" });
    work.resolve("持久作业已完成"); await drain; expect(execute).toHaveBeenCalledTimes(1); expect(drained).toBe(true);
  });
  it("取消等待不取消底层任务或其他请求，重复和未知取消无副作用，迟到失败被回收", async () => {
    const owner = new RequestExecutions(), first = deferred<void>(), second = deferred<string>(), response = expect(owner.run("A", () => first.promise)).rejects.toMatchObject({ code: "INTERRUPTED" }), other = owner.run("B", () => second.promise);
    owner.cancel("A", "INTERRUPTED"); owner.cancel("A", "TIMEOUT"); owner.cancel("未知", "INTERRUPTED"); await response;
    second.resolve("其他请求继续"); expect(await other).toBe("其他请求继续"); first.reject(new Error("迟到业务失败")); await owner.drain();
  });
  it("超时请求仍占用执行名额，不能循环超时产生无界后台操作", async () => {
    vi.useFakeTimers(); const owner = new RequestExecutions(10, 2), a = deferred<void>(), b = deferred<void>(), extra = vi.fn();
    const responses = [expect(owner.run("A", () => a.promise)).rejects.toMatchObject({ code: "TIMEOUT" }), expect(owner.run("B", () => b.promise)).rejects.toMatchObject({ code: "TIMEOUT" })];
    await vi.advanceTimersByTimeAsync(10); await Promise.all(responses); await expect(owner.run("C", extra)).rejects.toMatchObject({ code: "CONFLICT" }); expect(extra).not.toHaveBeenCalled();
    a.resolve(); b.resolve(); await owner.drain(); expect(await owner.run("C", () => "恢复名额")).toBe("恢复名额");
  });
  it("停止先中断等待并禁止新请求，底层异常与正常结束都完成清理", async () => {
    const owner = new RequestExecutions(), work = deferred<void>(), response = expect(owner.run("原请求", () => work.promise)).rejects.toMatchObject({ code: "INTERRUPTED" });
    owner.quiesce(); owner.quiesce(); await response; await expect(owner.run("新请求", () => {})).rejects.toMatchObject({ code: "INTERRUPTED" }); work.resolve(); await owner.drain();
    const other = new RequestExecutions(); await expect(other.run("错误", () => { throw new Error("业务错误"); })).rejects.toThrow("业务错误"); await other.drain();
  });
});
