import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep, join } from "node:path";
import { DesktopError, CloudError, type CoreInput, type CoreOutput, type SettingsDraft } from "@media-marshal/contracts";
import { localFileEvidenceSchema } from "@media-marshal/contracts/internal";
import type { CoreDatabase } from "../infrastructure/database.js";
import { EmbyClient, type EmbyItem } from "../infrastructure/emby.js";
import { MediaNetworkError } from "../infrastructure/json-http.js";
import type { MediaConnections } from "../application/media-connections.js";
import type { IngestionPipeline } from "./pipeline.js";

interface Connection { id: string; version: number; server_id: string; base_url: string; valid: number }
interface Library { target_root_id: string; library_id: string; library_path: string }
interface Delivery { task_id: string; operation_id: string; state: string; refresh_attempts: number; check_started_at: number | null; target_path: string; target_root_id: string; evidence_json: string; plan_json: string }
interface DeliveryPlan { targetSegments: string[]; selection: { tmdbId: number; mediaType: "MOVIE" | "TV_SHOW"; season: number | null; episode: number | null; episodeEnd: number | null } }
const contains = (parent: string, child: string) => { const part = relative(parent, child); return !part || (part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part)); };
const query = "SELECT d.*,t.target_path,o.target_root_id,o.evidence_json,o.plan_json FROM emby_delivery d JOIN media_task t ON t.id=d.task_id AND t.status='DONE' JOIN ingestion_operation o ON o.id=d.operation_id AND o.phase='RECORDED'";

/** 只推进交付，不调用 COPY。网络失败与文件完成状态完全分开。 */
export class EmbyDelivery {
  private timer?: ReturnType<typeof setInterval>; private flight?: Promise<void>; private closed = false; private controller?: AbortController;
  private readonly lifetime = new AbortController();
  constructor(private readonly database: CoreDatabase, private readonly connections: MediaConnections, private readonly settings: () => SettingsDraft, private readonly ingestion: Pick<IngestionPipeline, "targets" | "libraries">, private readonly now = Date.now) {
    const db = database.connection, connection = this.current();
    db.transaction(() => {
      db.prepare("INSERT INTO emby_delivery(task_id,operation_id,connection_id,connection_version,state,next_attempt_at,updated_at) SELECT o.task_id,o.id,?,?,'REFRESH_PENDING',?,? FROM ingestion_operation o JOIN media_task t ON t.id=o.task_id WHERE o.phase='RECORDED' AND t.status='DONE' AND NOT EXISTS(SELECT 1 FROM emby_delivery d WHERE d.task_id=o.task_id)").run(connection?.id ?? null, connection?.version ?? null, now() + 30000, new Date(now()).toISOString());
      db.prepare("UPDATE media_task SET delivery_status='REFRESH_PENDING' WHERE id IN (SELECT task_id FROM emby_delivery WHERE state='REFRESH_PENDING') AND status='DONE'").run();
    })();
  }
  private current() { return this.database.connection.prepare("SELECT * FROM emby_connection ORDER BY verified_at DESC,id LIMIT 1").get() as Connection | undefined; }
  private client() { return new EmbyClient(this.settings().embyUrl, this.connections.embyKey); }
  configuration(): CoreOutput<"emby.configuration"> {
    const row = this.current(); if (!row) return null;
    const libraries = this.database.connection.prepare("SELECT * FROM emby_library WHERE connection_id=? ORDER BY target_root_id").all(row.id) as Library[];
    return { serverId: row.server_id, version: row.version, address: row.base_url, verified: !!row.valid && row.base_url === this.settings().embyUrl, libraries: libraries.map((library) => ({ targetId: library.target_root_id, libraryId: library.library_id, libraryPath: library.library_path })) };
  }
  async libraries(): Promise<CoreOutput<"emby.libraries">> { const client = this.client(), info = await client.info(this.lifetime.signal); return { serverId: info.Id, version: info.Version, libraries: await client.libraries(this.lifetime.signal) }; }
  async connect(input: CoreInput<"emby.connect">): Promise<CoreOutput<"emby.connect">> {
    if (this.closed) throw new DesktopError("INTERRUPTED", "交付服务正在停止", true);
    const client = this.client(), revision = this.connections.version, address = this.settings().embyUrl, info = await client.info(this.lifetime.signal), libraries = await client.libraries(this.lifetime.signal);
    if (info.Id !== input.serverId || new Set(input.libraries.map((row) => row.targetId)).size !== input.libraries.length) throw new DesktopError("CONFLICT", "服务器或媒体库选择已变化，请重新读取");
    const targets = this.ingestion.libraries();
    for (const mapping of input.libraries) {
      const target = targets.find((row) => row.targetId === mapping.targetId), library = libraries.find((row) => row.id === mapping.libraryId);
      if (!target?.available || !library?.paths.includes(mapping.libraryPath) || !isAbsolute(mapping.libraryPath) || !contains(mapping.libraryPath, target.path)) throw new DesktopError("UNSAFE_PATH", "媒体目标不在所选 Emby 库内，请调整目录或在 Emby 添加库");
      let canonical: string; try { canonical = await realpath(mapping.libraryPath); } catch { throw new DesktopError("UNSAFE_PATH", "Emby 库路径在 Mac 上不可访问；请核对路径命名空间，不会自动猜映射"); }
      if (canonical !== mapping.libraryPath || !contains(canonical, target.path)) throw new DesktopError("UNSAFE_PATH", "Emby 库路径与 Mac 真实目录不一致，请核对挂载");
      await this.ingestion.targets.get(mapping.targetId).check();
      // 读取权限必须覆盖限定库；配置验证不把服务器接受刷新当作收录证明。
      await client.items(mapping.libraryId, this.lifetime.signal, []);
    }
    await client.refresh(this.lifetime.signal);
    if (this.closed || revision !== this.connections.version || address !== this.settings().embyUrl) throw new DesktopError("CONFLICT", "连接设置已变化，请重新验证");
    const db = this.database.connection, previous = this.current(), id = previous?.id ?? randomUUID(), version = (previous?.version ?? 0) + 1;
    db.transaction(() => {
      db.prepare("INSERT INTO emby_connection(id,version,server_id,base_url,valid,verified_at) VALUES(?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET version=excluded.version,server_id=excluded.server_id,base_url=excluded.base_url,valid=1,verified_at=excluded.verified_at").run(id, version, info.Id, address, new Date(this.now()).toISOString());
      db.prepare("DELETE FROM emby_library WHERE connection_id=?").run(id);
      for (const mapping of input.libraries) db.prepare("INSERT INTO emby_library VALUES(?,?,?,?)").run(id, mapping.libraryId, mapping.libraryPath, mapping.targetId);
      db.prepare("UPDATE emby_delivery SET connection_id=?,connection_version=?,state='REFRESH_PENDING',refresh_attempts=0,next_attempt_at=?,check_started_at=NULL,last_failure=NULL,emby_item_id=NULL,updated_at=?").run(id, version, this.now() + 30000, new Date(this.now()).toISOString());
      db.prepare("UPDATE media_task SET delivery_status='REFRESH_PENDING' WHERE id IN (SELECT task_id FROM emby_delivery)").run();
    })(); return this.configuration()!;
  }
  invalidate(reason = "CONNECTION_CHANGED") {
    this.controller?.abort(); const db = this.database.connection;
    db.transaction(() => { db.prepare("UPDATE emby_connection SET valid=0").run(); db.prepare("UPDATE emby_delivery SET state='NEEDS_ATTENTION',emby_item_id=NULL,last_failure=?").run(reason); db.prepare("UPDATE media_task SET delivery_status='NEEDS_ATTENTION' WHERE id IN (SELECT task_id FROM emby_delivery)").run(); })();
  }
  retry(taskId: string) {
    const connection = this.current(); if (!connection?.valid || connection.base_url !== this.settings().embyUrl) throw new DesktopError("CONFLICT", "请先在设置页验证 Emby 连接");
    const result = this.database.connection.prepare("UPDATE emby_delivery SET connection_id=?,connection_version=?,state='REFRESH_PENDING',refresh_attempts=0,next_attempt_at=?,check_started_at=NULL,last_failure=NULL,emby_item_id=NULL WHERE task_id=?").run(connection.id, connection.version, this.now() + 30000, taskId);
    if (!result.changes) throw new DesktopError("CONFLICT", "文件尚未完成，不能重试交付");
    this.database.connection.prepare("UPDATE media_task SET delivery_status='REFRESH_PENDING' WHERE id=? AND status='DONE'").run(taskId); return {};
  }
  async openUrl(taskId: string) {
    const connection = this.current(), row = this.database.connection.prepare("SELECT * FROM emby_delivery WHERE task_id=? AND state='COLLECTED'").get(taskId) as { connection_id: string; connection_version: number; emby_item_id: string | null } | undefined;
    if (!row?.emby_item_id || !connection?.valid || connection.base_url !== this.settings().embyUrl || row.connection_id !== connection.id || row.connection_version !== connection.version) throw new DesktopError("CONFLICT", "收录证据尚未通过，请先核对交付");
    const client = this.client(), info = await client.info(this.lifetime.signal); if (info.Id !== connection.server_id) { this.invalidate(); throw new DesktopError("CONFLICT", "服务器身份已变化，请重新验证"); }
    return client.itemUrl(row.emby_item_id, connection.server_id);
  }
  start() { if (!this.timer && !this.closed) { this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 1000); void this.tick().catch(() => {}); } }
  tick(): Promise<void> { if (this.closed) return Promise.resolve(); return this.flight ??= this.run().finally(() => { this.flight = undefined; }); }
  private update(taskId: string, state: "REFRESH_PENDING" | "WAITING_LIBRARY" | "COLLECTED" | "NEEDS_ATTENTION", failure: string | null, next: number, itemId: string | null = null) {
    const db = this.database.connection; db.transaction(() => { db.prepare("UPDATE emby_delivery SET state=?,last_failure=?,next_attempt_at=?,emby_item_id=?,updated_at=? WHERE task_id=?").run(state, failure, next, itemId, new Date(this.now()).toISOString(), taskId); db.prepare("UPDATE media_task SET delivery_status=? WHERE id=? AND status='DONE'").run(state, taskId); })();
  }
  private fail(row: Delivery, error: unknown) {
    const code = error instanceof MediaNetworkError || error instanceof DesktopError || error instanceof CloudError ? error.code : "INVALID_RESPONSE";
    if (code === "AUTH_REQUIRED") { if (this.current()?.valid) this.invalidate("AUTH_REQUIRED"); return; }
    if (code === "INVALID_RESPONSE" || code === "UNSAFE_PATH") { this.update(row.task_id, "NEEDS_ATTENTION", code, this.now()); return; }
    const delay = Math.min(30000 * 2 ** Math.min(row.refresh_attempts, 5), 15 * 60 * 1000);
    this.database.connection.prepare("UPDATE emby_delivery SET refresh_attempts=refresh_attempts+1 WHERE task_id=?").run(row.task_id);
    this.update(row.task_id, row.state === "WAITING_LIBRARY" ? "WAITING_LIBRARY" : "REFRESH_PENDING", code, this.now() + (error instanceof MediaNetworkError && error.retryAfterSeconds ? Math.max(delay, error.retryAfterSeconds * 1000) : delay));
  }
  private match(row: Delivery, items: EmbyItem[], series: Map<string, EmbyItem>) {
    const plan = JSON.parse(row.plan_json) as DeliveryPlan, root = this.ingestion.targets.get(row.target_root_id), normalize = (path: string) => { const text = root.grant.volume.unicodeEquivalent ? path.normalize("NFC") : path; return root.grant.volume.caseSensitive ? text : text.toLowerCase(); };
    const selection = plan.selection, matches = items.filter((item) => {
      if (![item.Path, ...(item.MediaSources?.map((source) => source.Path) ?? [])].some((path) => path && normalize(path) === normalize(row.target_path))) return false;
      if (selection.mediaType === "MOVIE") return item.Type === "Movie" && item.ProviderIds?.Tmdb === String(selection.tmdbId);
      return item.Type === "Episode" && item.ParentIndexNumber === selection.season && item.IndexNumber === selection.episode && (item.IndexNumberEnd ?? item.IndexNumber) === (selection.episodeEnd ?? selection.episode) && !!item.SeriesId && series.get(item.SeriesId)?.Type === "Series" && series.get(item.SeriesId)?.ProviderIds?.Tmdb === String(selection.tmdbId);
    }); return matches.length === 1 ? matches[0]!.Id : null;
  }
  private async run() {
    const connection = this.current(); if (!this.connections.installed || !connection?.valid || connection.base_url !== this.settings().embyUrl) return;
    const db = this.database.connection, controller = new AbortController(); this.controller = controller;
    const credentialVersion = this.connections.version;
    const current = () => !this.closed && !controller.signal.aborted && credentialVersion === this.connections.version && this.current()?.version === connection.version && this.current()?.valid === 1;
    const rows = db.prepare(query + " WHERE d.connection_id=? AND d.connection_version=? AND d.state IN ('REFRESH_PENDING','WAITING_LIBRARY') AND d.next_attempt_at<=? ORDER BY d.next_attempt_at,d.task_id LIMIT 100").all(connection.id, connection.version, this.now()) as Delivery[];
    if (!rows.length) { this.controller = undefined; return; }
    try {
      const client = this.client(), info = await client.info(controller.signal); if (!current()) return;
      if (info.Id !== connection.server_id) { this.invalidate(); return; }
      const libraries = db.prepare("SELECT * FROM emby_library WHERE connection_id=?").all(connection.id) as Library[];
      const remoteLibraries = await client.libraries(controller.signal); if (!current()) return;
      if (libraries.some((mapping) => !remoteLibraries.find((library) => library.id === mapping.library_id)?.paths.includes(mapping.library_path))) { this.invalidate("LIBRARY_PATH_MISMATCH"); return; }
      const usable: Delivery[] = [];
      for (const row of rows) {
        const library = libraries.find((value) => value.target_root_id === row.target_root_id);
        if (!library || !contains(library.library_path, row.target_path)) { this.update(row.task_id, "NEEDS_ATTENTION", "LIBRARY_PATH_MISMATCH", this.now()); continue; }
        try { await this.ingestion.targets.get(row.target_root_id).check(); usable.push(row); } catch (error) { this.fail(row, error); }
      }
      const refresh = usable.filter((row) => row.state === "REFRESH_PENDING"), cooldown = db.prepare("SELECT next_refresh_at FROM emby_refresh_window WHERE connection_id=? AND connection_version=?").get(connection.id, connection.version) as { next_refresh_at: number } | undefined;
      if (refresh.length && (!cooldown || cooldown.next_refresh_at <= this.now())) {
        try { await client.refresh(controller.signal); if (!current()) return;
          db.transaction(() => {
            db.prepare("INSERT INTO emby_refresh_window VALUES(?,?,?) ON CONFLICT(connection_id,connection_version) DO UPDATE SET next_refresh_at=excluded.next_refresh_at").run(connection.id, connection.version, this.now() + 30000);
            for (const row of refresh) { db.prepare("UPDATE emby_delivery SET check_started_at=?,refresh_attempts=0 WHERE task_id=?").run(this.now(), row.task_id); this.update(row.task_id, "WAITING_LIBRARY", null, this.now() + 15000); }
          })();
        } catch (error) { if (current()) refresh.forEach((row) => this.fail(row, error)); }
      }
      for (const library of libraries) {
        const checking = usable.filter((row) => row.state === "WAITING_LIBRARY" && row.target_root_id === library.target_root_id);
        if (!checking.length || !current()) continue;
        try {
          const items = await client.items(library.library_id, controller.signal, checking.map((row) => row.target_path));
          const ids = [...new Set(items.map((item) => item.SeriesId).filter((id): id is string => !!id))];
          const series = new Map<string, EmbyItem>(); for (let start = 0; start < ids.length; start += 100) for (const item of await client.series(ids.slice(start, start + 100), controller.signal)) series.set(item.Id, item);
          if (!current()) return;
          for (const row of checking) {
            const itemId = this.match(row, items, series);
            if (itemId) {
              const plan = JSON.parse(row.plan_json) as DeliveryPlan, expected = localFileEvidenceSchema.parse(JSON.parse(row.evidence_json)), proof = await this.ingestion.targets.get(row.target_root_id).inspectCompleted(plan.targetSegments);
              if (proof.sha256 !== expected.sha256 || proof.inode !== expected.inode || proof.birthtimeNs !== expected.birthtimeNs || proof.size !== expected.size) { this.update(row.task_id, "NEEDS_ATTENTION", "TARGET_CHANGED", this.now()); continue; }
              if (current()) this.update(row.task_id, "COLLECTED", null, this.now(), itemId);
            } else if (row.check_started_at !== null && this.now() - row.check_started_at >= 10 * 60 * 1000) this.update(row.task_id, "NEEDS_ATTENTION", "CHECK_TIMEOUT", this.now());
            else this.update(row.task_id, "WAITING_LIBRARY", null, this.now() + 15000);
          }
        } catch (error) { if (current()) checking.forEach((row) => this.fail(row, error)); }
      }
    } catch (error) { if (current()) rows.forEach((row) => this.fail(row, error)); }
    finally { this.controller = undefined; }
  }
  async close() { this.closed = true; clearInterval(this.timer); this.lifetime.abort(); this.controller?.abort(); await this.flight?.catch(() => {}); }
}
