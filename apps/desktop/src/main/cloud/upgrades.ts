import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { DesktopError } from "@media-marshal/contracts";
import { ensurePrivateDirectory, ensurePrivateFile } from "./private-files";

// 仅备份应用持有的状态；下载根、媒体库、浏览器与普通诊断均不属于此集合。
const names = ["desktop.sqlite3", "desktop.sqlite3-wal", "desktop.sqlite3-shm", "desktop.sqlite3-journal", "credentials.json", "sidecars", "runtime-version.json"] as const;
const versionSchema = z.strictObject({ appVersion: z.string().max(80), schemaVersion: z.number().int().nonnegative(), target: z.string().regex(/^(darwin|win32)-(arm64|x64)$/), components: z.record(z.string().max(80), z.string().max(128)) });
export type RuntimeVersion = z.infer<typeof versionSchema>;
const fileSchema = z.strictObject({ path: z.string().max(4096).refine((value) => !value.includes("\\") && !value.includes("\0") && !value.split("/").some((part) => !part || part === "." || part === "..") && names.some((name) => value === name || value.startsWith(name + "/"))), size: z.number().int().nonnegative(), sha256: z.string().regex(/^[a-f0-9]{64}$/) });
const manifestSchema = z.strictObject({ format: z.literal(1), id: z.uuid(), createdAt: z.iso.datetime(), version: versionSchema, files: z.array(fileSchema).max(100000) });
const journalSchema = z.strictObject({ id: z.uuid(), state: z.enum(["PREPARED", "COMMITTED"]), originals: z.array(z.enum(names)).max(names.length) });
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";
async function exists(path: string) { try { await lstat(path); return true; } catch (error) { if (missing(error)) return false; throw error; } }
async function syncDirectory(path: string) { if (process.platform === "win32") return; const file = await open(path, "r"); try { await file.sync(); } finally { await file.close(); } }
async function json(path: string, value: unknown) {
  await ensurePrivateDirectory(dirname(path)); const temporary = path + "." + randomUUID() + ".tmp", file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
  await ensurePrivateFile(temporary); await rename(temporary, path); await syncDirectory(dirname(path));
}
async function digest(path: string) { const file = await open(path, "r"); try { const hash = createHash("sha256"); for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk); return hash.digest("hex"); } finally { await file.close(); } }

/** 调用者必须先停止 Core、Host 和凭据更新；恢复日志在新 Core 启动之前核对。 */
export class ManagedUpgradeBackups {
  readonly root: string;
  constructor(private readonly data: string) { this.root = join(data, "private-backups"); }
  private async copy(source: string, target: string, relative: string, files: z.infer<typeof fileSchema>[]) {
    const info = await lstat(source); if (info.isSymbolicLink()) throw new DesktopError("STORAGE_ERROR", "私有备份拒绝符号链接");
    if (info.isDirectory()) {
      await ensurePrivateDirectory(target);
      for (const entry of await readdir(source)) await this.copy(join(source, entry), join(target, entry), relative + "/" + entry, files);
      await syncDirectory(target); return;
    }
    if (!info.isFile() || files.length >= 100000 || info.size + files.reduce((sum, file) => sum + file.size, 0) > 1024 ** 3 || Buffer.byteLength(JSON.stringify(files)) > 16 * 1024 * 1024) throw new DesktopError("STORAGE_ERROR", "私有状态无法安全备份");
    fileSchema.shape.path.parse(relative); await ensurePrivateDirectory(dirname(target)); await copyFile(source, target, constants.COPYFILE_EXCL); await ensurePrivateFile(target);
    const file = await open(target, "r+"); try { await file.sync(); } finally { await file.close(); }
    files.push({ path: relative, size: info.size, sha256: await digest(target) });
  }
  async capture(value: RuntimeVersion) {
    const version = versionSchema.parse(value); await ensurePrivateDirectory(this.root);
    const id = randomUUID(), pending = join(this.root, "pending-" + id), destination = join(this.root, id), files: z.infer<typeof fileSchema>[] = [];
    try {
      await ensurePrivateDirectory(pending);
      for (const name of names) if (await exists(join(this.data, name))) await this.copy(join(this.data, name), join(pending, name), name, files);
      const manifest = manifestSchema.parse({ format: 1, id, createdAt: new Date().toISOString(), version, files });
      await json(join(pending, "manifest.json"), manifest); await rename(pending, destination); await syncDirectory(this.root);
      return { id, createdAt: manifest.createdAt, appVersion: version.appVersion, schemaVersion: version.schemaVersion };
    } catch (error) { await rm(pending, { recursive: true, force: true }); throw error; }
  }
  private async manifest(id: string) {
    await ensurePrivateDirectory(this.root); z.uuid().parse(id); const root = join(this.root, id), info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new DesktopError("STORAGE_ERROR", "私有备份无效");
    const path = join(root, "manifest.json"); await ensurePrivateFile(path);
    if ((await lstat(path)).size > 32 * 1024 * 1024) throw new DesktopError("STORAGE_ERROR", "私有备份清单过大");
    const value = manifestSchema.parse(JSON.parse(await readFile(path, "utf8"))); if (value.id !== id) throw new DesktopError("STORAGE_ERROR", "私有备份身份不匹配"); return value;
  }
  async list() {
    await ensurePrivateDirectory(this.root); let entries: string[]; try { entries = await readdir(this.root); } catch (error) { if (missing(error)) return []; throw error; }
    const result = [];
    for (const id of entries) if (z.uuid().safeParse(id).success) {
      try { const m = await this.manifest(id); result.push({ id, createdAt: m.createdAt, appVersion: m.version.appVersion, schemaVersion: m.version.schemaVersion }); } catch { /* 不把未完成或损坏备份作为可恢复项。 */ }
    }
    return result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100);
  }
  async restore(id: string, current: RuntimeVersion, checkpoint: (name: string) => Promise<void> = async () => {}) {
    await this.recover(); const manifest = await this.manifest(id);
    if (manifest.version.target !== current.target || manifest.version.schemaVersion > current.schemaVersion) throw new DesktopError("STORAGE_ERROR", "备份需要兼容的平台或较新客户端");
    const transaction = randomUUID(), work = join(this.root, "restore-" + transaction), staged = join(work, "staged"), old = join(work, "old");
    await ensurePrivateDirectory(staged); await ensurePrivateDirectory(old);
    try {
      const unique = new Set<string>();
      for (const entry of manifest.files) {
        if (unique.has(entry.path)) throw new DesktopError("STORAGE_ERROR", "备份清单存在重复文件"); unique.add(entry.path);
        const source = join(this.root, id, ...entry.path.split("/")), target = join(staged, ...entry.path.split("/"));
        // 从根逐层拒绝链接；不会跟随备份内替换的父目录。
        let parent = join(this.root, id);
        for (const part of entry.path.split("/")) { parent = join(parent, part); if ((await lstat(parent)).isSymbolicLink()) throw new DesktopError("STORAGE_ERROR", "备份包含符号链接"); }
        const copied: z.infer<typeof fileSchema>[] = []; await this.copy(source, target, entry.path, copied);
        if (copied.length !== 1 || copied[0]!.size !== entry.size || copied[0]!.sha256 !== entry.sha256) throw new DesktopError("STORAGE_ERROR", "备份摘要不匹配，未开始恢复");
      }
      const originals: typeof names[number][] = [];
      for (const name of names) if (await exists(join(this.data, name))) originals.push(name);
      await json(join(this.root, "restore.json"), { id: transaction, state: "PREPARED", originals });
      for (const name of names) {
        if (originals.includes(name)) await rename(join(this.data, name), join(old, name));
        if (await exists(join(staged, name))) await rename(join(staged, name), join(this.data, name));
        await syncDirectory(this.data); await syncDirectory(old); await checkpoint(name);
      }
      await json(join(this.root, "restore.json"), { id: transaction, state: "COMMITTED", originals });
      await this.recover();
    } catch (error) { await this.recover(); throw error; }
    finally { if (!await exists(join(this.root, "restore.json"))) await rm(work, { recursive: true, force: true }); }
  }
  async recover() {
    await ensurePrivateDirectory(this.root); const path = join(this.root, "restore.json"); if (!await exists(path)) return;
    await ensurePrivateFile(path); const journal = journalSchema.parse(JSON.parse(await readFile(path, "utf8"))), work = join(this.root, "restore-" + journal.id), old = join(work, "old");
    if (journal.state === "COMMITTED") await json(join(this.root, "reconcile-needed.json"), { transaction: journal.id });
    if (journal.state === "PREPARED") for (const name of names) {
      const previous = join(old, name), target = join(this.data, name);
      if (await exists(previous)) { await rm(target, { recursive: true, force: true }); await rename(previous, target); }
      else if (!journal.originals.includes(name)) await rm(target, { recursive: true, force: true });
    }
    await syncDirectory(this.data); await rm(path); await syncDirectory(this.root); await rm(work, { recursive: true, force: true });
  }
  async reconciliationNeeded() { return exists(join(this.root, "reconcile-needed.json")); }
  async acknowledgeReconciliation() { await rm(join(this.root, "reconcile-needed.json"), { force: true }); await syncDirectory(this.root); }
  async previousVersion(): Promise<RuntimeVersion | null> {
    const path = join(this.data, "runtime-version.json"); if (!await exists(path)) return null;
    await ensurePrivateFile(path); return versionSchema.parse(JSON.parse(await readFile(path, "utf8")));
  }
  async hasDatabase() { return exists(join(this.data, "desktop.sqlite3")); }
  async recordVersion(value: RuntimeVersion) { await json(join(this.data, "runtime-version.json"), versionSchema.parse(value)); }
}
