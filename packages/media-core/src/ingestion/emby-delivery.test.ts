import { afterEach, describe, expect, it } from "vitest";
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
import type { EmbyItem } from "../infrastructure/emby";
import type { ManagedRootGrant } from "@media-marshal/contracts/internal";
const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "marshal-emby-delivery-"))); cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "媒体库"); await mkdir(path); const info = await lstat(path, { bigint: true }), fs = await statfs(path, { bigint: true });
  const grant: ManagedRootGrant = { id: randomUUID(), path, volume: { volumeId: randomUUID(), rootInode: String(info.ino), rootBirthtimeNs: String(info.birthtimeNs), observedDevice: String(info.dev), fsTypeCode: String(fs.type), fsType: "test-local", caseSensitive: true, unicodeEquivalent: true, pathMaxBytes: 4096 } };
  const roots = new ManagedRoots("direct"); await roots.install(grant); cleanup.push(() => roots.close());
  let clock = Date.now(), refreshes = 0, status = 200, serverId = "fixture-server-id", pages = 0; let items: EmbyItem[] = [];
  const server = http.createServer((req, res) => { const url = new URL(req.url!, "http://localhost"); if (req.headers["x-emby-token"] !== "fixture-emby-private-key") { res.writeHead(401).end("fixture-emby-private-key"); return; } if (status !== 200) { res.writeHead(status).end("fixture-server-private-error"); return; }
    if (url.pathname === "/System/Info") res.end(JSON.stringify({ Id: serverId, Version: "4.9-fixture", ProgramDataPath: "/private/not-returned" }));
    else if (url.pathname === "/Library/VirtualFolders/Query") res.end(JSON.stringify({ Items: [{ ItemId: "library-1", Name: "测试库", Locations: [path] }], TotalRecordCount: 1 }));
    else if (url.pathname === "/Library/Refresh") { refreshes++; res.writeHead(200).end(); }
    else if (url.pathname === "/Items") { pages++; const wanted = url.searchParams.get("Ids"), start = Number(url.searchParams.get("StartIndex") ?? 0), result = wanted ? [{ Id: "series-1", Type: "Series", ProviderIds: { Tmdb: "2" } }] : items; res.end(JSON.stringify({ Items: result.slice(start, start + 200), TotalRecordCount: result.length })); }
    else res.writeHead(404).end("{}");
  }); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const settings = { language: "zh-CN" as const, embyUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, tmdbProxy: "http://127.0.0.1:1" }, db = await CoreDatabase.open(join(directory, "core.sqlite3")); cleanup.push(() => db.close());
  db.connection.prepare("INSERT INTO media_target_root VALUES(?,?,1)").run(grant.id, JSON.stringify(grant));
  const connections = new MediaConnections(db, () => settings); connections.install({ tmdb: null, emby: "fixture-emby-private-key" }); cleanup.push(() => connections.close());
  const pipeline = { targets: roots, libraries: () => [{ mediaType: "MOVIE" as const, targetId: grant.id, path, available: true }] };
  const delivery = new EmbyDelivery(db, connections, () => settings, pipeline, () => clock); cleanup.push(() => delivery.close());
  const configure = () => delivery.connect({ serverId: "fixture-server-id", libraries: [{ targetId: grant.id, libraryId: "library-1", libraryPath: path }] });
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
  return { directory, path, db, delivery, configure, add, state, setItems(value: EmbyItem[]) { items = value; }, setStatus(code: number) { status = code; }, setServerId(id: string) { serverId = id; }, refreshes: () => refreshes, pages: () => pages, jump(ms: number) { clock += ms; }, pipeline, connections, settings };
}
describe("独立 Emby 交付、合并与核对", () => {
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
