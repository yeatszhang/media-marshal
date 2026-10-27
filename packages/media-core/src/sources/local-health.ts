import { DesktopError, localSourceHealthSchema, sourceRuleActions, type CoreInput, type LocalSourceHealth, type SourceRule } from "@media-marshal/contracts";
import type { CoreDatabase } from "../infrastructure/database.js";
import type { IngestionPipeline } from "../ingestion/pipeline.js";

/** 健康检查只读取已授权根；查询缓存不是执行事实，失败快照由 SQLite 保留。 */
export class LocalSourceHealthChecks {
  private closed = false;
  private readonly flights = new Map<string, Promise<LocalSourceHealth>>();
  private readonly cache = new Map<string, { at: number; snapshot: LocalSourceHealth }>();
  constructor(private readonly database: CoreDatabase, private readonly get: (id: string) => SourceRule | null, private readonly probe: IngestionPipeline["localDirectoryHealth"], private readonly now = Date.now) {}
  check(input: CoreInput<"source-rules.local-health">) {
    const parsed = sourceRuleActions["source-rules.local-health"].input.parse(input);
    return Promise.all(parsed.items.map((item) => this.one(item, parsed.force))).then((items) => ({ items }));
  }
  private current(item: CoreInput<"source-rules.local-health">["items"][number]) {
    if (this.closed) throw new DesktopError("INTERRUPTED", "目录检查正在停止，请等待核心恢复");
    const source = this.get(item.id);
    if (!source) throw new DesktopError("CONFLICT", `来源 ${item.id} 已不存在，请刷新来源列表`);
    const name = `来源「${source.configuration?.name ?? source.draft.name}」（${source.id}）`;
    if (source.deletedAt) throw new DesktopError("CONFLICT", `${name}已删除，无法检查目录；请先恢复来源`);
    if (source.configuration?.type !== "local") throw new DesktopError("CONFLICT", `${name}不是已确认的本地来源，请先预览并确认本地配置`);
    if (source.version !== item.expectedVersion || (source.lifecycleRevision ?? 0) !== item.expectedLifecycleRevision) throw new DesktopError("CONFLICT", `${name}的版本已变化，请刷新来源后重新检查`);
    return source;
  }
  private one(item: CoreInput<"source-rules.local-health">["items"][number], force: boolean): Promise<LocalSourceHealth> {
    let source: SourceRule; try { source = this.current(item); } catch (error) { return Promise.reject(error); }
    const key = JSON.stringify(item), cached = this.cache.get(key), elapsed = cached ? this.now() - cached.at : Infinity;
    if (!force && cached && elapsed >= 0 && elapsed < 10000) return Promise.resolve(localSourceHealthSchema.parse(cached.snapshot));
    const existing = this.flights.get(key); if (existing) return existing;
    if (this.flights.size >= 32) return Promise.reject(new DesktopError("CONFLICT", "目录检查繁忙，请稍后重新检查"));
    const promise = (async () => {
      const review = { state: "UNVERIFIED" as const, reason: "CONFIGURATION_REVIEW_REQUIRED" as const };
      const result = source.reviewRequired || !source.localSourceId ? { input: review, target: review } : await this.probe(source.localSourceId);
      this.current(item);
      const complete = result.input.state !== "UNVERIFIED" && result.target.state !== "UNVERIFIED";
      const stored = !complete ? this.database.connection.prepare("SELECT snapshot_json FROM source_rule_local_health WHERE source_id=? AND version=? AND lifecycle_revision=?").get(item.id, item.expectedVersion, item.expectedLifecycleRevision) as { snapshot_json: string } | undefined : undefined;
      const previous = stored ? localSourceHealthSchema.parse(JSON.parse(stored.snapshot_json)) : undefined;
      const snapshot = localSourceHealthSchema.parse({ sourceId: item.id, version: item.expectedVersion, lifecycleRevision: item.expectedLifecycleRevision, checkedAt: new Date(this.now()).toISOString(), ...result, ...(previous ? { previous: { checkedAt: previous.checkedAt, input: previous.input, target: previous.target } } : {}) });
      if (complete) this.database.connection.prepare("INSERT INTO source_rule_local_health VALUES(?,?,?,?,?) ON CONFLICT(source_id) DO UPDATE SET version=excluded.version,lifecycle_revision=excluded.lifecycle_revision,checked_at=excluded.checked_at,snapshot_json=excluded.snapshot_json")
        .run(item.id, snapshot.version, snapshot.lifecycleRevision, snapshot.checkedAt, JSON.stringify(snapshot));
      if (this.cache.size >= 1000) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(key, { at: this.now(), snapshot }); return localSourceHealthSchema.parse(snapshot);
    })().finally(() => { if (this.flights.get(key) === promise) this.flights.delete(key); });
    this.flights.set(key, promise); return promise;
  }
  quiesce() { this.closed = true; this.cache.clear(); }
  async close() { this.quiesce(); await Promise.allSettled([...this.flights.values()]); }
}
