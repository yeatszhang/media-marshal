import { afterEach, describe, expect, it, vi } from "vitest";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
vi.mock("electron", () => ({ safeStorage: {} }));
import { Credentials, type CredentialEncryption } from "./credentials";
import { AccountCredentials } from "./cloud/account-credentials";

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
