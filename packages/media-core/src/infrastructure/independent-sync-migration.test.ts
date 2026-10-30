import { afterEach, expect, it } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CoreDatabase, migrations } from "./database.js";
import { migrateIndependentSync } from "./independent-sync-migration.js";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(invalidFilters = false) {
  const folder = await mkdtemp(join(tmpdir(), "marshal-sync-v32-")); cleanup.push(() => rm(folder, { recursive: true, force: true }));
  const path = join(folder, "core.sqlite3"), db = await CoreDatabase.open(path, migrations.slice(0, 31)); cleanup.push(() => db.close());
  const id = randomUUID(), root = randomUUID(), stamp = new Date().toISOString();
  db.connection.prepare("INSERT INTO managed_download_root VALUES(?,?,'/隔离旧下载根','{}','UNAVAILABLE',?)").run(root, root, stamp);
  const config = { type: "cloud", name: "v28 后创建", accountId: randomUUID(), remoteRef: randomUUID(), downloadRootId: root, filters: invalidFilters ? { names: ["包含\n换行.mkv"], extensions: [] } : { names: [], extensions: ["mkv"] }, periodic: { enabled: true, intervalSeconds: 900 }, organization: null };
  db.connection.prepare("INSERT INTO source_rule(id,type,version,draft_revision,lifecycle_revision,draft_json,paused,created_at,updated_at) VALUES(?,'cloud',3,7,4,?,1,?,?)").run(id, JSON.stringify(config), stamp, stamp);
  db.connection.prepare("INSERT INTO source_rule_version(source_id,version,configuration_json,created_at) VALUES(?,3,?,?)").run(id, JSON.stringify(config), stamp);
  return { db, path, id, root, config };
}
it("补齐 v28 后旧配置并保留原行、暂停和不可信目录授权，不重写已发布迁移", async () => {
  const f = await fixture(), before = f.db.connection.prepare("SELECT * FROM source_rule").all(); f.db.close();
  const db = await CoreDatabase.open(f.path, migrations.slice(0, 32)); cleanup.push(() => db.close());
  expect(db.connection.prepare("SELECT * FROM source_rule").all()).toEqual(before);
  expect(db.connection.prepare("SELECT paused,version FROM sync_source_rule WHERE id=?").get(f.id)).toEqual({ paused: 1, version: 3 });
  expect(db.connection.prepare("SELECT grant_json FROM configuration_directory WHERE id=?").get(f.root)).toEqual({ grant_json: null });
  const row = db.connection.prepare("SELECT snapshot_json FROM sync_source_version WHERE source_id=?").get(f.id) as { snapshot_json: string };
  expect(JSON.parse(row.snapshot_json)).toMatchObject({ configuration: { filters: [{ action: "include", pattern: "*.mkv", caseSensitive: false }, { action: "exclude", pattern: "**" }] }, targetDirectory: { id: f.root } });
  expect(db.connection.prepare("SELECT claimed,edited FROM sync_runtime WHERE source_id=?").get(f.id)).toEqual({ claimed: 0, edited: 0 });
  expect(db.connection.pragma("foreign_key_check")).toEqual([]);
});
it("不可表示的旧筛选保留原文且不扩大范围或生成可执行快照", async () => {
  const f = await fixture(true), invalid = f.config; f.db.close();
  const db = await CoreDatabase.open(f.path, migrations.slice(0, 32)); cleanup.push(() => db.close());
  const row = db.connection.prepare("SELECT draft_json,legacy_configuration_json,review_json FROM sync_source_rule WHERE id=?").get(f.id) as { draft_json: string; legacy_configuration_json: string; review_json: string };
  expect(JSON.parse(row.draft_json).filters).toEqual([{ action: "exclude", pattern: "**", caseSensitive: true }]);
  expect(JSON.parse(row.legacy_configuration_json).draft.filters).toEqual(invalid.filters);
  expect(JSON.parse(row.review_json)).toContain("LEGACY_SCOPE_REVIEW_REQUIRED");
  expect(db.connection.prepare("SELECT * FROM sync_source_version WHERE source_id=?").get(f.id)).toBeUndefined();
});
it("迁移中断整体回滚，重试保留原备份且旧核心拒绝新库", async () => {
  const f = await fixture(); f.db.close(); const migration = migrations[31]!;
  await expect(CoreDatabase.open(f.path, [...migrations.slice(0, 31), { ...migration, apply(db) { migrateIndependentSync(db); throw new Error("模拟迁移中断"); } }])).rejects.toThrow("模拟迁移中断");
  const backup = await readFile(f.path + ".before-v32.bak"), old = new Database(f.path);
  expect(old.pragma("user_version", { simple: true })).toBe(31); expect(old.prepare("SELECT name FROM sqlite_master WHERE name='sync_job'").get()).toBeUndefined(); old.close();
  const db = await CoreDatabase.open(f.path, migrations.slice(0, 32)); db.close(); expect(await readFile(f.path + ".before-v32.bak")).toEqual(backup);
  await expect(CoreDatabase.open(f.path, migrations.slice(0, 31))).rejects.toMatchObject({ code: "STORAGE_ERROR" });
});
