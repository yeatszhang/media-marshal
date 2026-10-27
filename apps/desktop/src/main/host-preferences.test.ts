import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { HostPreferencesController } from "./host-preferences";
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(supported = true) {
  const root = await mkdtemp(join(tmpdir(), "marshal-host-prefs-")); cleanup.push(() => rm(root, { recursive: true, force: true })); const path = join(root, "host-preferences.json");
  let enabled = false, pending = false; const port = { supported, get: vi.fn(() => ({ openAtLogin: enabled, status: pending ? "requires-approval" as const : enabled ? "enabled" as const : "not-registered" as const })), set: vi.fn((value: boolean) => { enabled = value; }), trayAvailable: () => true };
  return { root, path, port, controller: new HostPreferencesController(path, port), enableExternally: () => { enabled = true; }, requireApproval: () => { pending = true; enabled = false; } };
}
describe("宿主运行偏好与系统登录项", () => {
  it("默认提醒且不注册登录项，外部系统变更只读展示，文件不保存登录项副本", async () => {
    const f = await fixture(); expect(await f.controller.get()).toMatchObject({ remindOnClose: true, openAtLogin: false, loginStatus: "not-registered" }); expect(f.port.set).not.toHaveBeenCalled();
    f.enableExternally(); expect(await f.controller.get()).toMatchObject({ openAtLogin: true, loginStatus: "enabled" }); await f.controller.save({ openAtLogin: true, remindOnClose: false }); expect(f.port.set).not.toHaveBeenCalled();
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual({ version: 1, remindOnClose: false }); expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    expect((await new HostPreferencesController(f.path, f.port).get()).remindOnClose).toBe(false); await rm(f.path); await f.controller.get(); expect(f.controller.remindOnClose).toBe(true);
  });
  it("开发或未支持平台拒绝注册，提醒可保存且不调用系统登录 API", async () => {
    const f = await fixture(false); await expect(f.controller.save({ openAtLogin: true, remindOnClose: false })).rejects.toMatchObject({ code: "UNSUPPORTED_CAPABILITY" });
    expect(await f.controller.save({ openAtLogin: false, remindOnClose: false })).toMatchObject({ loginSupported: false, loginStatus: "unsupported", remindOnClose: false }); expect(f.port.get).not.toHaveBeenCalled(); expect(f.port.set).not.toHaveBeenCalled();
  });
  it("系统待批准显示已申请而非已启用，重复保存不重新注册", async () => {
    const f = await fixture(); f.port.set.mockImplementation(() => f.requireApproval()); const first = await f.controller.save({ openAtLogin: true, remindOnClose: true }); expect(first).toMatchObject({ openAtLogin: true, loginStatus: "requires-approval" });
    await f.controller.save({ openAtLogin: true, remindOnClose: false }); expect(f.port.set).toHaveBeenCalledTimes(1);
  });
  it("真实落盘失败撤回本次登录项改变，不留下临时文件或虚假已保存状态", async () => {
    const f = await fixture();
    // 用目录占用偏好目标，实际原子发布失败；系统端口仍允许回退。
    await mkdir(f.path); const calls: boolean[] = [];
    let enabled = false; f.port.get.mockImplementation(() => ({ openAtLogin: enabled, status: enabled ? "enabled" : "not-registered" })); f.port.set.mockImplementation((value) => { enabled = value; calls.push(value); });
    await expect(f.controller.save({ openAtLogin: true, remindOnClose: false })).rejects.toThrow("原登录启动设置已保留"); expect(calls).toEqual([true, false]); expect(enabled).toBe(false); expect(f.controller.remindOnClose).toBe(true); expect((await (await import("node:fs/promises")).readdir(f.root)).sort()).toEqual(["host-preferences.json"]);
  });
  it("系统拒绝、未实际应用及损坏偏好可定位，不暴露系统原始异常", async () => {
    const f = await fixture(); f.port.set.mockImplementation(() => { throw new Error("私有系统路径"); }); await expect(f.controller.save({ openAtLogin: true, remindOnClose: false })).rejects.toThrow("登录启动未确认");
    f.port.set.mockImplementation(() => {}); await expect(f.controller.save({ openAtLogin: true, remindOnClose: false })).rejects.toMatchObject({ code: "CONFLICT" });
    await writeFile(f.path, "损坏偏好"); await expect(f.controller.get()).rejects.toThrow("本机运行偏好不可读取"); expect(await readFile(f.path, "utf8")).toBe("损坏偏好");
  });
  it("退出阻止尚未执行和迟到保存，不在停止后修改系统登录项", async () => {
    const f = await fixture(), pending = f.controller.save({ openAtLogin: true, remindOnClose: false }), stopped = f.controller.stop();
    await expect(pending).rejects.toMatchObject({ code: "INTERRUPTED" }); await stopped; await expect(f.controller.save({ openAtLogin: true, remindOnClose: true })).rejects.toMatchObject({ code: "INTERRUPTED" }); expect(f.port.set).not.toHaveBeenCalled(); await expect(stat(f.path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("并发显式保存按顺序应用，最终值及重开状态对应最后一次意图", async () => {
    const f = await fixture(); await Promise.all([f.controller.save({ openAtLogin: true, remindOnClose: false }), f.controller.save({ openAtLogin: false, remindOnClose: true })]);
    expect(f.port.set.mock.calls.map(([value]) => value)).toEqual([true, false]); expect(await new HostPreferencesController(f.path, f.port).get()).toMatchObject({ openAtLogin: false, remindOnClose: true });
  });
});
