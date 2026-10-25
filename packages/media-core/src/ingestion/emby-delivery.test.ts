import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, lstat, statfs, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { CoreDatabase } from "../infrastructure/database";
import { ManagedRoots } from "../files/index";
import { MediaConnections } from "../application/media-connections";
import { EmbyDelivery } from "./emby-delivery";
import { EmbyClient, type EmbyItem } from "../infrastructure/emby";
import type { ManagedRootGrant } from "@media-marshal/contracts/internal";
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(options: { mediaType?: "AUTO" | "MOVIE" | "TV_SHOW"; subdirectory?: string } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "marshal-emby-delivery-"))); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const libraryPath = join(directory, "媒体库"); await mkdir(libraryPath);
  const existingMedia = join(libraryPath, "原有媒体.mp4"); await writeFile(existingMedia, "原有媒体保持原状");
  const path = options.subdirectory ? join(libraryPath, options.subdirectory) : libraryPath; if (options.subdirectory) await mkdir(path);
  const info = await lstat(path, { bigint: true }), fs = await statfs(path, { bigint: true });
  const grant: ManagedRootGrant = { id: randomUUID(), path, volume: { volumeId: randomUUID(), rootInode: String(info.ino), rootBirthtimeNs: String(info.birthtimeNs), observedDevice: String(info.dev), fsTypeCode: String(fs.type), fsType: "test-local", caseSensitive: true, unicodeEquivalent: true, pathMaxBytes: 4096 } };
  const roots = new ManagedRoots("direct"); await roots.install(grant); cleanup.push(() => roots.close());
  let clock = Date.now(), refreshes = 0, status = 200, serverId = "fixture-server-id", pages = 0, requests = 0, libraryType: string | null = null, listedPaths = [libraryPath], readStatus = 200, refreshStatus = 204; let items: EmbyItem[] = [], seriesItems: EmbyItem[] | undefined;
  const server = http.createServer((req, res) => { requests++; const url = new URL(req.url!, "http://localhost"); if (req.headers["x-emby-token"] !== "fixture-emby-private-key") { res.writeHead(401).end("fixture-emby-private-key"); return; } if (status !== 200) { res.writeHead(status).end("fixture-server-private-error"); return; }
    if (url.pathname === "/System/Info") res.end(JSON.stringify({ Id: serverId, Version: "4.9-fixture", ProgramDataPath: "/private/not-returned" }));
    else if (url.pathname === "/Library/VirtualFolders/Query") res.end(JSON.stringify({ Items: [{ ItemId: "library-1", Name: "测试库", Locations: listedPaths, CollectionType: libraryType }], TotalRecordCount: 1 }));
    else if (url.pathname === "/Library/Refresh") { if (refreshStatus !== 204) { res.writeHead(refreshStatus).end(); return; } refreshes++; res.writeHead(204).end(); }
    else if (url.pathname === "/Items") { if (readStatus !== 200) { res.writeHead(readStatus).end(); return; } pages++; const wanted = url.searchParams.get("Ids"), start = Number(url.searchParams.get("StartIndex") ?? 0), result = wanted ? seriesItems ?? [{ Id: "series-1", Type: "Series", ProviderIds: { Tmdb: "2" } }] : items; res.end(JSON.stringify({ Items: result.slice(start, start + 200), TotalRecordCount: result.length })); }
    else res.writeHead(404).end("{}");
  }); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const settings = { language: "zh-CN" as const, embyUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, tmdbProxy: "http://127.0.0.1:1" }, db = await CoreDatabase.open(join(directory, "core.sqlite3")); cleanup.push(() => db.close());
  db.connection.prepare("INSERT INTO media_target_root VALUES(?,?,1)").run(grant.id, JSON.stringify(grant));
  const connections = new MediaConnections(db, () => settings); connections.install({ tmdb: null, emby: "fixture-emby-private-key" }); cleanup.push(() => connections.close());
  const pipeline = { targets: roots, libraries: () => [{ mediaType: options.mediaType ?? "MOVIE", targetId: grant.id, path, available: true }] };
  const delivery = new EmbyDelivery(db, connections, () => settings, pipeline, () => clock); cleanup.push(() => delivery.close());
  const configure = () => delivery.connect({ serverId: "fixture-server-id", libraries: [{ targetId: grant.id, libraryId: "library-1", libraryPath }] });
  const add = async (type: "MOVIE" | "TV_SHOW" = "MOVIE") => {
    const root = roots.get(grant.id), attempt = randomUUID(), taskId = randomUUID(), candidateId = randomUUID(), operationId = randomUUID(), segments = ["测试-" + taskId + ".mp4"];
    await root.prepareStage(attempt); await writeFile(await root.stageFilePath(attempt, segments), "fixture-video"); const proof = await root.verifyStage(attempt, segments, 13), commit = await root.commit(attempt, segments, proof); await root.cleanupAttempt(attempt);
    const sourceId = randomUUID(), stamp = new Date(clock).toISOString(), plan = { targetSegments: segments, selection: { tmdbId: type === "MOVIE" ? 1 : 2, mediaType: type, season: type === "MOVIE" ? null : 3, episode: type === "MOVIE" ? null : 4, episodeEnd: null } };
    db.connection.prepare("INSERT INTO desktop_source(id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES(?,'test','custom',?,?,'AUTO','COPY',?)").run(sourceId, join(directory, sourceId), path, stamp);
    db.connection.prepare("INSERT INTO media_task(id,source_id,source_path,status,delivery_status,target_path,created_at,updated_at) VALUES(?,?,?,'DONE','REFRESH_PENDING',?,?,?)").run(taskId, sourceId, join(directory, sourceId), commit.path, stamp, stamp);
    db.connection.prepare("INSERT INTO ingestion_candidate(id,source_id,relative_json,version_key,snapshot_json,state,task_id,created_at,updated_at) VALUES(?,?,'[]',?,'{}','PROCESSED',?,?,?)").run(candidateId, sourceId, randomUUID(), taskId, stamp, stamp);
    db.connection.prepare("INSERT INTO ingestion_operation(id,candidate_id,task_id,request_key,target_root_id,target_slot,plan_json,attempt_id,phase,evidence_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'RECORDED',?,?,?)").run(operationId, candidateId, taskId, randomUUID(), grant.id, root.slotKey(segments), JSON.stringify(plan), attempt, JSON.stringify(proof), stamp, stamp);
    const connection = db.connection.prepare("SELECT id,version FROM emby_connection").get() as { id: string; version: number };
    db.connection.prepare("INSERT INTO emby_delivery(task_id,operation_id,connection_id,connection_version,state,next_attempt_at,updated_at) VALUES(?,?,?,?,'REFRESH_PENDING',?,?)").run(taskId, operationId, connection.id, connection.version, clock + 30000, stamp);
    return { taskId, path: commit.path, type };
  };
  const state = (taskId: string) => db.connection.prepare("SELECT state,last_failure,next_attempt_at FROM emby_delivery WHERE task_id=?").get(taskId) as { state: string; last_failure: string | null; next_attempt_at: number };
  const restored = () => { const value = new EmbyDelivery(db, connections, () => settings, pipeline, () => clock); cleanup.push(() => value.close()); return value; };
  return { directory, path, libraryPath, existingMedia, db, delivery, configure, add, state, restored, setItems(value: EmbyItem[]) { items = value; }, setSeries(value: EmbyItem[]) { seriesItems = value; }, setStatus(code: number) { status = code; }, setPermission(kind: "read" | "refresh", code: number) { if (kind === "read") readStatus = code; else refreshStatus = code; }, setLibraryType(type: string | null) { libraryType = type; }, setLibraryPaths(paths: string[]) { listedPaths = paths; }, setServerId(id: string) { serverId = id; }, refreshes: () => refreshes, requests: () => requests, pages: () => pages, jump(ms: number) { clock += ms; }, pipeline, connections, settings };
}
describe("独立 Emby 交付、合并与核对", () => {
  it("复核的合并刷新只推进已到期交付，不解除其他任务的持久退避", async () => {
    const f = await fixture(); await f.configure(); const a = await f.add(), b = await f.add();
    f.db.connection.prepare("UPDATE emby_delivery SET last_failure='NETWORK_UNAVAILABLE',next_attempt_at=next_attempt_at+300000 WHERE task_id=?").run(b.taskId);
    const deferred = f.state(b.taskId).next_attempt_at; await f.delivery.close(); const restored = f.restored(); f.jump(30000); await restored.tick();
    expect(f.state(a.taskId).state).toBe("WAITING_LIBRARY");
    expect(f.state(b.taskId)).toMatchObject({ state: "REFRESH_PENDING", next_attempt_at: deferred, last_failure: "NETWORK_UNAVAILABLE" });
  });
  it("离线退避跨进程重建保留，到期复核刷新与批量交付合并为一次", async () => {
    const f = await fixture(); await f.configure(); const a = await f.add(), b = await f.add();
    f.setStatus(503); f.jump(30000); await f.delivery.tick();
    const due = f.state(a.taskId).next_attempt_at, requests = f.requests(), refreshes = f.refreshes();
    await f.delivery.close(); const restored = f.restored();
    await restored.tick(); f.jump(29999); await restored.tick(); expect(f.requests()).toBe(requests);
    expect(f.state(a.taskId).next_attempt_at).toBe(due);
    f.setStatus(200); f.jump(1); await restored.tick();
    expect(f.refreshes() - refreshes).toBe(1);
    expect(f.state(a.taskId).state).toBe("WAITING_LIBRARY"); expect(f.state(b.taskId).state).toBe("WAITING_LIBRARY");
    expect(f.db.connection.prepare("SELECT status FROM media_task").all()).toEqual([{ status: "DONE" }, { status: "DONE" }]);
  });
  it("已发送刷新后立即重启，持久合并窗口阻止再次刷新，到期后继续原收录核对", async () => {
    const f = await fixture(); await f.configure(); const item = await f.add(); f.jump(30000); await f.delivery.tick();
    const refreshes = f.refreshes(), requests = f.requests(); await f.delivery.close(); const restored = f.restored();
    await restored.tick(); expect(f.requests()).toBe(requests); f.jump(29999); await restored.tick(); expect(f.refreshes()).toBe(refreshes);
    f.setItems([{ Id: "collected", Type: "Movie", Path: item.path, ProviderIds: { Tmdb: "1" } }]);
    f.jump(1); await restored.tick(); expect(f.refreshes()).toBe(refreshes + 1); expect(f.state(item.taskId).state).toBe("COLLECTED");
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 1 });
  });
  it("重启复核离线也持久递增退避，再次重启不会归零或输出请求秘密", async () => {
    const log = vi.spyOn(console, "log"), warn = vi.spyOn(console, "warn"), error = vi.spyOn(console, "error");
    const f = await fixture(); await f.configure(); const item = await f.add(); f.setStatus(503); f.jump(30000); await f.delivery.tick();
    await f.delivery.close(); const restored = f.restored(); f.jump(30000); await restored.tick();
    expect(f.state(item.taskId)).toMatchObject({ state: "REFRESH_PENDING", last_failure: "NETWORK_UNAVAILABLE" });
    const due = f.state(item.taskId).next_attempt_at, requests = f.requests(); await restored.close(); const again = f.restored();
    await again.tick(); f.jump(59999); await again.tick(); expect(f.requests()).toBe(requests);
    expect(f.state(item.taskId).next_attempt_at).toBe(due); f.jump(1); await again.tick(); expect(f.requests()).toBe(requests + 1);
    expect(JSON.stringify([log.mock.calls, warn.mock.calls, error.mock.calls])).not.toMatch(/fixture-emby-private-key|fixture-server-private-error|127\.0\.0\.1/);
  });
  it("核对超时修复后仅重试交付，保持目标 inode、来源和操作历史", async () => {
    const f = await fixture(); await f.configure(); const item = await f.add(), before = await lstat(item.path);
    f.jump(30000); await f.delivery.tick(); f.jump(600000); await f.delivery.tick();
    expect(f.state(item.taskId)).toMatchObject({ state: "NEEDS_ATTENTION", last_failure: "CHECK_TIMEOUT" });
    f.setItems([{ Id: "repaired", Type: "Movie", Path: item.path, ProviderIds: { Tmdb: "1" } }]);
    f.delivery.retry(item.taskId); f.jump(30000); await f.delivery.tick(); f.jump(15000); await f.delivery.tick();
    expect(f.state(item.taskId).state).toBe("COLLECTED"); expect((await lstat(item.path)).ino).toBe(before.ino);
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 1 });
    expect(f.db.connection.prepare("SELECT status FROM media_task").get()).toEqual({ status: "DONE" });
    expect(await f.delivery.openUrl(item.taskId)).toBe(f.settings.embyUrl + "/web/index.html#!/item?id=repaired&serverId=fixture-server-id");
    expect(await readFile(f.existingMedia, "utf8")).toBe("原有媒体保持原状");
  });
  it.each(["缺路径", "缺作品标识", "错误类型", "同名异作", "重复候选"])("电影收录证据%s时保持等待，不能打开链接", async (change) => {
    const f = await fixture(); await f.configure(); const item = await f.add();
    const match: EmbyItem = { Id: "movie", Type: "Movie", Path: item.path, ProviderIds: { Tmdb: "1" } };
    if (change === "缺路径") delete match.Path;
    if (change === "缺作品标识") delete match.ProviderIds;
    if (change === "错误类型") match.Type = "Episode";
    if (change === "同名异作") match.ProviderIds = { Tmdb: "999" };
    f.setItems(change === "重复候选" ? [match, { ...match, Id: "another-movie" }] : [match]);
    f.jump(30000); await f.delivery.tick(); f.jump(15000); await f.delivery.tick();
    expect(f.state(item.taskId).state).toBe("WAITING_LIBRARY");
    await expect(f.delivery.openUrl(item.taskId)).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it("多版本条目以 MediaSources 精确路径核对，同库同轮任务共享分页结果", async () => {
    const f = await fixture(); await f.configure(); const a = await f.add(), b = await f.add();
    const fillers = Array.from({ length: 201 }, (_, index) => ({ Id: `other-${index}`, Type: "Movie", Path: join(f.path, `other-${index}.mp4`) }));
    f.setItems([...fillers, { Id: "a", Type: "Movie", MediaSources: [{ Path: a.path }], ProviderIds: { Tmdb: "1" } }, { Id: "b", Type: "Movie", Path: b.path, ProviderIds: { Tmdb: "1" } }]);
    f.jump(30000); await f.delivery.tick(); const before = f.pages(); f.jump(15000); await f.delivery.tick();
    expect(f.pages() - before).toBe(2); expect(f.state(a.taskId).state).toBe("COLLECTED"); expect(f.state(b.taskId).state).toBe("COLLECTED");
  });
  it.each(["缺剧集", "作品不符", "重复剧集", "非请求剧集", "季集不符"])("剧集核对%s不能误标收录", async (change) => {
    const f = await fixture(); await f.configure(); const item = await f.add("TV_SHOW");
    const series: EmbyItem = { Id: "series-1", Type: "Series", ProviderIds: { Tmdb: change === "作品不符" ? "999" : "2" } };
    f.setSeries(change === "缺剧集" ? [] : change === "重复剧集" ? [series, { ...series, ProviderIds: { Tmdb: "999" } }] : change === "非请求剧集" ? [{ ...series, Id: "unrequested" }] : [series]);
    f.setItems([{ Id: "episode", Type: "Episode", Path: item.path, SeriesId: "series-1", ParentIndexNumber: 3, IndexNumber: change === "季集不符" ? 5 : 4 }]);
    f.jump(30000); await f.delivery.tick(); f.jump(15000); await f.delivery.tick();
    expect(f.state(item.taskId).state).toBe(["重复剧集", "非请求剧集"].includes(change) ? "NEEDS_ATTENTION" : "WAITING_LIBRARY");
    await expect(f.delivery.openUrl(item.taskId)).rejects.toMatchObject({ code: "CONFLICT" });
  });
  it.each(["连接变更", "重试交付"])("打开条目核对期间%s，迟到响应不能返回旧链接", async (change) => {
    const f = await fixture(); await f.configure(); const item = await f.add();
    f.setItems([{ Id: "collected", Type: "Movie", Path: item.path, ProviderIds: { Tmdb: "1" } }]);
    f.jump(30000); await f.delivery.tick(); f.jump(15000); await f.delivery.tick();
    let release!: (value: { Id: string; Version: string }) => void;
    vi.spyOn(EmbyClient.prototype, "info").mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const opening = f.delivery.openUrl(item.taskId), result = expect(opening).rejects.toMatchObject({ code: "CONFLICT" });
    if (change === "连接变更") await f.configure(); else f.delivery.retry(item.taskId);
    release({ Id: "fixture-server-id", Version: "4.9-fixture" }); await result;
    expect(await readFile(item.path, "utf8")).toBe("fixture-video");
  });
  it("公开连接与读取错误保留可操作分类，不转发服务器正文或泛化为内部错误", async () => {
    const f = await fixture(); f.setStatus(503);
    await expect(f.delivery.libraries()).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE", message: expect.stringContaining("检查地址和服务状态") });
    await expect(f.configure()).rejects.toMatchObject({ code: "NETWORK_UNAVAILABLE", message: expect.not.stringContaining("fixture-server-private-error") });
    f.setStatus(401);
    await expect(f.configure()).rejects.toMatchObject({ code: "AUTH_REQUIRED", message: expect.stringContaining("密钥无效或权限不足") });
    expect(f.delivery.configuration()).toBeNull();
  });
  it.each(["read", "refresh"] as const)("缺少 %s 权限时保留草稿，不保存部分连接或修改存量文件", async (permission) => {
    const f = await fixture(); f.setPermission(permission, 403);
    await expect(f.configure()).rejects.toMatchObject({ code: "AUTH_REQUIRED" });
    expect(f.delivery.configuration()).toBeNull(); expect(f.refreshes()).toBe(0);
    expect(await readFile(f.existingMedia, "utf8")).toBe("原有媒体保持原状");
  });
  it("容器路径与 Mac 目录不属于同一命名空间时拒绝，不自动替换或猜映射", async () => {
    const f = await fixture(); f.setLibraryPaths(["/container/movies"]);
    await expect(f.delivery.connect({ serverId: "fixture-server-id", libraries: [{ targetId: f.pipeline.libraries()[0]!.targetId, libraryId: "library-1", libraryPath: "/container/movies" }] })).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(f.delivery.configuration()).toBeNull(); expect(f.refreshes()).toBe(0);
  });

  it.each([undefined, "中文子目录"])("已有内容的库可绑定根目录或合法子目录（%s），不改写存量媒体", async (subdirectory) => {
    const f = await fixture({ subdirectory }); f.setLibraryType("movies");
    const configuration = await f.configure();
    expect(configuration).toMatchObject({ verified: true, libraries: [{ libraryPath: f.libraryPath }] });
    expect(await readFile(f.existingMedia, "utf8")).toBe("原有媒体保持原状");
  });
  it.each([
    ["MOVIE", "tvshows"], ["TV_SHOW", "movies"], ["MOVIE", "music"], ["AUTO", "movies"],
  ] as const)("%s 目标拒绝不兼容的 %s 库，不保存部分绑定或触发刷新", async (mediaType, type) => {
    const f = await fixture({ mediaType }); f.setLibraryType(type);
    await expect(f.configure()).rejects.toMatchObject({ code: "UNSAFE_PATH", message: expect.stringContaining("库") });
    expect(f.delivery.configuration()).toBeNull(); expect(f.refreshes()).toBe(0);
  });
  it("自动识别目标接受未指定类型的混合库，运行中库类型变化立即使绑定失效", async () => {
    const f = await fixture({ mediaType: "AUTO" }); await f.configure(); const item = await f.add();
    f.setLibraryType("tvshows"); f.jump(30000); await f.delivery.tick();
    expect(f.state(item.taskId)).toMatchObject({ state: "NEEDS_ATTENTION", last_failure: "LIBRARY_TYPE_MISMATCH" });
    expect(f.delivery.configuration()?.verified).toBe(false); expect(await readFile(item.path, "utf8")).toBe("fixture-video");
  });
  it("重启后先重新核对服务器、库、类型和权限，保留连接版本及既有结果", async () => {
    const f = await fixture(); const configured = await f.configure(); await f.delivery.close();
    const restored = f.restored(); expect(restored.configuration()).toMatchObject({ version: configured.version, verified: false });
    await restored.revalidate(); expect(restored.configuration()).toEqual(configured);
    expect(await readFile(f.existingMedia, "utf8")).toBe("原有媒体保持原状");
  });
  it("只配置剧集目标即可绑定和恢复，不要求额外电影目录", async () => {
    const f = await fixture({ mediaType: "TV_SHOW" }); f.setLibraryType("tvshows"); const configuration = await f.configure();
    expect(f.pipeline.libraries()).toMatchObject([{ mediaType: "TV_SHOW" }]); expect(configuration.libraries).toHaveLength(1);
    await f.delivery.close(); const restored = f.restored(); await restored.revalidate();
    expect(restored.configuration()).toEqual(configuration);
  });
  it.each(["服务器身份", "库目录", "库类型"])("重启复核发现%s变化，旧验证和交付链接不再有效", async (change) => {
    const f = await fixture(); await f.configure(); const item = await f.add(); await f.delivery.close();
    if (change === "服务器身份") f.setServerId("different-fixture-server");
    else if (change === "库目录") f.setLibraryPaths([join(f.directory, "其他库目录")]);
    else f.setLibraryType("music");
    const restored = f.restored(); await restored.revalidate();
    expect(restored.configuration()?.verified).toBe(false);
    expect(f.state(item.taskId).state).toBe("NEEDS_ATTENTION");
    await expect(restored.openUrl(item.taskId)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(f.refreshes()).toBe(1); expect(await readFile(item.path, "utf8")).toBe("fixture-video");
  });
  it("重启复核认证失败后停止自动重试，显式修复连接不改写已完成文件", async () => {
    const f = await fixture(), configuration = await f.configure(), item = await f.add(), before = await lstat(item.path);
    await f.delivery.close(); const restored = f.restored(); f.setStatus(401); await restored.tick();
    expect(f.state(item.taskId)).toMatchObject({ state: "NEEDS_ATTENTION", last_failure: "AUTH_REQUIRED" });
    const requests = f.requests(); f.jump(15 * 60 * 1000); await restored.tick(); expect(f.requests()).toBe(requests);
    f.setStatus(200); await restored.connect({ serverId: configuration.serverId, libraries: configuration.libraries });
    expect(restored.configuration()?.verified).toBe(true); expect((await lstat(item.path)).ino).toBe(before.ino);
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 1 });
  });
  it("重启遇到离线保留原绑定，三十秒内不高速重试，恢复后继续同一交付", async () => {
    const f = await fixture(); await f.configure(); const item = await f.add(); await f.delivery.close();
    const restored = f.restored(); f.setStatus(503); await restored.tick(); const requests = f.requests();
    expect(restored.configuration()?.verified).toBe(false); expect(f.db.connection.prepare("SELECT valid FROM emby_connection").get()).toEqual({ valid: 1 });
    await restored.tick(); expect(f.requests()).toBe(requests);
    f.setStatus(200); f.jump(30000); await restored.tick(); expect(restored.configuration()?.verified).toBe(true);
    expect(f.state(item.taskId).state).toBe("WAITING_LIBRARY"); expect(await readFile(item.path, "utf8")).toBe("fixture-video");
    expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 1 });
  });
  it("缺少目标绑定时文件保持 DONE，交付需处理，不回退到其他库", async () => {
    const f = await fixture(); await f.configure(); const item = await f.add();
    f.db.connection.prepare("DELETE FROM emby_library").run(); f.jump(30000); await f.delivery.tick();
    expect(f.state(item.taskId)).toMatchObject({ state: "NEEDS_ATTENTION", last_failure: "LIBRARY_PATH_MISMATCH" });
    expect(f.db.connection.prepare("SELECT status FROM media_task WHERE id=?").get(item.taskId)).toEqual({ status: "DONE" });
  });
  it("重新验证期间凭据代际变化，迟到结果不能把旧连接标为有效", async () => {
    const f = await fixture(); await f.configure(); await f.delivery.close(); const restored = f.restored();
    let release!: (value: { Id: string; Version: string }) => void;
    vi.spyOn(EmbyClient.prototype, "info").mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
    const checking = restored.revalidate();
    f.connections.install({ tmdb: "new-fixture-tmdb", emby: "fixture-emby-private-key" });
    release({ Id: "fixture-server-id", Version: "4.9-fixture" }); await checking;
    expect(restored.configuration()?.verified).toBe(false);
    await restored.revalidate(); expect(restored.configuration()?.verified).toBe(true);
  });

  it("同版本三十秒合并刷新，刷新成功不等于收录，路径和 ProviderIds 都一致才收录", async () => {
    const f = await fixture(); await f.configure(); const a = await f.add(), b = await f.add(); await f.delivery.tick(); expect(f.refreshes()).toBe(1);
    f.jump(30000); await f.delivery.tick(); expect(f.refreshes()).toBe(2); expect(f.state(a.taskId).state).toBe("WAITING_LIBRARY"); expect(f.state(b.taskId).state).toBe("WAITING_LIBRARY");
    f.setItems([{ Id: "wrong-work", Type: "Movie", Path: a.path, ProviderIds: { Tmdb: "99" } }, { Id: "wrong-path", Type: "Movie", Path: join(f.path, "elsewhere.mp4"), ProviderIds: { Tmdb: "1" } }]);
    f.jump(15000); await f.delivery.tick(); expect(f.state(a.taskId).state).toBe("WAITING_LIBRARY");
    f.setItems([{ Id: "right-work", Type: "Movie", Path: a.path, ProviderIds: { Tmdb: "1" } }]); f.jump(15000); await f.delivery.tick(); expect(f.state(a.taskId).state).toBe("COLLECTED"); expect(f.state(b.taskId).state).toBe("WAITING_LIBRARY");
    const url = await f.delivery.openUrl(a.taskId); expect(url).toContain("id=right-work"); expect(url).not.toContain("fixture-emby-private-key"); expect(await readFile(a.path, "utf8")).toBe("fixture-video");
  });
  it("剧集按 Series ProviderIds 和季集验证，集级 TMDB ID 不能冒充作品 ID；分页共享结果", async () => {
    const f = await fixture(); await f.configure(); const a = await f.add("TV_SHOW");
    f.setItems([...Array.from({ length: 201 }, (_, index) => ({ Id: `unrelated-${index}`, Type: "Movie", Path: join(f.path, `unrelated-${index}.mp4`) })), { Id: "episode-4", Type: "Episode", Path: a.path, SeriesId: "series-1", ParentIndexNumber: 3, IndexNumber: 4, ProviderIds: { Tmdb: "9001" } }]);
    f.jump(30000); await f.delivery.tick(); f.jump(15000); await f.delivery.tick(); expect(f.state(a.taskId).state).toBe("COLLECTED"); expect(f.pages()).toBeGreaterThanOrEqual(3);
  });
  it("离线退避持久化，认证失败停止，重试交付不改变文件完成状态或复制记录", async () => {
    const f = await fixture(); await f.configure(); const a = await f.add(); f.setStatus(503); f.jump(30000); await f.delivery.tick(); const first = f.state(a.taskId); expect(first.state).toBe("REFRESH_PENDING"); expect(first.last_failure).toBe("NETWORK_UNAVAILABLE");
    await f.delivery.tick(); expect(f.state(a.taskId).next_attempt_at).toBe(first.next_attempt_at);
    f.setStatus(401); f.jump(30000); await f.delivery.tick(); expect(f.state(a.taskId).state).toBe("NEEDS_ATTENTION"); const refreshes = f.refreshes(); f.jump(999999); await f.delivery.tick(); expect(f.refreshes()).toBe(refreshes);
    f.setStatus(200); await f.configure(); f.setItems([{ Id: "collected", Type: "Movie", Path: a.path, ProviderIds: { Tmdb: "1" } }]); f.delivery.retry(a.taskId); f.jump(30000); await f.delivery.tick(); f.jump(15000); await f.delivery.tick(); expect(f.state(a.taskId).state).toBe("COLLECTED");
    expect(f.db.connection.prepare("SELECT status FROM media_task").get()).toEqual({ status: "DONE" }); expect(f.db.connection.prepare("SELECT count(*) AS n FROM ingestion_operation").get()).toEqual({ n: 1 });
  });
  it("核对超时、目标变更和服务器身份变化均不能返回可播放成功", async () => {
    const f = await fixture(); await f.configure(); const a = await f.add(); f.jump(30000); await f.delivery.tick(); f.jump(600000); await f.delivery.tick(); expect(f.state(a.taskId)).toMatchObject({ state: "NEEDS_ATTENTION", last_failure: "CHECK_TIMEOUT" });
    f.delivery.retry(a.taskId); f.setItems([{ Id: "item", Type: "Movie", Path: a.path, ProviderIds: { Tmdb: "1" } }]); await writeFile(a.path, "changed-video"); f.jump(30000); await f.delivery.tick(); f.jump(15000); await f.delivery.tick(); expect(f.state(a.taskId)).toMatchObject({ state: "NEEDS_ATTENTION", last_failure: "TARGET_CHANGED" });
    await expect(f.delivery.openUrl(a.taskId)).rejects.toMatchObject({ code: "CONFLICT" }); f.delivery.retry(a.taskId); f.setServerId("different-server"); f.jump(30000); await f.delivery.tick(); expect(f.delivery.configuration()?.verified).toBe(false); expect(f.state(a.taskId).state).toBe("NEEDS_ATTENTION");
  });
  it("目标不在库中、路径命名空间不一致，配置不能通过；公开响应不含密钥或额外服务器路径", async () => {
    const f = await fixture(); const listed = await f.delivery.libraries(); expect(JSON.stringify(listed)).not.toMatch(/fixture-emby-private-key|ProgramDataPath|private\/not/);
    await expect(f.delivery.connect({ serverId: "fixture-server-id", libraries: [{ targetId: randomUUID(), libraryId: "library-1", libraryPath: f.path }] })).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    expect(f.delivery.configuration()).toBeNull(); expect(f.refreshes()).toBe(0);
  });
});
