import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, lstat, statfs, realpath, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CoreDatabase, migrations } from "./database.js";
import { migrateIndependentRecognition } from "./independent-recognition-migration.js";
const cleanup: (() => unknown | Promise<unknown>)[] = []; afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "marshal-recognition-v33-"))); cleanup.push(() => rm(folder, { recursive: true, force: true })); const path = join(folder, "core.sqlite3"), db = await CoreDatabase.open(path, migrations.slice(0, 32)); cleanup.push(() => db.close());
  async function grant(name: string) { const path = join(folder, name); await mkdir(path); const stat = await lstat(path, { bigint: true }), fs = await statfs(path, { bigint: true }); return { id: randomUUID(), path, volume: { volumeId: randomUUID(), rootInode: String(stat.ino), rootBirthtimeNs: String(stat.birthtimeNs), observedDevice: String(stat.dev), fsTypeCode: String(fs.type), fsType: "isolated-test", caseSensitive: true, unicodeEquivalent: true, pathMaxBytes: 4096 } }; }
  const input = await grant("原输入"), media = await grant("原媒体"), id = randomUUID(), stamp = new Date().toISOString();
  const config = { type: "local", name: "v28 后旧本地直整", client: "baidu", sourcePath: input.path, ignoredFilePatterns: null, organization: { targetPath: media.path, mediaType: "AUTO", automatic: true } };
  db.connection.prepare("INSERT INTO media_target_root VALUES(?,?,0)").run(media.id, JSON.stringify(media)); db.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,version,paused,created_at) VALUES(?,?,'baidu',?,?,'AUTO','COPY',2,1,?)").run(id, config.name, input.path, media.path, stamp); db.connection.prepare("INSERT INTO ingestion_source VALUES(?,'local',NULL,?,?,2,0)").run(id, JSON.stringify(input), media.id);
  db.connection.prepare("INSERT INTO source_rule(id,type,version,draft_revision,lifecycle_revision,draft_json,paused,local_source_id,created_at,updated_at) VALUES(?,'local',2,3,1,?,1,?,?,?)").run(id, JSON.stringify(config), id, stamp, stamp); db.connection.prepare("INSERT INTO source_rule_version(source_id,version,configuration_json,local_source_id,target_root_id,created_at) VALUES(?,2,?,?,?,?)").run(id, JSON.stringify(config), id, media.id, stamp);
  await writeFile(join(input.path, "保留原片.mp4"), "原文件和路径保持");
  const tables = ["source_rule", "source_rule_version", "desktop_source", "ingestion_source", "media_task", "ingestion_operation", "recognition_rule_legacy_reference"];
  const original = Object.fromEntries(tables.map((table) => [table, db.connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  return { path, db, input, media, id, original };
}
it("v33 补齐后续旧本地配置，普通输入保持直整、空目标可授权，旧行与文件不变", async () => {
  const f = await fixture(), inode = (await lstat(join(f.input.path, "保留原片.mp4"))).ino; f.db.close(); const db = await CoreDatabase.open(f.path); cleanup.push(() => db.close());
  for (const [table, before] of Object.entries(f.original)) if (table !== "recognition_rule_legacy_reference") expect(db.connection.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(before);
  const row = db.connection.prepare("SELECT draft_json,paused,review_json FROM recognition_rule WHERE id=?").get(f.id) as { draft_json: string; paused: number; review_json: string };
  expect(row.paused).toBe(1); expect(JSON.parse(row.draft_json)).toMatchObject({ input: { directoryId: f.input.id }, automatic: false, targets: [{ mediaType: "MOVIE", directoryId: f.media.id }, { mediaType: "TV_SHOW", directoryId: f.media.id }] }); expect(JSON.parse(row.review_json)).toContain("AUTOMATIC_REAUTHORIZATION_REQUIRED");
  expect(db.connection.prepare("SELECT count(*) AS n FROM sync_source_rule").get()).toEqual({ n: 0 }); expect(db.connection.prepare("SELECT claimed FROM recognition_runtime WHERE rule_id=?").get(f.id)).toEqual({ claimed: 0 }); expect(db.connection.prepare("SELECT count(*) AS n FROM recognition_automatic_consent").get()).toEqual({ n: 0 });
  expect((await lstat(join(f.input.path, "保留原片.mp4"))).ino).toBe(inode); expect(await readFile(join(f.input.path, "保留原片.mp4"), "utf8")).toBe("原文件和路径保持");
  const source = randomUUID(); db.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'独立空目标','custom','/隔离新输入','','AUTO','COPY','测试')").run(source); expect(() => db.connection.prepare("INSERT INTO ingestion_source VALUES(?,'local',NULL,?,NULL,1,0)").run(source, JSON.stringify(f.input))).not.toThrow(); expect(db.connection.pragma("foreign_key_check")).toEqual([]);
});
it("v33 迁移失败整体回滚，重试保留 v32 一致性备份，旧核心拒绝新库", async () => {
  const f = await fixture(); f.db.close(); const migration = migrations[32]!;
  await expect(CoreDatabase.open(f.path, [...migrations.slice(0, 32), { ...migration, apply(db) { migrateIndependentRecognition(db); throw new Error("模拟独立识别迁移中断"); } }])).rejects.toThrow("模拟独立识别迁移中断");
  const backup = await readFile(f.path + ".before-v33.bak"), old = new Database(f.path); expect(old.pragma("user_version", { simple: true })).toBe(32); expect(old.prepare("SELECT name FROM sqlite_master WHERE name='recognition_input'").get()).toBeUndefined(); for (const [table, before] of Object.entries(f.original)) expect(old.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).toEqual(before); old.close();
  const db = await CoreDatabase.open(f.path); db.close(); expect(await readFile(f.path + ".before-v33.bak")).toEqual(backup); await expect(CoreDatabase.open(f.path, migrations.slice(0, 32))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
});
