// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("electron", () => ({ ipcRenderer: { invoke: mocks.invoke } }));
import { invoke } from "./invoke";
import { RENDERER_LOG_PREFIX } from "../logging/shared";

it("UI 同步操作关联请求和业务 ID，后台请求不冒用点击，不采集敏感载荷", async () => {
  const outputs: string[] = [];
  const consoleLog = vi.spyOn(console, "info").mockImplementation((value) => {
    outputs.push(String(value));
  });
  const jobId = crypto.randomUUID();
  mocks.invoke.mockResolvedValue({ ok: true, result: { jobId, password: "结果秘密" } });
  let pending: Promise<unknown> | undefined;
  const button = document.createElement("button");
  document.body.append(button);
  button.onclick = () => {
    pending = invoke("sync.confirm", { password: "载荷秘密" });
  };
  try {
    button.click();
    await pending;
    await invoke("runtime.get", {});
    const records = outputs.map((line) => JSON.parse(line.slice(RENDERER_LOG_PREFIX.length)));
    expect(records[0].actionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(records[1]).toMatchObject({
      actionId: records[0].actionId,
      requestId: records[0].requestId,
      jobId,
    });
    expect(records[2].actionId).toBeUndefined();
    expect(records[2].level).toBe(20);
    expect(records[0].level).toBe(30);
    expect(records[2].requestId).not.toBe(records[0].requestId);
    expect(outputs.join("\n")).not.toContain("秘密");
    expect(mocks.invoke.mock.calls[0][1]).not.toHaveProperty("actionId");
  } finally {
    button.remove();
    consoleLog.mockRestore();
  }
});
