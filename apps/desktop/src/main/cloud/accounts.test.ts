import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { CloudError, type DriveCapabilities } from "@media-marshal/contracts";
import { CoreDatabase } from "../../../../../packages/media-core/src/infrastructure/database";
import { CloudAccounts } from "../../../../../packages/media-core/src/cloud/accounts";
import type { Credentials } from "../credentials";
import { AccountCredentials } from "./account-credentials";
import { CloudAccountController, type PrivateAccountCore } from "./accounts";

const capabilities: DriveCapabilities = { authorizationMethods: ["cookie"], accountIdentity: "unavailable", objectIdentity: "path", reliableRevision: false, hashAlgorithms: [], rangeRead: "unknown", sourceKinds: ["webdav"] };
const connections: CoreDatabase[] = [];
afterEach(() => { for (const db of connections.splice(0)) db.close(); });
async function fixture() {
  const db = await CoreDatabase.open(":memory:"); connections.push(db);
  const service = new CloudAccounts(db), requestPrivate = vi.fn(async (action: any, input: any) => service.dispatch(action, input));
  const values = new Map<string, string>();
  const vault = { saveAccount: vi.fn(async (key: string, value: string) => { values.set(key, value); }), readAccount: vi.fn(async (key: string) => values.get(key) ?? null), removeAccount: vi.fn(async (key: string) => { values.delete(key); }) } as unknown as Credentials;
  const host = { quiesceAccount: vi.fn(async () => {}), installCredential: vi.fn(async (_binding: unknown, secret: string) => { if (secret === "invalid-cookie") throw new CloudError("AUTH_REQUIRED"); return { stableKey: null, capabilities }; }), dropCredential: vi.fn(async () => {}) };
  const controller = new CloudAccountController({ requestPrivate } as PrivateAccountCore, new AccountCredentials(vault, host), vault);
  return { db, service, requestPrivate, values, vault, host, controller };
}
describe("Main 授权作业与凭据分流", () => {
  it("网络校验不阻塞稳定作业 ID，查询无 Cookie，重复请求不再次注入", async () => {
    const f = await fixture(); let finish!: () => void;
    f.host.installCredential.mockImplementationOnce(async () => { await new Promise<void>((resolve) => { finish = resolve; }); return { stableKey: null, capabilities }; });
    const input = { name: "夸克测试", cookie: "fixture-cookie-secret", requestKey: randomUUID() };
    const job = await f.controller.authorize(input); expect(job.state).toBe("RUNNING");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    expect((await f.controller.authorize(input)).id).toBe(job.id); expect(f.host.installCredential).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.requestPrivate.mock.calls)).not.toContain(input.cookie);
    finish(); await vi.waitFor(() => expect(f.service.authorization(input.requestKey)?.state).toBe("SUCCEEDED"));
    await f.controller.stop();
  });
  it("失效 Cookie 保留原业务绑定和密文，失败候选被清除且旧凭据可恢复", async () => {
    const f = await fixture(), first = { name: "测试", cookie: "good-cookie", requestKey: randomUUID() };
    const job = await f.controller.authorize(first);
    await vi.waitFor(() => expect(f.service.authorization(first.requestKey)?.state).toBe("SUCCEEDED"));
    const previous = f.service.dispatch("cloud.bootstrap", {})[0]!;
    const next = { name: "测试", accountId: job.accountId, cookie: "invalid-cookie", requestKey: randomUUID() };
    await f.controller.authorize(next);
    await vi.waitFor(() => expect(f.service.authorization(next.requestKey)?.state).toBe("FAILED"));
    await vi.waitFor(() => expect(f.host.installCredential).toHaveBeenLastCalledWith(previous.binding, "good-cookie"));
    expect(f.service.dispatch("cloud.bootstrap", {})).toEqual([previous]);
    expect([...f.values.values()]).toEqual(["good-cookie"]);
    await f.controller.stop();
  });
  it("重新启动从 Core 的活动引用注入，解除连接先回收并保留历史", async () => {
    const f = await fixture(), input = { name: "测试", cookie: "good-cookie", requestKey: randomUUID() };
    const job = await f.controller.authorize(input);
    await vi.waitFor(() => expect(f.service.authorization(input.requestKey)?.state).toBe("SUCCEEDED"));
    f.host.installCredential.mockClear(); await f.controller.restore(); expect(f.host.installCredential).toHaveBeenCalledTimes(1);
    await f.controller.disconnect(job.accountId);
    expect(f.host.dropCredential).toHaveBeenCalledWith(job.accountId); expect(f.values.size).toBe(0);
    expect(f.service.dispatch("cloud.bootstrap", {})).toEqual([]); expect(f.service.authorization(input.requestKey)?.state).toBe("SUCCEEDED");
    await f.controller.stop();
  });
});
