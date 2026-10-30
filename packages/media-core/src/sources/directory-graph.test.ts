import { afterEach, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { recognitionRuleSnapshotSchema, syncSourceSnapshotSchema, type SyncSourceSnapshot } from "@media-marshal/contracts";
import { CoreDatabase } from "../infrastructure/database.js";
import { assertDirectoryGraph } from "./directory-graph.js";
const cleanup: CoreDatabase[] = []; afterEach(() => { for (const db of cleanup.splice(0)) db.close(); });
const directory = (path: string) => ({ id: randomUUID(), version: 1, path });
const sync = (input: string, target: string) => { const a = directory(input), b = directory(target); return syncSourceSnapshotSchema.parse({ sourceId: randomUUID(), sourceVersion: 1, configuration: { type: "local", name: "同步测试", inputDirectoryId: a.id, target: { kind: "directory", directoryId: b.id } }, inputDirectory: a, targetDirectory: b, defaultDirectoryVersion: null }); };
function store(db: CoreDatabase, snapshot: SyncSourceSnapshot) {
  db.connection.prepare("INSERT INTO sync_source_rule(id,version,draft_revision,lifecycle_revision,draft_json,paused,review_json,created_at,updated_at) VALUES(?,1,1,0,?,0,'[]','测试','测试')").run(snapshot.sourceId, JSON.stringify(snapshot.configuration));
  db.connection.prepare("INSERT INTO sync_source_version VALUES(?,1,?)").run(snapshot.sourceId, JSON.stringify(snapshot));
}
it("允许受管完成区交接识别，同时阻断间接回流和识别重复接管", async () => {
  const db = await CoreDatabase.open(":memory:"); cleanup.push(db); store(db, sync("/隔离输入", "/隔离下载"));
  const input = directory("/隔离下载"), output = directory("/隔离媒体"), targetId = randomUUID();
  const recognition = recognitionRuleSnapshotSchema.parse({ ruleId: randomUUID(), ruleVersion: 1, configuration: { name: "混合识别", input: { kind: "directory", directoryId: input.id }, targets: [{ id: targetId, name: "电影", mediaType: "MOVIE", directoryId: output.id }] }, inputDirectory: input, inputMode: "managed-completed", defaultDirectoryVersion: null, targets: [{ targetId, directory: output, embyBinding: null }] });
  expect(() => assertDirectoryGraph(db, "recognition", recognition)).not.toThrow();
  expect(() => assertDirectoryGraph(db, "sync", sync("/隔离下载/completed", "/隔离输入"))).toThrow(/循环/);
  db.connection.prepare("INSERT INTO recognition_rule(id,version,draft_revision,lifecycle_revision,draft_json,paused,review_json,created_at,updated_at) VALUES(?,1,1,0,?,0,'[]','测试','测试')").run(recognition.ruleId, JSON.stringify(recognition.configuration));
  db.connection.prepare("INSERT INTO recognition_rule_version VALUES(?,1,?)").run(recognition.ruleId, JSON.stringify(recognition));
  expect(() => assertDirectoryGraph(db, "recognition", { ...recognition, ruleId: randomUUID() })).toThrow(/重叠/);
  expect(() => assertDirectoryGraph(db, "sync", sync("/隔离媒体", "/隔离输入"))).toThrow(/循环/);
});
