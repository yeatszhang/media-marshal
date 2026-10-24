import { safeStorage } from "electron";
import { readFile, writeFile, rename, unlink, lstat } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DesktopError } from "@media-marshal/contracts";
import { ensurePrivateDirectory, ensurePrivateFile } from "./cloud/private-files";

export interface CredentialEncryption {
  isAsyncEncryptionAvailable(): Promise<boolean>;
  encryptStringAsync(value: string): Promise<Buffer>;
  decryptStringAsync(value: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}
const credentialKeys = /^(tmdb|emby|cloud:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/;
const valuesSchema = z.record(z.string().regex(credentialKeys), z.string().max(128 * 1024).regex(/^[A-Za-z0-9+/]+={0,2}$/)).refine((values) => Object.keys(values).length <= 102);

export class Credentials {
  private queue: Promise<void> = Promise.resolve();
  constructor(private readonly path: string, private readonly encryption: CredentialEncryption = safeStorage) {}
  private async read(): Promise<Record<string, string>> {
    try {
      const info = await lstat(this.path);
      if (info.size > 16 * 1024 * 1024) throw new Error();
      await ensurePrivateFile(this.path);
      return valuesSchema.parse(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      if (error instanceof DesktopError) throw error;
      throw new DesktopError(
        "STORAGE_ERROR",
        "凭据文件无法读取，请检查数据目录",
      );
    }
  }
  async configured(): Promise<{
    tmdbKeyConfigured: boolean;
    embyKeyConfigured: boolean;
  }> {
    const values = await this.read();
    return {
      tmdbKeyConfigured: Boolean(values.tmdb),
      embyKeyConfigured: Boolean(values.emby),
    };
  }
  save(kind: "tmdb" | "emby", value: string): Promise<void> {
    return this.saveKey(kind, value || null);
  }
  saveAccount(reference: string, value: string): Promise<void> {
    if (!z.uuid().safeParse(reference).success || !value || value.length > 32768) return Promise.reject(new DesktopError("INVALID_REQUEST", "账号凭据格式无效"));
    return this.saveKey(`cloud:${reference}`, value);
  }
  removeAccount(reference: string): Promise<void> {
    if (!z.uuid().safeParse(reference).success) return Promise.reject(new DesktopError("INVALID_REQUEST", "凭据引用无效"));
    return this.saveKey(`cloud:${reference}`, null);
  }
  async readAccount(reference: string): Promise<string | null> {
    if (!z.uuid().safeParse(reference).success) throw new DesktopError("INVALID_REQUEST", "凭据引用无效");
    await this.queue.catch(() => {});
    await this.requireEncryption();
    const key = `cloud:${reference}`;
    const values = await this.read();
    if (!values[key]) return null;
    try {
      const decrypted = await this.encryption.decryptStringAsync(Buffer.from(values[key], "base64"));
      // 只在值仍匹配时刷新加密形式，不覆盖并发轮换后的新凭据。
      if (decrypted.shouldReEncrypt) await this.reencrypt(key, values[key], decrypted.result);
      return decrypted.result;
    } catch { throw new DesktopError("STORAGE_ERROR", "账号凭据暂时无法解密，请重新授权", true); }
  }
  private async requireEncryption() {
    try { if (await this.encryption.isAsyncEncryptionAvailable()) return; } catch {}
    throw new DesktopError("STORAGE_ERROR", "系统凭据保护当前不可用，请稍后重试", true);
  }
  private async write(values: Record<string, string>) {
    valuesSchema.parse(values);
    await ensurePrivateDirectory(dirname(this.path));
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(values), { mode: 0o600, flag: "wx" });
      await ensurePrivateFile(temporary);
      await rename(temporary, this.path);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  private reencrypt(key: string, previous: string, value: string): Promise<void> {
    const task = this.queue.catch(() => {}).then(async () => {
      const values = await this.read();
      if (values[key] !== previous) return;
      await this.requireEncryption();
      values[key] = (await this.encryption.encryptStringAsync(value)).toString("base64");
      await this.write(values);
    });
    this.queue = task; return task;
  }
  private saveKey(key: string, value: string | null): Promise<void> {
    const task = this.queue
      .catch(() => {})
      .then(async () => {
        if (!credentialKeys.test(key)) throw new DesktopError("INVALID_REQUEST", "凭据类型无效");
        // 删除密文不需要密钥可用；写入绝不降级为明文。
        if (value !== null) await this.requireEncryption();
        const values = await this.read();
        try {
          if (value !== null) values[key] = (await this.encryption.encryptStringAsync(value)).toString("base64");
          else delete values[key];
          await this.write(values);
        } catch (error) { if (error instanceof DesktopError) throw error; throw new DesktopError("STORAGE_ERROR", "凭据保存失败，请检查系统保护与私有目录", true); }
      });
    this.queue = task;
    return task;
  }
}
