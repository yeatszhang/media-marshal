import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, lstat, statfs, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoreDatabase } from "../infrastructure/database.js";
import { CloudRoots } from "../cloud/roots.js";
import { ConfigurationDirectories } from "./configuration-directories.js";
import type { ManagedRootGrant } from "@media-marshal/contracts/internal";
import { syncSourceConfigurationSchema, syncSourceSnapshotSchema } from "@media-marshal/contracts";
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "marshal-configuration-"))); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const db = await CoreDatabase.open(join(directory, "core.sqlite3")); cleanup.push(() => db.close());
  const roots = new CloudRoots(db); cleanup.push(() => roots.close()); const service = new ConfigurationDirectories(db, roots); cleanup.push(() => service.close());
  const volumeId = randomUUID();
  const grant = async (name: string) => { const path = join(directory, name); await mkdir(path, { recursive: true }); const info = await lstat(path, { bigint: true }), fs = await statfs(path, { bigint: true }); return { id: randomUUID(), path, volume: { volumeId, rootInode: String(info.ino), rootBirthtimeNs: String(info.birthtimeNs), observedDevice: String(info.dev), fsTypeCode: String(fs.type), fsType: "test", caseSensitive: true, unicodeEquivalent: true, pathMaxBytes: 4096 } } satisfies ManagedRootGrant; };
  return { directory, db, roots, service, grant };
}
describe("独立目录授权与默认下载目录", () => {
  it("无网盘或媒体连接可授权目录，默认变更不修改已冻结绑定和源文件", async () => {
    const f = await fixture(), source = await f.grant("本地输入"), a = await f.grant("下载 A 中文 空格"), b = await f.grant("下载 B"); await writeFile(join(source.path, "原视频.mp4"), "保留原输入");
    expect(f.service.defaults()).toEqual({ version: 0, directory: null }); expect(() => f.service.resolve({ kind: "default" })).toThrow(/本地下载目录/);
    await f.service.authorize(source, "ordinary"); await f.service.authorize(a, "managed"); await f.service.authorize(b, "managed");
    const input = { expectedVersion: 0, directoryId: a.id, requestKey: randomUUID() }, saved = f.service.setDefault(input), snapshot = f.service.resolve({ kind: "default" });
    const sourceId = randomUUID(), configuration = syncSourceConfigurationSchema.parse({ type: "local", name: "已冻结来源", inputDirectoryId: source.id }), stamp = new Date().toISOString();
    const frozen = syncSourceSnapshotSchema.parse({ sourceId, sourceVersion: 1, configuration, inputDirectory: f.service.binding(source.id), targetDirectory: snapshot.directory, defaultDirectoryVersion: snapshot.defaultDirectoryVersion });
    f.db.connection.prepare("INSERT INTO sync_source_rule(id,version,draft_revision,lifecycle_revision,draft_json,paused,review_json,created_at,updated_at) VALUES(?,1,1,0,?,0,'[]',?,?)").run(sourceId, JSON.stringify(configuration), stamp, stamp);
    f.db.connection.prepare("INSERT INTO sync_source_version VALUES(?,1,?)").run(sourceId, JSON.stringify(frozen));
    expect(f.service.setDefault(input)).toEqual(saved); expect(snapshot).toEqual({ directory: { id: a.id, version: 1, path: a.path }, defaultDirectoryVersion: 1 });
    f.service.setDefault({ expectedVersion: 1, directoryId: b.id, requestKey: randomUUID() });
    expect(snapshot.directory.path).toBe(a.path); expect(f.service.defaults().directory?.path).toBe(b.path); expect(await readFile(join(source.path, "原视频.mp4"), "utf8")).toBe("保留原输入");
    expect(JSON.parse((f.db.connection.prepare("SELECT snapshot_json FROM sync_source_version WHERE source_id=?").get(sourceId) as { snapshot_json: string }).snapshot_json)).toEqual(frozen);
    expect(f.service.resolve({ kind: "directory", directoryId: a.id })).toEqual({ directory: snapshot.directory, defaultDirectoryVersion: null });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM download_job").get()).toEqual({ n: 0 }); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
  });
  it("默认设置版本冲突、复用请求冲突及普通输入不能冒充下载目标", async () => {
    const f = await fixture(), source = await f.grant("普通输入"), target = await f.grant("下载目标"); await f.service.authorize(source, "ordinary"); await f.service.authorize(target, "managed");
    expect(() => f.service.setDefault({ expectedVersion: 0, directoryId: source.id, requestKey: randomUUID() })).toThrow(/受管下载根/);
    const command = { expectedVersion: 0, directoryId: target.id, requestKey: randomUUID() }; f.service.setDefault(command);
    expect(() => f.service.setDefault({ ...command, directoryId: null })).toThrow(/其他默认目录/);
    expect(() => f.service.setDefault({ expectedVersion: 0, directoryId: null, requestKey: randomUUID() })).toThrow(/已变化/);
    expect(f.service.defaults().directory?.id).toBe(target.id);
  });
  it("重启只保留目录引用，原卷重新核验前不可读取；错误身份不接管原路径", async () => {
    const f = await fixture(), grant = await f.grant("恢复目录"); await f.service.authorize(grant, "ordinary"); await f.service.close();
    const restored = new ConfigurationDirectories(f.db, f.roots); cleanup.push(() => restored.close());
    expect(await restored.list()).toMatchObject([{ id: grant.id, available: false }]); expect(() => restored.reader(grant.id)).toThrow(/原目录或磁盘/);
    await expect(restored.authorize({ ...grant, volume: { ...grant.volume, volumeId: randomUUID() } }, "ordinary")).rejects.toMatchObject({ code: "LOCAL_UNAVAILABLE" });
    await restored.authorize(grant, "ordinary"); expect(await restored.list()).toMatchObject([{ id: grant.id, version: 1, available: true }]);
    expect(await restored.reader(grant.id).discover()).toEqual([]);
  });
  it("不通过普通目录绕过受管根、私有暂存或历史目录身份", async () => {
    const f = await fixture(), managed = await f.grant("受管下载"); await f.service.authorize(managed, "managed");
    const nested = await f.grant("受管下载/completed/外部目录"), privateRoot = await f.grant("受管下载/.media-marshal/staging/外部目录");
    await expect(f.service.authorize(nested, "ordinary")).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    await expect(f.service.authorize(privateRoot, "ordinary")).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    await expect(f.service.authorize({ ...managed, id: randomUUID() }, "managed")).rejects.toMatchObject({ code: "LOCAL_UNAVAILABLE" });
    expect(await f.service.list()).toHaveLength(1);
  });
});
