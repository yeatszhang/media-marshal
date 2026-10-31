import { afterEach, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, lstat, statfs, realpath, rm, writeFile, readFile, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { recognitionRuleConfigurationSchema, type RecognitionRule, type SyncSourceRule } from "@media-marshal/contracts";
import type { ManagedRootGrant } from "@media-marshal/contracts/internal";
import { CoreDatabase } from "../infrastructure/database.js";
import { CoreService } from "../application/core-service.js";
import { MediaConnections } from "../application/media-connections.js";
import { IngestionPipeline } from "../ingestion/pipeline.js";
import { normalizeParse } from "../domain/media.js";
import { CloudRoots } from "../cloud/roots.js";
import { CloudDownloads } from "../cloud/downloads.js";
import { RemoteCatalog } from "../cloud/catalog.js";
import { unavailableHost } from "../cloud/host-gateway.js";
import { ConfigurationDirectories } from "./configuration-directories.js";
import { RecognitionRules } from "./recognition-rules.js";
import { SyncRules } from "./sync-rules.js";
import { LocalSync } from "./local-sync.js";
import { SourceRoot } from "../files/source-root.js";
import { DownloadCleanupJournal } from "../ingestion/download-cleanup-journal.js";
import { OwnedAttemptCleanup } from "../files/owned-attempt-cleanup.js";
import type { CoreLogger } from "../application/logger.js";
import { CodexRecognition } from "../ingestion/codex-recognition.js";
import { recognitionSettingsSchema } from "@media-marshal/contracts";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
const versions = (rule: RecognitionRule | SyncSourceRule) => ({ id: rule.id, expectedVersion: rule.version, expectedDraftRevision: rule.draftRevision, expectedLifecycleRevision: rule.lifecycleRevision });
async function fixture(logger?: CoreLogger, codex?: CodexRecognition) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), "marshal-independent-recognition-"))); cleanup.push(() => rm(folder, { recursive: true, force: true }));
  const db = await CoreDatabase.open(join(folder, "core.sqlite3")); cleanup.push(() => db.close()); const roots = new CloudRoots(db); cleanup.push(() => roots.close());
  const directories = new ConfigurationDirectories(db, roots); cleanup.push(() => directories.close());
  let clock = 0; const now = () => Date.UTC(2026, 9, 28) + clock, volumeId = randomUUID();
  async function grant(name: string, kind: "ordinary" | "managed" | "media") { const path = join(folder, name); await mkdir(path); const info = await lstat(path, { bigint: true }), fs = await statfs(path, { bigint: true }); const value: ManagedRootGrant = { id: randomUUID(), path, volume: { volumeId, rootInode: String(info.ino), rootBirthtimeNs: String(info.birthtimeNs), observedDevice: String(info.dev), fsTypeCode: String(fs.type), fsType: "isolated-test", caseSensitive: true, unicodeEquivalent: true, pathMaxBytes: 4096 } }; await directories.authorize(value, kind); return value; }
  const input = await grant("已有视频输入", "ordinary"), download = await grant("同步完成根", "managed"), movie = await grant("电影库", "media"), tv = await grant("剧集库", "media"), secondMovie = await grant("另一电影库", "media");
  directories.setDefault({ directoryId: download.id, expectedVersion: 0, requestKey: randomUUID() });
  const connections = new MediaConnections(db, () => ({ language: "zh-CN", embyUrl: "", tmdbProxy: "" })); cleanup.push(() => connections.close()); connections.install({ tmdb: "isolated-test", emby: null });
  const metadata = (type: "MOVIE" | "TV_SHOW") => ({ tmdbId: type === "MOVIE" ? 1 : 2, mediaType: type, title: type === "MOVIE" ? "测试电影" : "测试剧集", originalTitle: null, year: 2026 });
  vi.spyOn(connections.tmdb, "search").mockImplementation(async (_query, type) => [metadata(type)]); vi.spyOn(connections.tmdb, "detail").mockImplementation(async (_id, type) => ({ ...metadata(type), seasons: type === "TV_SHOW" ? [1] : [] })); vi.spyOn(connections.tmdb, "episodes").mockResolvedValue([{ season: 1, episode: 1, title: "第一集" }]);
  const parser = { ready: true, start: async () => {}, close: async () => {}, parse: async (name: string) => normalizeParse(/S\d+/i.test(name) ? { title: "测试剧集", type: "episode", year: 2026, season: Number(/S(\d+)/i.exec(name)?.[1] ?? 1), episode: Number(/E(\d+)/i.exec(name)?.[1] ?? 1) } : { title: "测试电影", type: "movie", year: 2026 }, name) };
  const pipeline = new IngestionPipeline(db, () => parser, connections, now, () => clock, undefined, logger, codex); cleanup.push(() => pipeline.close()); const recognition = new RecognitionRules(db, directories, pipeline, now, undefined, logger); cleanup.push(() => recognition.close());
  const downloads = new CloudDownloads(db, unavailableHost, new RemoteCatalog(db, unavailableHost), roots, now); cleanup.push(() => downloads.close()); const sync = new SyncRules(db, directories, downloads, new LocalSync(db, directories, roots, now, () => clock), now); cleanup.push(() => sync.close());
  const bytes = "真实原文件，识别与同步独立。".repeat(500); await writeFile(join(input.path, "测试电影.2026.mp4"), bytes); await writeFile(join(input.path, "测试剧集.S01E01.mp4"), bytes);
  const movieTarget = { id: randomUUID(), name: "电影主库", mediaType: "MOVIE" as const, directoryId: movie.id, template: "{title}/{title}.{ext}" }, tvTarget = { id: randomUUID(), name: "剧集主库", mediaType: "TV_SHOW" as const, directoryId: tv.id, template: null };
  const save = (rule?: RecognitionRule, patch: Record<string, unknown> = {}) => recognition.save({ ...(rule ? versions(rule) : { id: randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, expectedLifecycleRevision: 0 }), requestKey: randomUUID(), configuration: recognitionRuleConfigurationSchema.parse({ name: "独立混合识别", input: { kind: "directory", directoryId: input.id }, targets: [], ...(rule?.draft ?? {}), ...patch }) });
  const enable = async (row: RecognitionRule) => { const p = await recognition.preview({ ...versions(row), requestKey: randomUUID() }); return recognition.confirm({ previewId: p.id, requestKey: randomUUID() }); };
  const advance = async (sourceId?: string, seconds = 130) => { for (let elapsed = 0; elapsed < seconds; elapsed += 10) { clock += 10000; await sync.tick(); if (sourceId) await pipeline.scan(sourceId); } };
  const task = async (sourceId: string, name: string) => { const candidate = pipeline.list({ sourceId }).items.find((row) => row.relativePath.endsWith(name))!; const result = await pipeline.recognize({ candidateId: candidate.id, requestKey: randomUUID() }); await pipeline.tick(); expect(pipeline.task(result.taskId).state).toBe("AWAITING_CONFIRMATION"); return result.taskId; };
  const synchronize = async () => { const draft = sync.save({ id: randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, expectedLifecycleRevision: 0, requestKey: randomUUID(), configuration: { name: "无账号同步", type: "local", inputDirectoryId: input.id } }); const configuration = await sync.preview({ ...versions(draft), requestKey: randomUUID() }), active = (await sync.confirm({ previewId: configuration.id, requestKey: randomUUID() })).rule; await advance(); const execution = await sync.preview({ ...versions(active), requestKey: randomUUID(), mode: "execution" }); await sync.confirm({ previewId: execution.id, requestKey: randomUUID(), filesComplete: true }); await sync.tick(); return active; };
  return { grant, folder, db, roots, directories, input, download, movie, tv, secondMovie, movieTarget, tvTarget, pipeline, recognition, sync, downloads, connections, bytes, save, enable, advance, task, synchronize };
}
it.each([0.97, 0.89])("迁移 singleCodexRetryAutomaticallyResumesWhenChecksPass：模型%f，按百分之90门槛及样本授权整理", async (confidence) => {
  const codex = new CodexRecognition({ close: async () => {}, request: async (action) => ({ status: "identified", title: "测试电影", year: 2026, type: "movie", season: null, episode: null, confidence, reason: "官网作品依据", clustered: false }) }, () => recognitionSettingsSchema.parse({ codexEnabled: true }));
  const f = await fixture(undefined, codex); await f.synchronize(); const rule = await f.enable(f.save(undefined, { input: { kind: "default" }, automatic: true, targets: [f.movieTarget, f.tvTarget] })), sourceId = rule.runtime!.sourceId!;
  await f.pipeline.scan(sourceId); await f.advance(sourceId); const taskId = await f.task(sourceId, "测试电影.2026.mp4"), sample = await f.pipeline.preview({ taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" }, includeAccessories: false });
  f.recognition.authorizeAutomatic({ id: rule.id, expectedVersion: rule.version, samplePreviewId: sample.id, accepted: true, requestKey: randomUUID() });
  const job = f.pipeline.codexJobs.enqueue({ taskId, directory: false, organize: true, requestKey: randomUUID() }); await f.pipeline.codexJobs.tick();
  const result = f.pipeline.codexJobs.get(job.id);
  if (confidence >= 0.9) {
    expect(result).toMatchObject({ state: "COMPLETED", items: [expect.objectContaining({ state: "SUBMITTED", operationId: expect.any(String) })] });
    await f.pipeline.tick(); expect(f.pipeline.task(taskId).state).toBe("DONE"); expect(await readFile(sample.targetPath, "utf8")).toBe(f.bytes);
  } else {
    expect(result).toMatchObject({ state: "PARTIAL_FAILED", items: [expect.objectContaining({ state: "UPDATED", failure: expect.stringContaining("90%") })] });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation WHERE task_id=?").get(taskId)).toEqual({ n: 0 });
  }
});
it("迁移 duplicatePairStaysForReviewWhileOtherEpisodesAutomaticallyOrganize：先核对整批，哈希副本双方保留", async () => {
  const codex = new CodexRecognition({ close: async () => {}, request: async (action, input) => {
    const value = input as { files?: string[] };
    return { status: "identified", title: "测试剧集", year: 2026, type: "episode", season: 1, episode: 1, confidence: 0.97, reason: "同剧官网依据", clustered: false,
      ...(action === "recognize-directory" ? { files: value.files!.map((filename) => ({ filename, season: 1, episode: Number(/E(\d+)/i.exec(filename)![1]), episode_end: null })) } : {}) };
  } }, () => recognitionSettingsSchema.parse({ codexEnabled: true }));
  const f = await fixture(undefined, codex); await rm(join(f.input.path, "测试电影.2026.mp4"));
  for (const name of ["测试剧集.S01E01-8930371d37e8.mp4", "测试剧集.S01E02.mp4", "测试剧集.S01E03.mp4"]) await writeFile(join(f.input.path, name), f.bytes);
  await f.synchronize(); await f.advance();
  vi.mocked(f.connections.tmdb.episodes).mockResolvedValue([1, 2, 3].map((episode) => ({ season: 1, episode, title: `第${episode}集` })));
  const rule = await f.enable(f.save(undefined, { input: { kind: "default" }, automatic: true, targets: [f.tvTarget] })), sourceId = rule.runtime!.sourceId!;
  await f.pipeline.scan(sourceId); await f.advance(sourceId);
  const tasks = new Map<string, string>();
  for (const candidate of f.pipeline.list({ sourceId }).items) tasks.set(candidate.relativePath.split("/").at(-1)!, await f.task(sourceId, candidate.relativePath.split("/").at(-1)!));
  const anchor = tasks.get("测试剧集.S01E02.mp4")!, sample = await f.pipeline.preview({ taskId: anchor, requestKey: randomUUID(), selection: { tmdbId: 2, mediaType: "TV_SHOW", season: 1, episode: 2 }, includeAccessories: false });
  f.recognition.authorizeAutomatic({ id: rule.id, expectedVersion: rule.version, samplePreviewId: sample.id, accepted: true, requestKey: randomUUID() });
  const job = f.pipeline.codexJobs.enqueue({ taskId: anchor, directory: true, organize: true, requestKey: randomUUID() }); await f.pipeline.codexJobs.tick();
  const result = f.pipeline.codexJobs.get(job.id); expect(result.state).toBe("PARTIAL_FAILED");
  expect(result.items.filter((item) => item.state === "SUBMITTED")).toHaveLength(2);
  expect(result.items.filter((item) => item.failure?.includes("重复或重叠"))).toHaveLength(2);
  expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 2 });
});
it("迁移 newHighConfidenceClusterOrganizesWithoutManualApproval：可信成果及样本授权后新簇沿自动流程整理", async () => {
  const codex = new CodexRecognition({ close: async () => {}, request: async () => ({ status: "identified", title: "测试剧集", year: 2026, type: "episode", season: 1, episode: 1, confidence: 0.97, reason: "共同身份核实", clustered: true }) }, () => recognitionSettingsSchema.parse({ codexEnabled: true }));
  const f = await fixture(undefined, codex); await f.synchronize();
  const rule = await f.enable(f.save(undefined, { input: { kind: "default" }, automatic: true, targets: [f.movieTarget, f.tvTarget] })), sourceId = rule.runtime!.sourceId!;
  await f.pipeline.scan(sourceId); await f.advance(sourceId);
  const sampleTask = await f.task(sourceId, "测试电影.2026.mp4"), sample = await f.pipeline.preview({ taskId: sampleTask, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" }, includeAccessories: false });
  f.recognition.authorizeAutomatic({ id: rule.id, expectedVersion: rule.version, samplePreviewId: sample.id, accepted: true, requestKey: randomUUID() });
  for (let n = 0; n < 10; n++) await f.pipeline.tick();
  const candidate = f.pipeline.list({ sourceId }).items.find((row) => row.relativePath.endsWith("测试剧集.S01E01.mp4"))!, task = f.pipeline.task(candidate.taskId!);
  expect(task.state).toBe("DONE"); expect(task.matches[0]).toMatchObject({ evidence: "codex", codex: { mode: "cluster", confidence: 0.97 } });
  expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation WHERE task_id=?").get(task.taskId)).toEqual({ n: 1 });
});
it.each([
  { mode: "reliableDirectoryAutomaticallyOrganizesWithoutOpeningApproval", submitted: 3 },
  { mode: "targetConflictOnlyBlocksTheAffectedFile", submitted: 2 },
  { mode: "collidingTemplateBlocksAllFilesBeforeAnyMove", submitted: 0 },
  { mode: "lowTmdbConfidenceDoesNotBecomeAutomaticJustBecauseModelIsCertain", submitted: 0 },
  { mode: "lowModelConfidenceStaysForReviewWithSpecificReason", submitted: 0 },
  { mode: "jujutsuKaisenDirectoryUsesVerifiedSeasonAndRetainsAbsoluteEpisodeNumbers", submitted: 13 },
  { mode: "seasonMappingStillBlocksUnqueuedHashDuplicate", submitted: 1 },
  { mode: "retryOfPreviouslyMappedTaskStillDetectsSourceSeasonDuplicate", submitted: 0 },
])("迁移旧自动整理case：$mode", async ({ mode, submitted }) => {
  const mapped = /jujutsu|Mapped|seasonMapping/.test(mode), first = mapped ? 48 : 1, count = mode.startsWith("jujutsu") ? 13 : mapped ? 2 : 3;
  const codex = new CodexRecognition({ close: async () => {}, request: async (action, input) => ({ status: "identified", title: "测试剧集", year: 2026, type: "episode", season: mapped ? 3 : 1, episode: first,
    confidence: mode.startsWith("lowModel") ? 0.85 : 0.97, reason: "已核对剧集身份和原始累计集号", clustered: false,
    ...(action === "recognize-directory" ? { files: (input as { files: string[] }).files.map((filename) => ({ filename, season: mapped ? 3 : 1, episode: Number(/E(\d+)/i.exec(filename)![1]), episode_end: null })) } : {}) }) }, () => recognitionSettingsSchema.parse({ codexEnabled: true }));
  const f = await fixture(undefined, codex);
  await rm(join(f.input.path, "测试电影.2026.mp4")); await rm(join(f.input.path, "测试剧集.S01E01.mp4"));
  const names = Array.from({ length: count }, (_, n) => `测试剧集.S${mapped ? "03" : "01"}E${String(first + n).padStart(2, "0")}.mp4`);
  for (const name of names) await writeFile(join(f.input.path, name), f.bytes);
  if (mode.includes("Duplicate")) await writeFile(join(f.input.path, `测试剧集.S03E48-8930371d37e8.mp4`), f.bytes);
  await f.synchronize(); await f.advance();
  vi.mocked(f.connections.tmdb.episodes).mockResolvedValue(Array.from({ length: first + count }, (_, n) => ({ season: 1, episode: n + 1, title: `第${n + 1}集` })));
  const target = { ...f.tvTarget, ...(mode.startsWith("colliding") ? { template: "固定目标.{ext}" } : {}) };
  const rule = await f.enable(f.save(undefined, { input: { kind: "default" }, automatic: true, targets: [target] })), sourceId = rule.runtime!.sourceId!;
  await f.pipeline.scan(sourceId); await f.advance(sourceId);
  const tasks = new Map<string, string>(); for (const name of names) tasks.set(name, await f.task(sourceId, name));
  const anchor = tasks.get(names.at(-1)!)!, sample = await f.pipeline.preview({ taskId: anchor, requestKey: randomUUID(), selection: { tmdbId: 2, mediaType: "TV_SHOW", season: mapped ? 3 : 1, episode: first + count - 1 }, includeAccessories: false });
  f.recognition.authorizeAutomatic({ id: rule.id, expectedVersion: rule.version, samplePreviewId: sample.id, accepted: true, requestKey: randomUUID() });
  let occupied: string | undefined;
  if (mode.startsWith("targetConflict")) { const preview = await f.pipeline.preview({ taskId: tasks.get(names[1]!)!, requestKey: randomUUID(), selection: { tmdbId: 2, mediaType: "TV_SHOW", season: 1, episode: 2 }, includeAccessories: false }); occupied = preview.targetPath; await mkdir(dirname(occupied), { recursive: true }); await writeFile(occupied, "第三方文件"); }
  if (mode.startsWith("lowTmdb")) vi.mocked(f.connections.tmdb.search).mockResolvedValue([{ tmdbId: 2, mediaType: "TV_SHOW", title: "完全不同作品", originalTitle: null, year: 2000 }]);
  if (mode.startsWith("retryOf")) { const firstJob = f.pipeline.codexJobs.enqueue({ taskId: tasks.get(names[0]!)!, directory: true, organize: false, requestKey: randomUUID() }); await f.pipeline.codexJobs.tick(); expect(f.pipeline.codexJobs.get(firstJob.id).state).toBe("COMPLETED"); }
  const job = f.pipeline.codexJobs.enqueue({ taskId: mode.startsWith("retryOf") ? tasks.get(names[0]!)! : anchor, directory: !mode.startsWith("retryOf"), organize: true, requestKey: randomUUID() }); await f.pipeline.codexJobs.tick();
  const result = f.pipeline.codexJobs.get(job.id);
  expect(result.items.filter((item) => item.state === "SUBMITTED")).toHaveLength(submitted);
  expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: submitted });
  if (mode.includes("Duplicate")) expect(result.items.some((item) => item.failure?.includes("重复或重叠"))).toBe(true);
  if (mode.startsWith("lowModel")) expect(result.items.every((item) => item.failure?.includes("90%"))).toBe(true);
  if (mode.startsWith("lowTmdb")) expect(result.items.every((item) => item.failure?.includes("80%"))).toBe(true);
  if (mode.startsWith("colliding")) expect(result.items.every((item) => item.failure?.includes("目标路径"))).toBe(true);
  if (mapped && submitted) { expect(result.items.filter((item) => item.state === "SUBMITTED").every((item) => f.pipeline.task(item.taskId).matches[0]?.episodeCheck?.season === 1)).toBe(true); await f.pipeline.tick(); const done = result.items.find((item) => item.state === "SUBMITTED")!; const operation = f.db.connection.prepare("SELECT plan_json FROM ingestion_operation WHERE id=?").get(done.operationId) as { plan_json: string }; expect(JSON.parse(operation.plan_json).targetSegments.join("/")).toContain("Season 01"); expect(f.pipeline.task(done.taskId).parsed?.season).toBe(3); }
  if (occupied) expect(await readFile(occupied, "utf8")).toBe("第三方文件");
});
it("媒体目录列表标识当前设置，历史识别目标不冒充默认目录", async () => {
  const f = await fixture();
  await f.pipeline.authorizeLibrary({ mediaType: "MOVIE", target: f.movie });
  await f.pipeline.authorizeLibrary({ mediaType: "TV_SHOW", target: f.tv });
  const rule = await f.enable(f.save(undefined, { targets: [f.movieTarget, f.tvTarget] }));
  expect(f.pipeline.libraries()).toEqual(expect.arrayContaining([
    expect.objectContaining({ targetId: f.movie.id, configuredMediaTypes: ["MOVIE"] }),
    expect.objectContaining({ targetId: f.tv.id, configuredMediaTypes: ["TV_SHOW"] }),
  ]));
  expect(f.pipeline.libraries().some((row) => row.targetId === rule.snapshot!.configuration.targets[0]!.id)).toBe(false);
  await f.pipeline.authorizeLibrary({ mediaType: "MOVIE", target: f.secondMovie });
  expect(f.pipeline.libraries().find((row) => row.targetId === f.secondMovie.id)!.configuredMediaTypes).toEqual(["MOVIE"]);
  expect(f.pipeline.libraries().find((row) => row.targetId === f.movieTarget.id)!.configuredMediaTypes).toBeUndefined();
});
it("普通已有目录可以先空目标识别，再混合电影与剧集分库，不要求同步或 Emby", async () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const f = await fixture(logger); let rule = await f.enable(f.save()); const sourceId = rule.runtime!.sourceId!; await f.pipeline.scan(sourceId); await f.advance(sourceId);
  expect(new CoreService(f.db).getRuntime()).toMatchObject({ sourceCount: 0, recognitionCount: 1 });
  const movieTask = await f.task(sourceId, "测试电影.2026.mp4"), tvTask = await f.task(sourceId, "测试剧集.S01E01.mp4");
  expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: "recognition.mapping.confirmed", ruleId: rule.id, version: rule.version }), expect.any(String));
  expect(logger.info).toHaveBeenCalledWith(expect.objectContaining({ event: "recognition.task.matched", sourceId, taskId: movieTask, matchCount: expect.any(Number) }), expect.any(String));
  await expect(f.pipeline.preview({ taskId: movieTask, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" }, includeAccessories: false })).rejects.toThrow(/没有.*目标/);
  rule = await f.enable(f.save(rule, { targets: [f.movieTarget, f.tvTarget] })); await f.advance(sourceId);
  const movie = await f.pipeline.preview({ taskId: movieTask, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" }, includeAccessories: false }), tv = await f.pipeline.preview({ taskId: tvTask, requestKey: randomUUID(), selection: { tmdbId: 2, mediaType: "TV_SHOW", season: 1, episode: 1 }, includeAccessories: false });
  expect(movie.targetPath).toBe(join(f.movie.path, "测试电影/测试电影.mp4")); expect(tv.targetPath.startsWith(f.tv.path + "/")).toBe(true); await f.pipeline.confirm({ previewId: movie.id, requestKey: randomUUID() }); await f.pipeline.confirm({ previewId: tv.id, requestKey: randomUUID() }); await f.pipeline.tick();
  expect(new CoreService(f.db).listTasks({ page: 1, pageSize: 25 }).items.every((task) => task.recognitionRuleId === rule.id)).toBe(true);
  expect(await readFile(movie.targetPath, "utf8")).toBe(f.bytes); expect(await readFile(tv.targetPath, "utf8")).toBe(f.bytes); expect(await readFile(join(f.input.path, "测试电影.2026.mp4"), "utf8")).toBe(f.bytes); expect(f.db.connection.prepare("SELECT count(*) AS n FROM sync_job").get()).toEqual({ n: 0 });
});
it("同类型多个 target 不按保存顺序猜测；人工选择及规则编辑使未确认预览过期", async () => {
  const f = await fixture(), second = { ...f.movieTarget, id: randomUUID(), name: "第二电影库", directoryId: f.secondMovie.id }; let rule = await f.enable(f.save(undefined, { targets: [second, f.movieTarget] })); const sourceId = rule.runtime!.sourceId!; await f.pipeline.scan(sourceId); await f.advance(sourceId); const taskId = await f.task(sourceId, "测试电影.2026.mp4");
  await expect(f.pipeline.preview({ taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" }, includeAccessories: false })).rejects.toThrow(/匹配 2/);
  const preview = await f.pipeline.preview({ taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE", targetId: f.movieTarget.id }, includeAccessories: false }); expect(preview.targetPath.startsWith(f.movie.path + "/")).toBe(true);
  rule = await f.enable(f.save(rule, { targets: [second] })); await expect(f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() })).rejects.toThrow(/变化|预览/); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
});
it("受管输入只接收真实本地同步成果，外部／暂存文件排除，暂停同步不暂停识别", async () => {
  const f = await fixture(); const draft = f.sync.save({ id: randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, expectedLifecycleRevision: 0, requestKey: randomUUID(), configuration: { name: "无账号同步", type: "local", inputDirectoryId: f.input.id } });
  const configuration = await f.sync.preview({ ...versions(draft), requestKey: randomUUID() }), active = (await f.sync.confirm({ previewId: configuration.id, requestKey: randomUUID() })).rule; await f.advance(); const execution = await f.sync.preview({ ...versions(active), requestKey: randomUUID(), mode: "execution" }); await f.sync.confirm({ previewId: execution.id, requestKey: randomUUID(), filesComplete: true }); await f.sync.tick();
  await writeFile(join(f.download.path, "completed/外部文件.mp4"), f.bytes); await writeFile(join(f.download.path, "外部根文件.mp4"), f.bytes);
  const rule = await f.enable(f.save(undefined, { input: { kind: "default" }, targets: [f.movieTarget, f.tvTarget] })), sourceId = rule.runtime!.sourceId!;
  expect(f.sync.jobs({}).items[0]!.recognition).toEqual({ state: "ENABLED", ruleId: rule.id });
  expect(new CoreService(f.db).getRuntime()).toMatchObject({ sourceCount: 1, recognitionCount: 1 });
  expect(() => f.pipeline.reviewContent({ sourceId, requestKey: randomUUID() })).toThrow(/受管输入|普通已有目录/);
  await Promise.all([f.pipeline.scan(sourceId), f.pipeline.scan(sourceId)]); expect(f.pipeline.list({ sourceId }).total).toBe(2); expect(f.db.connection.prepare("SELECT count(*) AS n FROM recognition_receipt WHERE state='ACCEPTED'").get()).toEqual({ n: 2 });
  await f.sync.control({ ...versions(active), requestKey: randomUUID(), operation: "pause" }); await f.advance(sourceId); expect(f.recognition.get(rule.id).paused).toBe(false); expect(f.pipeline.list({ sourceId }).items.every((row) => row.state === "READY")).toBe(true);
  await rm(join(f.download.path, "completed/测试电影.2026.mp4")); await f.pipeline.scan(sourceId); expect(f.recognition.get(rule.id).runtime!.unavailableInputs).toBe(1); expect(f.sync.jobs({}).total).toBe(1); expect(f.pipeline.list({ sourceId }).total).toBe(2);
  const paused = await f.recognition.control({ ...versions(rule), requestKey: randomUUID(), operation: "pause" }); await f.sync.control({ ...versions(f.sync.get(active.id)), requestKey: randomUUID(), operation: "resume" }); expect(f.recognition.get(rule.id).paused).toBe(true); expect(f.sync.jobs({}).items[0]!.recognition).toEqual({ state: "PAUSED", ruleId: rule.id }); await f.recognition.control({ ...versions(paused), requestKey: randomUUID(), operation: "resume" });
});
it("本地同步的暂存回收失败单独记账，成功收据与同步状态保留，重试只回收所属目录", async () => {
  const f = await fixture(), root = f.roots.files.get(f.download.id);
  vi.spyOn(root, "cleanupAttempt").mockRejectedValueOnce(Object.assign(new Error("隔离权限故障"), { code: "EACCES" })); await f.synchronize();
  const row = f.db.connection.prepare("SELECT owner_id,attempt_id,state,retained_bytes FROM owned_attempt_cleanup WHERE owner_kind='local_sync_operation' AND state='NEEDS_ATTENTION'").get() as { owner_id: string; attempt_id: string; state: string; retained_bytes: number };
  expect(row).toBeDefined(); expect(row.retained_bytes).toBe(Buffer.byteLength(f.bytes)); expect(f.sync.jobs({}).items[0]!.state).toBe("DONE");
  expect(f.db.connection.prepare("SELECT count(*) AS n FROM sync_receipt").get()).toEqual({ n: 2 }); await new OwnedAttemptCleanup(f.db).run("local_sync_operation", row.owner_id, root);
  expect(f.db.connection.prepare("SELECT state FROM owned_attempt_cleanup WHERE owner_kind='local_sync_operation' AND owner_id=?").get(row.owner_id)).toEqual({ state: "DONE" }); expect(await readFile(join(f.input.path, "测试电影.2026.mp4"), "utf8")).toBe(f.bytes);
});
it("受管图片父目录缺失时逐项说明原因，恢复后重新补扫成功且不重复接入", async () => {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const f = await fixture(logger), names = ["logo.png", "thumb.jpg", "banner.jpg", "fanart.jpg", "poster.jpg"];
  await mkdir(join(f.input.path, "附属图片"));
  for (const name of names) await writeFile(join(f.input.path, "附属图片", name), `真实附属文件：${name}`);
  await f.synchronize(); await f.advance();
  const original = join(f.download.path, "completed", "附属图片"), retained = join(f.folder, "暂时移开的图片");
  await rename(original, retained);
  const rule = await f.enable(f.save(undefined, { input: { kind: "default" }, targets: [f.movieTarget, f.tvTarget] })), sourceId = rule.runtime!.sourceId!;
  const job = f.recognition.scan({ ...versions(rule), requestKey: randomUUID() }); await f.recognition.scans.idle();
  const details = f.recognition.scans.get({ id: job.id });
  expect(details.job).toMatchObject({ state: "PARTIAL_FAILED", discovered: 2, failed: 5 });
  expect(details.issues).toEqual(names.slice().sort().map((name) => ({ relativePath: `completed/附属图片/${name}`, failure: expect.stringMatching(/文件或其父目录已不存在.*不会自动重新下载/) })));
  expect(f.db.connection.prepare("SELECT count(*) AS n FROM recognition_receipt WHERE state='UNAVAILABLE' AND failure LIKE '%父目录已不存在%'").get()).toEqual({ n: 5 });
  expect(logger.warn).toHaveBeenCalledWith(expect.objectContaining({ event: "recognition.scan.file-failed", sourceId, relativePath: "completed/附属图片/logo.png", error: expect.objectContaining({ code: "ENOENT" }) }), expect.any(String));
  await rename(retained, original);
  for (let pass = 0; pass < 2; pass++) {
    const retry = f.recognition.scan({ ...versions(rule), requestKey: randomUUID() }); await f.recognition.scans.idle();
    expect(f.recognition.scans.get({ id: retry.id })).toMatchObject({ job: { state: "COMPLETED", discovered: 7, failed: 0 }, issues: [] });
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM recognition_receipt WHERE state='ACCEPTED'").get()).toEqual({ n: 7 });
    expect(f.pipeline.list({ sourceId }).total).toBe(7);
  }
});
it("受管原件主动清理后补扫保留已交付候选，普通再次同步沿用成功收据而不补回", async () => {
  const f = await fixture(), sync = await f.synchronize(), rule = await f.enable(f.save(undefined, { input: { kind: "default" }, targets: [f.movieTarget, f.tvTarget] })), sourceId = rule.runtime!.sourceId!;
  await f.pipeline.scan(sourceId); await f.advance(sourceId); const taskId = await f.task(sourceId, "测试电影.2026.mp4");
  const preview = await f.pipeline.preview({ taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" }, includeAccessories: false }); await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); await f.pipeline.tick();
  expect(f.pipeline.task(taskId).state).toBe("DONE");
  const operation = f.db.connection.prepare("SELECT plan_json FROM ingestion_operation WHERE task_id=?").get(taskId) as { plan_json: string }, plan = JSON.parse(operation.plan_json);
  const receipt = f.db.connection.prepare("SELECT r.id,e.evidence_json FROM sync_receipt r JOIN sync_receipt_evidence e ON e.receipt_id=r.id WHERE r.target_directory_id=? AND r.target_segments_json=?").get(f.download.id, JSON.stringify(plan.sourceSegments.slice(1))) as { id: string; evidence_json: string };
  const target = (await f.pipeline.targets.get(plan.target.id).inspectForRelocation(plan.targetSegments)).evidence;
  // 下游投影回归：模拟清理所有者已持久记账的事实，真实删除协议另由原生强杀测试覆盖。
  const journal = new DownloadCleanupJournal(f.db), cleanup = journal.create(receipt.id, taskId, { source: { grant: plan.source, segments: plan.sourceSegments, evidence: JSON.parse(receipt.evidence_json) }, target: { grant: plan.target, segments: plan.targetSegments, evidence: target }, targetId: plan.target.id, binding: "隔离下游事实夹具", connectionId: randomUUID(), connectionVersion: 1, authorization: "ORGANIZE" });
  journal.advance(cleanup.id, "PENDING", "CLAIMED"); journal.advance(cleanup.id, "CLAIMED", "QUARANTINED"); journal.advance(cleanup.id, "QUARANTINED", "REMOVING");
  await rm(preview.sourcePath); journal.advance(cleanup.id, "REMOVING", "SOURCE_REMOVED"); journal.advance(cleanup.id, "SOURCE_REMOVED", "CACHE_PENDING"); journal.advance(cleanup.id, "CACHE_PENDING", "DONE");
  await f.pipeline.scan(sourceId); expect(f.pipeline.task(taskId).state).toBe("DONE"); expect(f.recognition.get(rule.id).runtime!.unavailableInputs).toBe(0);
  expect(f.db.connection.prepare("SELECT state FROM recognition_receipt WHERE receipt_id=?").get(receipt.id)).toEqual({ state: "ACCEPTED" });
  const next = await f.sync.preview({ ...versions(sync), requestKey: randomUUID(), mode: "execution" }); expect(next.removed).toBe(1); expect(next.conflicts).toBe(0);
  await f.sync.confirm({ previewId: next.id, requestKey: randomUUID(), filesComplete: true }); await f.sync.tick(); await expect(readFile(preview.sourcePath)).rejects.toMatchObject({ code: "ENOENT" }); expect(await readFile(preview.targetPath, "utf8")).toBe(f.bytes);
});
it("已受理 COPY 冻结原目标，改规则与全局暂停不替换计划，恢复后复制原位置", async () => {
  const f = await fixture(); let rule = await f.enable(f.save(undefined, { targets: [f.movieTarget] })); const sourceId = rule.runtime!.sourceId!; await f.pipeline.scan(sourceId); await f.advance(sourceId); const taskId = await f.task(sourceId, "测试电影.2026.mp4");
  const preview = await f.pipeline.preview({ taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" }, includeAccessories: false });
  await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); f.pipeline.setPaused({ paused: true, requestKey: randomUUID() }); await f.pipeline.tick();
  const before = f.db.connection.prepare("SELECT plan_json FROM ingestion_operation").get() as { plan_json: string };
  rule = await f.enable(f.save(rule, { targets: [{ ...f.movieTarget, id: randomUUID(), directoryId: f.secondMovie.id }] })); expect(rule.snapshot!.targets[0]!.directory.id).toBe(f.secondMovie.id); expect(f.db.connection.prepare("SELECT plan_json FROM ingestion_operation").get()).toEqual(before);
  const paused = await f.recognition.control({ ...versions(rule), requestKey: randomUUID(), operation: "pause" }); await f.recognition.control({ ...versions(paused), requestKey: randomUUID(), operation: "resume" }); expect(f.pipeline.pauseStatus().paused).toBe(true);
  f.pipeline.setPaused({ paused: false, requestKey: randomUUID() }); await f.advance(sourceId); await f.pipeline.tick(); expect(f.pipeline.task(taskId).state).toBe("DONE"); expect(await readFile(preview.targetPath, "utf8")).toBe(f.bytes); await expect(readFile(join(f.secondMovie.path, "测试电影/测试电影.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("手动重试沿已受理计划恢复，不被规则的新输入或目标替换", async () => {
  const f = await fixture(); let rule = await f.enable(f.save(undefined, { targets: [f.movieTarget] })); const sourceId = rule.runtime!.sourceId!;
  await f.pipeline.scan(sourceId); await f.advance(sourceId); const taskId = await f.task(sourceId, "测试电影.2026.mp4");
  const preview = await f.pipeline.preview({ taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" }, includeAccessories: false });
  await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); f.pipeline.setPaused({ paused: true, requestKey: randomUUID() }); await f.pipeline.tick();
  rule = await f.enable(f.save(rule, { input: { kind: "default" }, targets: [{ ...f.movieTarget, id: randomUUID(), directoryId: f.secondMovie.id }] }));
  expect(() => f.pipeline.retry(taskId)).toThrow(/全局整理已暂停/);
  f.pipeline.setPaused({ paused: false, requestKey: randomUUID() }); expect(() => f.pipeline.retry(taskId)).not.toThrow();
  for (let i = 0; i < 14; i++) { await f.advance(undefined, 10); await f.pipeline.tick(); }
  expect(f.pipeline.task(taskId).state).toBe("DONE"); expect(await readFile(preview.targetPath, "utf8")).toBe(f.bytes);
  await expect(readFile(join(f.secondMovie.path, "测试电影/测试电影.mp4"))).rejects.toMatchObject({ code: "ENOENT" });
});
it("活动 COPY 须先暂停到安全点；删除、恢复和重置保留原计划、版本及媒体文件", async () => {
  const f = await fixture(); let rule = await f.enable(f.save(undefined, { targets: [f.movieTarget] })); const sourceId = rule.runtime!.sourceId!;
  await f.pipeline.scan(sourceId); await f.advance(sourceId); const taskId = await f.task(sourceId, "测试电影.2026.mp4");
  const preview = await f.pipeline.preview({ taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" }, includeAccessories: false });
  const entered = Promise.withResolvers<void>(), released = Promise.withResolvers<void>(), original = SourceRoot.prototype.digest;
  const spy = vi.spyOn(SourceRoot.prototype, "digest").mockImplementation(async function (this: SourceRoot, ...args) { if (args[3]) { entered.resolve(); await released.promise; } return original.apply(this, args); });
  await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() }); const copying = f.pipeline.tick(); await entered.promise;
  try {
    await expect(f.recognition.control({ ...versions(rule), operation: "remove", requestKey: randomUUID() })).rejects.toThrow(/先暂停/);
    const draft = f.save(rule, { name: "活动时编辑的草稿" }); await expect(f.enable(draft)).rejects.toThrow(/活动文件操作/); rule = draft;
    rule = await f.recognition.control({ ...versions(rule), operation: "pause", requestKey: randomUUID() });
    await expect(f.recognition.control({ ...versions(rule), operation: "remove", requestKey: randomUUID() })).rejects.toThrow(/活动文件操作/);
  } finally { released.resolve(); await copying; spy.mockRestore(); }
  const plan = f.db.connection.prepare("SELECT id,plan_json FROM ingestion_operation").get();
  const command = { ...versions(rule), operation: "remove" as const, requestKey: randomUUID() }; rule = await f.recognition.control(command); expect(await f.recognition.control(command)).toEqual(rule);
  rule = await f.recognition.control({ ...versions(rule), operation: "restore", requestKey: randomUUID() }); expect(rule.paused).toBe(true); expect(rule.deletedAt).toBeNull();
  rule = await f.recognition.control({ ...versions(rule), operation: "reset", requestKey: randomUUID() }); expect(rule.draft.name).toBe("独立混合识别"); expect(rule.version).toBe(1);
  expect(f.db.connection.prepare("SELECT id,plan_json FROM ingestion_operation").get()).toEqual(plan); expect(await readFile(join(f.input.path, "测试电影.2026.mp4"), "utf8")).toBe(f.bytes); await expect(readFile(preview.targetPath)).rejects.toMatchObject({ code: "ENOENT" });
});
it("自动策略须按规则版本核对首次样本；普通目录保持人工，正式成果可自动分库", async () => {
  const f = await fixture(); await f.synchronize(); let rule = await f.enable(f.save(undefined, { input: { kind: "default" }, automatic: true, targets: [f.movieTarget, f.tvTarget] })); const sourceId = rule.runtime!.sourceId!;
  await f.pipeline.scan(sourceId); await f.advance(sourceId); await f.pipeline.tick(); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_automatic").get()).toEqual({ n: 0 });
  const taskId = await f.task(sourceId, "测试电影.2026.mp4"), sample = await f.pipeline.preview({ taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" }, includeAccessories: false });
  const input = { id: rule.id, expectedVersion: rule.version, samplePreviewId: sample.id, accepted: true as const, requestKey: randomUUID() }; rule = f.recognition.authorizeAutomatic(input); expect(f.recognition.authorizeAutomatic(input)).toEqual(rule); expect(rule.runtime!.automaticAuthorized).toBe(true);
  expect(new CoreService(f.db).getRuntime().mode).toBe("automatic-enabled");
  for (let i = 0; i < 4; i++) await f.pipeline.tick(); const television = f.pipeline.list({ sourceId }).items.find((row) => row.relativePath.endsWith("测试剧集.S01E01.mp4"))!;
  expect(television.automation).toMatchObject({ state: "SUBMITTED", operationId: expect.any(String) }); expect(f.pipeline.task(television.taskId!).state).toBe("DONE"); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 1 });
  const changed = await f.enable(f.save(rule, { name: "相同输入，重新确认策略版本" })); expect(changed.runtime!.automaticAuthorized).toBe(false); expect(() => f.recognition.authorizeAutomatic({ ...input, expectedVersion: changed.version, requestKey: randomUUID() })).toThrow(/预览.*不一致|变化/);
  expect(new CoreService(f.db).getRuntime().mode).toBe("manual-only");
});
it("本地普通客户端即使明确授权自动策略，仍因缺乏可信完成规则转人工", async () => {
  const f = await fixture(), rule = await f.enable(f.save(undefined, { automatic: true, targets: [f.movieTarget, f.tvTarget] })), sourceId = rule.runtime!.sourceId!; await f.pipeline.scan(sourceId); await f.advance(sourceId); const taskId = await f.task(sourceId, "测试电影.2026.mp4"), sample = await f.pipeline.preview({ taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" }, includeAccessories: false });
  f.recognition.authorizeAutomatic({ id: rule.id, expectedVersion: rule.version, samplePreviewId: sample.id, accepted: true, requestKey: randomUUID() }); await f.pipeline.tick(); const tv = f.pipeline.list({ sourceId }).items.find((row) => row.relativePath.endsWith("测试剧集.S01E01.mp4"))!; expect(tv.automation).toMatchObject({ state: "NEEDS_REVIEW", reason: expect.stringContaining("普通目录") }); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 0 });
});
it("暂停中的持久补扫保持原作业，恢复后继续，不因暂停修订误判为配置替换", async () => {
  const f = await fixture(), rule = await f.enable(f.save()), original = f.pipeline.scan.bind(f.pipeline); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { entered = resolve; }); let first = true;
  vi.spyOn(f.pipeline, "scan").mockImplementation(async (id) => { if (first) { first = false; entered(); await gate; } return original(id); });
  const scan = f.recognition.scan({ ...versions(rule), requestKey: randomUUID() }); await ready; const paused = await f.recognition.control({ ...versions(rule), requestKey: randomUUID(), operation: "pause" }); release(); await f.recognition.scans.idle(); expect(f.recognition.scans.get({ id: scan.id }).job.state).toBe("WAITING_SOURCE");
  await f.recognition.control({ ...versions(paused), requestKey: randomUUID(), operation: "resume" }); await f.recognition.scans.idle(); expect(f.recognition.scans.get({ id: scan.id }).job).toMatchObject({ id: scan.id, state: "COMPLETED", discovered: 2, ownerKind: "recognition" }); expect(f.recognition.scans.list({}).total).toBe(1);
});
it("同步和识别并发确认时，在事务提交前重新核对目录图，不能交错启用循环", async () => {
  const f = await fixture(), recognition = f.save(undefined, { input: { kind: "default" }, targets: [f.movieTarget] }), preview = await f.recognition.preview({ ...versions(recognition), requestKey: randomUUID() });
  const sync = f.sync.save({ id: randomUUID(), expectedVersion: 0, expectedDraftRevision: 0, expectedLifecycleRevision: 0, requestKey: randomUUID(), configuration: { type: "local", name: "媒体回流", inputDirectoryId: f.movie.id } }), syncPreview = await f.sync.preview({ ...versions(sync), requestKey: randomUUID() });
  const original = f.pipeline.prepareRecognitionInput.bind(f.pipeline); let release!: () => void, entered!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }), ready = new Promise<void>((resolve) => { entered = resolve; });
  vi.spyOn(f.pipeline, "prepareRecognitionInput").mockImplementation(async (...args) => { const prepared = await original(...args); entered(); await gate; return prepared; });
  const flight = f.recognition.confirm({ previewId: preview.id, requestKey: randomUUID() }); await ready; await f.sync.confirm({ previewId: syncPreview.id, requestKey: randomUUID() }); release(); await expect(flight).rejects.toThrow(/循环/); expect(f.recognition.get(recognition.id).version).toBe(0); expect(f.sync.get(sync.id).version).toBe(1);
});

it("设置切换统一识别输入，已受理 COPY 保留原路径，设置重试不重复追加规则版本", async () => {
  const f = await fixture(); await f.synchronize();
  const rule = await f.enable(f.save(undefined, { input: { kind: "default" }, targets: [f.movieTarget] }));
  const sourceId = rule.runtime!.sourceId!; await f.advance(sourceId);
  const taskId = await f.task(sourceId, "测试电影.2026.mp4");
  const preview = await f.pipeline.preview({ taskId, requestKey: randomUUID(), selection: { tmdbId: 1, mediaType: "MOVIE" }, includeAccessories: false });
  await f.pipeline.confirm({ previewId: preview.id, requestKey: randomUUID() });
  f.pipeline.setPaused({ paused: true, requestKey: randomUUID() }); await f.pipeline.tick();
  const before = f.db.connection.prepare("SELECT plan_json FROM ingestion_operation").get();
  const next = await f.grant("新的公共下载目录", "managed"), command = { expectedVersion: 1, directoryId: next.id, requestKey: randomUUID() };
  const saved = await f.recognition.setDownloadDirectory(command); expect(await f.recognition.setDownloadDirectory(command)).toEqual(saved);
  const changed = f.recognition.get(rule.id); expect(changed.version).toBe(rule.version + 1);
  expect(changed.snapshot).toMatchObject({ inputDirectory: { id: next.id }, inputMode: "managed-completed", defaultDirectoryVersion: 2 });
  expect(changed.runtime!.sourceId).not.toBe(sourceId);
  expect(f.db.connection.prepare("SELECT plan_json FROM ingestion_operation").get()).toEqual(before);
  f.pipeline.setPaused({ paused: false, requestKey: randomUUID() }); for (let i = 0; i < 14; i++) { await f.advance(undefined, 10); await f.pipeline.tick(); } expect(f.pipeline.task(taskId)).toMatchObject({ state: "DONE" }); expect(await readFile(preview.targetPath, "utf8")).toBe(f.bytes);
});
it("设置切换失败原子保留原目录和识别版本，清除设置停止新接入", async () => {
  const f = await fixture(), rule = await f.enable(f.save(undefined, { input: { kind: "default" }, targets: [f.movieTarget] }));
  await expect(f.recognition.setDownloadDirectory({ expectedVersion: 1, directoryId: f.movie.id, requestKey: randomUUID() })).rejects.toThrow(/下载目录/);
  expect(f.directories.defaults().directory!.id).toBe(f.download.id); expect(f.recognition.get(rule.id).version).toBe(rule.version);
  await f.recognition.setDownloadDirectory({ expectedVersion: 1, directoryId: null, requestKey: randomUUID() });
  expect(f.recognition.get(rule.id).runtime!.sourceId).toBeNull();
  expect(() => f.recognition.scan({ ...versions(rule), requestKey: randomUUID() })).toThrow();
});

it("启用识别后仍可重新授权同一个公共下载根，识别完成区不误判为外部来源重叠", async () => {
  const f = await fixture(); await f.enable(f.save(undefined, { input: { kind: "default" }, targets: [f.movieTarget] }));
  await expect(f.directories.authorize(f.download, "managed")).resolves.toMatchObject({ id: f.download.id, path: f.download.path });
});
