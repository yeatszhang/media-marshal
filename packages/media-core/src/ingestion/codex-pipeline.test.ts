import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, realpath, mkdir, lstat, statfs, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { recognitionSettingsSchema } from "@media-marshal/contracts";
import type { ManagedRootGrant } from "@media-marshal/contracts/internal";
import { CoreDatabase } from "../infrastructure/database.js";
import { MediaConnections } from "../application/media-connections.js";
import { SourceRoot } from "../files/source-root.js";
import { normalizeParse } from "../domain/media.js";
import { CodexRecognition } from "./codex-recognition.js";
import { IngestionPipeline } from "./pipeline.js";
import type { CodexGateway } from "../infrastructure/codex-process.js";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(names = ["48.mkv", "49.mkv"], recognize = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "marshal-codex-pipeline-"))); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "输入"), target = join(root, "媒体库"); await mkdir(join(source, "咒术回战", "S03"), { recursive: true }); await mkdir(target);
  for (const name of names) await writeFile(join(source, "咒术回战", "S03", name), "隔离真实视频内容");
  const db = await CoreDatabase.open(join(root, "core.sqlite3")); cleanup.push(() => db.close());
  const settings = recognitionSettingsSchema.parse({ codexEnabled: true });
  const connections = new MediaConnections(db, () => ({ language: "zh-CN", embyUrl: "", tmdbProxy: "", recognition: settings })); cleanup.push(() => connections.close()); connections.install({ tmdb: "fake-key", emby: null });
  const metadata = { tmdbId: 95479, mediaType: "TV_SHOW" as const, title: "咒术回战", originalTitle: "Jujutsu Kaisen", year: 2020 };
  vi.spyOn(connections.tmdb, "search").mockResolvedValue([metadata]); vi.spyOn(connections.tmdb, "detail").mockResolvedValue({ ...metadata, seasons: [1] });
  vi.spyOn(connections.tmdb, "episodes").mockResolvedValue(Array.from({ length: 60 }, (_, n) => ({ season: 1, episode: n + 1, title: "第" + (n + 1) + "集" })));
  const response = { status: "identified", title: "咒术回战", year: 2020, type: "episode", confidence: 0.97, reason: "官网与累计集号依据", season: 3, episode: null };
  const request = vi.fn<CodexGateway["request"]>().mockImplementation(async (action, value) => {
    const context = value as { files?: string[]; parsed: { episode: number | null } };
    if (action === "recognize-directory") return { ...response, files: context.files!.map((filename) => ({ filename, season: 3, episode: Number(/\d+/.exec(filename)![0]), episode_end: null })) };
    return { ...response, clustered: action === "recognize-cluster", episode: context.parsed.episode };
  });
  const codex = new CodexRecognition({ request, close: async () => {} }, () => settings);
  const parser = { ready: true, start: async () => {}, close: async () => {}, parse: async (name: string) => normalizeParse({ title: "来源别名", type: "episode", season: 3, episode: Number(/\d+/.exec(name)?.[0] ?? 48) }, name) };
  let clock = 0;
  const pipeline = new IngestionPipeline(db, () => parser, connections, () => Date.UTC(2026, 9, 31) + clock, () => clock, undefined, undefined, codex); cleanup.push(() => pipeline.close());
  async function grant(path: string): Promise<ManagedRootGrant> { const info = await lstat(path, { bigint: true }), fs = await statfs(path, { bigint: true }); return { id: randomUUID(), path, volume: { volumeId: randomUUID(), rootInode: String(info.ino), rootBirthtimeNs: String(info.birthtimeNs), observedDevice: String(info.dev), fsType: "isolated-test", fsTypeCode: String(fs.type), caseSensitive: true, unicodeEquivalent: true, pathMaxBytes: 4096 } }; }
  const sourceId = randomUUID(); db.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'隔离来源','custom',?,?,'TV_SHOW','COPY',?)").run(sourceId, source, target, new Date().toISOString());
  await pipeline.authorize({ sourceId, sourceVersion: 1, mode: "local", downloadRootId: null, source: await grant(source), target: await grant(target) });
  await pipeline.scan(sourceId); for (let n = 0; n < 13; n++) { clock += 10000; await pipeline.scan(sourceId); }
  const tasks: string[] = [];
  if (recognize) for (const candidate of pipeline.list({ sourceId }).items) { const task = await pipeline.recognize({ candidateId: candidate.id, requestKey: randomUUID() }); await pipeline.tick(); tasks.push(task.taskId); }
  return { db, pipeline, source, sourceId, connections, request, settings, tasks, response };
}
it("迁移聚类先行及咒术回战case：S03E48预检映射S01E48，集号与模型依据持久保存", async () => {
  const f = await fixture(["48.mkv"]), task = f.pipeline.task(f.tasks[0]!);
  expect(task.parsed).toMatchObject({ season: 3, episode: 48 });
  expect(task.matches[0]).toMatchObject({ evidence: "codex", codex: { confidence: 0.97 }, episodeCheck: { state: "VALID", season: 1, episode: 48, seasonChanged: true } });
  expect(f.request.mock.calls.map(([action]) => action)).toEqual(["recognize-cluster"]);
});
it("迁移 directoryRecognizesOnceAndSharesCandidates：同目录一次模型识别并分发共享候选", async () => {
  const f = await fixture(); f.request.mockClear(); const search = vi.mocked(f.connections.tmdb.search); search.mockClear();
  const input = { taskId: f.tasks[0]!, directory: true, organize: false, requestKey: randomUUID() };
  const job = f.pipeline.codexJobs.enqueue(input); expect(f.pipeline.codexJobs.enqueue(input).id).toBe(job.id); await f.pipeline.codexJobs.tick();
  const result = f.pipeline.codexJobs.get(job.id);
  expect(result).toMatchObject({ state: "COMPLETED", items: [expect.objectContaining({ state: "UPDATED" }), expect.objectContaining({ state: "UPDATED" })] });
  expect(f.request).toHaveBeenCalledTimes(1); expect(f.request.mock.calls[0]![0]).toBe("recognize-directory");
  expect(search).toHaveBeenCalledTimes(1);
  expect(f.tasks.map((id) => f.pipeline.task(id).parsed!.episode).sort()).toEqual([48, 49]);
  expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
});
it("迁移 directoryTmdbMissLeavesOriginalTaskAndCandidates：无TMDB候选保留原信息，错误持久可查", async () => {
  const f = await fixture(), before = f.tasks.map((id) => f.pipeline.task(id)); vi.mocked(f.connections.tmdb.search).mockResolvedValue([]);
  const job = f.pipeline.codexJobs.enqueue({ taskId: f.tasks[0]!, directory: true, organize: false, requestKey: randomUUID() }); await f.pipeline.codexJobs.tick();
  expect(f.pipeline.codexJobs.get(job.id)).toMatchObject({ state: "FAILED", failure: expect.stringContaining("TMDB") });
  expect(f.tasks.map((id) => f.pipeline.task(id))).toEqual(before);
});
it("迁移 directorySkipsTaskConfirmedWhileModelIsRunning：模型返回时重新核对每项版本", async () => {
  const f = await fixture(), second = f.tasks[1]!;
  f.request.mockImplementationOnce(async () => {
    f.db.connection.prepare("UPDATE media_task SET status='DONE' WHERE id=?").run(second);
    return { ...f.response, files: [48, 49].map((episode) => ({ filename: `${episode}.mkv`, season: 3, episode, episode_end: null })) };
  });
  const job = f.pipeline.codexJobs.enqueue({ taskId: f.tasks[0]!, directory: true, organize: false, requestKey: randomUUID() }); await f.pipeline.codexJobs.tick();
  expect(f.pipeline.codexJobs.get(job.id)).toMatchObject({ state: "PARTIAL_FAILED", items: expect.arrayContaining([expect.objectContaining({ taskId: second, state: "SKIPPED", failure: expect.stringContaining("变化") })]) });
  expect(f.pipeline.task(second).state).toBe("DONE");
});
it("重识别不会绕过桌面首次样本授权，已更新的识别与未整理原因逐项保留", async () => {
  const f = await fixture(["48.mkv"]), job = f.pipeline.codexJobs.enqueue({ taskId: f.tasks[0]!, directory: false, organize: true, requestKey: randomUUID() }); await f.pipeline.codexJobs.tick();
  expect(f.pipeline.codexJobs.get(job.id)).toMatchObject({ state: "PARTIAL_FAILED", items: [expect.objectContaining({ state: "UPDATED", failure: expect.stringContaining("尚未授权自动整理") })] });
  expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
});
it("目录入口从就绪文件原子建立任务并共享一次识别，重复请求不会重复领取", async () => {
  const f = await fixture(undefined, false), directory = f.pipeline.directories.list({}).items[0]!;
  const input = { id: directory.id, sourceId: directory.sourceId, organize: false, requestKey: randomUUID() };
  const job = await f.pipeline.prepareCodexDirectory(input); await f.pipeline.codexJobs.tick();
  expect(f.pipeline.codexJobs.get(job.id)).toMatchObject({ state: "COMPLETED", items: [expect.objectContaining({ state: "UPDATED" }), expect.objectContaining({ state: "UPDATED" })] });
  expect(f.request.mock.calls.map(([action]) => action)).toEqual(["recognize-directory"]);
  expect((await f.pipeline.prepareCodexDirectory(input)).id).toBe(job.id);
  expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 2 });
  await expect(f.pipeline.prepareCodexDirectory({ ...input, organize: true })).rejects.toThrow("其他范围");
});

it("旧 codexCannotChangeUnknownTaskOrMoveFiles：未知及已完成任务拒绝调用模型", async () => {
  const f = await fixture(["48.mkv"]); f.request.mockClear();
  expect(() => f.pipeline.codexJobs.enqueue({ taskId: randomUUID(), directory: false, organize: true, requestKey: randomUUID() })).toThrow("任务不存在");
  f.db.connection.prepare("UPDATE media_task SET status='DONE' WHERE id=?").run(f.tasks[0]!);
  expect(() => f.pipeline.codexJobs.enqueue({ taskId: f.tasks[0]!, directory: false, organize: true, requestKey: randomUUID() })).toThrow("仅待确认");
  expect(f.request).not.toHaveBeenCalled(); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
});
it("旧 directoryInspectionFailureIsActionableAndCannotPassSilently：读取目录失败不调用模型或提交文件", async () => {
  const f = await fixture(["48.mkv"]); f.request.mockClear();
  vi.spyOn(SourceRoot.prototype, "filesIn").mockRejectedValue(Object.assign(new Error("private filesystem response"), { code: "EACCES" }));
  const job = f.pipeline.codexJobs.enqueue({ taskId: f.tasks[0]!, directory: true, organize: true, requestKey: randomUUID() }); await f.pipeline.codexJobs.tick();
  expect(f.pipeline.codexJobs.get(job.id)).toMatchObject({ state: "FAILED", failure: expect.stringContaining("读取权限不足") });
  expect(f.request).not.toHaveBeenCalled(); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
});

it("旧 recordFailureMergesSameSourceRuleAndErrorCode：重试保留原任务，不重复候选，逐次错误仍可追溯", async () => {
  const f = await fixture(["48.mkv"]), taskId = f.tasks[0]!, before = f.pipeline.task(taskId);
  f.request.mockRejectedValue(new Error("private model response"));
  const ids: string[] = [];
  for (let n = 0; n < 2; n++) { const job = f.pipeline.codexJobs.enqueue({ taskId, directory: false, organize: false, requestKey: randomUUID() }); await f.pipeline.codexJobs.tick(); ids.push(job.id); expect(f.pipeline.codexJobs.get(job.id).state).toBe("FAILED"); }
  expect(f.pipeline.task(taskId)).toEqual(before); expect(new Set(ids).size).toBe(2);
  expect(f.db.connection.prepare("SELECT count(*) AS n FROM media_task").get()).toEqual({ n: 1 });
  expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_candidate WHERE is_current=1").get()).toEqual({ n: 1 });
  expect(JSON.stringify(f.pipeline.codexJobs.list())).not.toContain("private model response");
});
