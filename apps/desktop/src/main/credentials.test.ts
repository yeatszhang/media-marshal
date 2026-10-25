import { afterEach, describe, expect, it, vi } from "vitest";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("electron", () => ({ safeStorage: {} }));
import { Credentials, type CredentialEncryption } from "./credentials";
import { AccountCredentials } from "./cloud/account-credentials";
import type { BindingRef } from "@media-marshal/contracts/internal";

const directories: string[] = [];
function encryption(): CredentialEncryption & { available: boolean } {
  const key = randomBytes(32);
  return {
    available: true,
    async isAsyncEncryptionAvailable() { return this.available; },
    async encryptStringAsync(value) {
      const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
      const payload = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), payload]);
    },
    async decryptStringAsync(value) {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      return { result: Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8"), shouldReEncrypt: false };
    },
  };
}
async function vault() {
  const directory = await mkdtemp(join(tmpdir(), "marshal-凭据 private-")); directories.push(directory);
  const path = join(directory, "credentials.json"); const crypto = encryption();
  return { directory, path, crypto, store: new Credentials(path, crypto) };
}
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
describe("账号级系统保护保险箱", () => {
  it("单个服务密文无法解密时保留原文，仍恢复另一可用服务并定位需要修复的对象", async () => {
    const f = await vault(); await f.store.save("emby", "fixture-valid-emby");
    const values = JSON.parse(await readFile(f.path, "utf8")); values.tmdb = Buffer.from("损坏的测试密文").toString("base64"); await writeFile(f.path, JSON.stringify(values));
    expect(await f.store.readServices()).toEqual({ values: { tmdb: null, emby: "fixture-valid-emby" }, unavailable: ["tmdb"] });
    expect(JSON.parse(await readFile(f.path, "utf8"))).toEqual(values);
    await f.store.save("tmdb", "fixture-repaired-tmdb"); expect((await f.store.readServices()).unavailable).toEqual([]);
  });
  it("服务凭据通过系统保护跨实例恢复，公开配置只有布尔状态，缺失时无需解密", async () => {
    const { store, path, crypto } = await vault();
    crypto.available = false; expect(await store.readService("tmdb")).toBeNull(); crypto.available = true;
    await Promise.all([store.save("tmdb", "fixture-tmdb-service-secret"), store.save("emby", "fixture-emby-service-secret")]);
    const restored = new Credentials(path, crypto);
    expect(await restored.readService("tmdb")).toBe("fixture-tmdb-service-secret"); expect(await restored.readService("emby")).toBe("fixture-emby-service-secret");
    expect(await restored.configured()).toEqual({ tmdbKeyConfigured: true, embyKeyConfigured: true });
    expect(await readFile(path, "utf8")).not.toContain("service-secret");
    await restored.save("tmdb", ""); expect(await restored.readService("tmdb")).toBeNull(); expect(await restored.readService("emby")).toBe("fixture-emby-service-secret");
  });
  it("加密能力不可用时不创建明文文件或调用加密降级", async () => {
    const { store, path, crypto } = await vault(); crypto.available = false;
    const encrypt = vi.spyOn(crypto, "encryptStringAsync");
    await expect(store.saveAccount(randomUUID(), "fixture-cookie-secret")).rejects.toMatchObject({ code: "STORAGE_ERROR", retryable: true });
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" }); expect(encrypt).not.toHaveBeenCalled();
  });
  it("并发账号写入、轮换和删除保持隔离，普通查询不返回秘密", async () => {
    const { store, path, directory } = await vault(); const first = randomUUID(), second = randomUUID();
    await Promise.all([store.saveAccount(first, "first-fixture-cookie"), store.saveAccount(second, "second-fixture-cookie")]);
    expect(await store.readAccount(first)).toBe("first-fixture-cookie");
    await store.saveAccount(first, "rotated-fixture-cookie");
    expect(await store.readAccount(second)).toBe("second-fixture-cookie");
    expect(await store.readAccount(first)).toBe("rotated-fixture-cookie");
    expect(await readFile(path, "utf8")).not.toMatch(/first-fixture|second-fixture|rotated-fixture/);
    expect(JSON.stringify(await store.configured())).not.toMatch(/fixture|cloud:|secret/);
    if (process.platform !== "win32") {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
    await store.removeAccount(first); expect(await store.readAccount(first)).toBeNull();
    expect(await store.readAccount(second)).toBe("second-fixture-cookie");
  }, 60000);
  it("密钥轮换的重新加密不覆盖并发保存的新凭据", async () => {
    const { store, crypto } = await vault(); const reference = randomUUID();
    await store.saveAccount(reference, "old-fixture-cookie");
    const original = crypto.decryptStringAsync.bind(crypto);
    let release!: () => void, entered!: () => void;
    const observed = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(crypto, "decryptStringAsync").mockImplementationOnce(async (value) => { const result = await original(value); entered(); await wait; return { ...result, shouldReEncrypt: true }; });
    const reading = store.readAccount(reference); await observed;
    await store.saveAccount(reference, "new-fixture-cookie"); release();
    expect(await reading).toBe("old-fixture-cookie");
    expect(await store.readAccount(reference)).toBe("new-fixture-cookie");
  }, 60000);
  it("拒绝符号链接保险箱且不改写链接目标", async () => {
    if (process.platform === "win32") return;
    const { store, path, directory } = await vault(); const outside = join(directory, "outside");
    await writeFile(outside, "marker"); await symlink(outside, path);
    await expect(store.saveAccount(randomUUID(), "fixture-cookie")).rejects.toMatchObject({ code: "STORAGE_ERROR" });
    expect(await readFile(outside, "utf8")).toBe("marker");
  });
});
describe("私有注入与账号生命周期顺序", () => {
  it("注入过程中刷新不会死锁，旧绑定刷新与覆盖活动引用均被拒绝", async () => {
    const { store } = await vault();
    let refresh!: (binding: BindingRef, secret: string) => Promise<void>;
    const host = { quiesceAccount: async () => {}, dropCredential: async () => {}, onCredentialRefresh(handler: typeof refresh) { refresh = handler; }, installCredential: async (binding: BindingRef, secret: string) => { await refresh(binding, secret + "-refreshed"); } };
    const manager = new AccountCredentials(store, host), reference = randomUUID();
    const binding = { accountId: randomUUID(), bindingId: randomUUID(), generation: randomUUID(), implementationId: "test.drive" };
    await manager.rotate(binding, reference, "first-cookie"); expect(await store.readAccount(reference)).toBe("first-cookie-refreshed");
    await expect(manager.rotate(binding, reference, "bad-cookie")).rejects.toMatchObject({ code: "CONFLICT" }); expect(await store.readAccount(reference)).toBe("first-cookie-refreshed");
    const replacement = { ...binding, bindingId: randomUUID(), generation: randomUUID() }, next = randomUUID();
    await manager.rotate(replacement, next, "second-cookie");
    await expect(refresh(binding, "stale-cookie")).rejects.toMatchObject({ code: "INTERRUPTED" }); expect(await store.readAccount(next)).toBe("second-cookie-refreshed");
  }, 60000);
  it("解除连接等待已开始的刷新落盘，之后不接受迟到刷新", async () => {
    const { store } = await vault(); let refresh!: (binding: BindingRef, secret: string) => Promise<void>;
    const host = { quiesceAccount: async () => {}, dropCredential: async () => {}, installCredential: async () => {}, onCredentialRefresh(handler: typeof refresh) { refresh = handler; } };
    const manager = new AccountCredentials(store, host), reference = randomUUID(), binding = { accountId: randomUUID(), bindingId: randomUUID(), generation: randomUUID(), implementationId: "test.drive" };
    await manager.rotate(binding, reference, "initial-cookie");
    let release!: () => void, entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; }), observed = new Promise<void>((resolve) => { entered = resolve; });
    const save = store.saveAccount.bind(store); vi.spyOn(store, "saveAccount").mockImplementationOnce(async (ref, secret) => { entered(); await gate; await save(ref, secret); });
    const removing = vi.spyOn(store, "removeAccount");
    const updating = refresh(binding, "updated-cookie"); await observed;
    const disconnecting = manager.disconnect(binding.accountId, reference); await Promise.resolve(); expect(removing).not.toHaveBeenCalled();
    release(); await updating; await disconnecting;
    expect(await store.readAccount(reference)).toBeNull(); await expect(refresh(binding, "late-cookie")).rejects.toMatchObject({ code: "INTERRUPTED" });
  }, 60000);
  it("等待旧执行停止后才持久化并注入，解除只影响当前账号", async () => {
    const { store } = await vault(); const reference = randomUUID(), other = randomUUID();
    await store.saveAccount(other, "other-fixture-secret");
    let release!: () => void, entered!: () => void;
    const observed = new Promise<void>((resolve) => { entered = resolve; });
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const host = { quiesceAccount: vi.fn(async () => { entered(); await wait; }), installCredential: vi.fn(async () => {}), dropCredential: vi.fn(async () => {}) };
    const manager = new AccountCredentials(store, host);
    const binding = { accountId: randomUUID(), bindingId: randomUUID(), generation: randomUUID(), implementationId: "test.drive" };
    const pending = manager.rotate(binding, reference, "new-fixture-secret"); await observed;
    expect(await store.readAccount(reference)).toBeNull(); expect(host.installCredential).not.toHaveBeenCalled();
    release(); await pending;
    expect(host.installCredential).toHaveBeenCalledWith(binding, "new-fixture-secret");
    await manager.disconnect(binding.accountId, reference);
    expect(host.dropCredential).toHaveBeenCalledWith(binding.accountId);
    expect(await store.readAccount(reference)).toBeNull(); expect(await store.readAccount(other)).toBe("other-fixture-secret");
  }, 60000);
  it("无法确认停止时保留旧凭据，不注入也不解除", async () => {
    const { store } = await vault(); const reference = randomUUID(); await store.saveAccount(reference, "old-fixture-secret");
    const host = { quiesceAccount: vi.fn(async () => { throw new Error("未确认退出"); }), installCredential: vi.fn(async () => {}), dropCredential: vi.fn(async () => {}) };
    const manager = new AccountCredentials(store, host);
    const binding = { accountId: randomUUID(), bindingId: randomUUID(), generation: randomUUID(), implementationId: "test.drive" };
    await expect(manager.rotate(binding, reference, "new-fixture-secret")).rejects.toThrow();
    await expect(manager.disconnect(binding.accountId, reference)).rejects.toThrow();
    expect(await store.readAccount(reference)).toBe("old-fixture-secret");
    expect(host.installCredential).not.toHaveBeenCalled(); expect(host.dropCredential).not.toHaveBeenCalled();
  }, 60000);
});
