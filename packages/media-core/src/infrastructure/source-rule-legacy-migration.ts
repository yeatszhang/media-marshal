import type Database from "better-sqlite3";
import { sourceConfigurationSchema, type SourceConfiguration } from "@media-marshal/contracts";

export const sourceRuleLegacyMigrationSql = `
ALTER TABLE download_source_demand ADD COLUMN review_required INTEGER NOT NULL DEFAULT 0 CHECK(review_required IN (0,1));
CREATE TABLE source_rule_legacy_reference (
 kind TEXT NOT NULL CHECK(kind IN ('local-source','subscription','managed-binding','download-job')),
 legacy_id TEXT NOT NULL, source_id TEXT REFERENCES source_rule(id),
 status TEXT NOT NULL CHECK(status IN ('MAPPED','REVIEW_REQUIRED','HISTORICAL')),
 reason TEXT NOT NULL CHECK(reason IN ('NONE','NO_AUTHORIZATION','AMBIGUOUS_OWNERSHIP','SNAPSHOT_UNAVAILABLE','UNCONFIRMED','CANCELLED','NO_SOURCE')),
 PRIMARY KEY(kind,legacy_id)
);
CREATE INDEX source_rule_legacy_owner ON source_rule_legacy_reference(source_id,kind);
`;

interface LocalRow { id: string; name: string; kind: string; source_path: string; target_path: string; media_type: string; version: number; paused: number; created_at: string; mode: string | null; download_root_id: string | null; target_root_id: string | null }
interface SubscriptionRow { id: string; account_id: string; remote_root_ref: string; target_root_id: string; filters_json: string; interval_seconds: number; enabled: number; configuration_version: number; confirmed_preview_id: string | null; created_at: string; updated_at: string; state: string; name: string | null }
const parsed = (configuration: unknown) => sourceConfigurationSchema.parse(configuration);
const sourceName = (name: string | null) => {
  let result = "";
  for (const character of name?.trim() || "待核对网盘来源") { if (result.length + character.length > 100) break; result += character; }
  return result;
};

/** 只追加身份和证据，不写旧配置、扫描、作业、候选或磁盘；迁移整体受外层事务保护。 */
export function migrateLegacySourceRules(db: Database.Database): void {
  const legacy = (kind: string, id: string, source: string | null, status: string, reason: string) => db.prepare("INSERT INTO source_rule_legacy_reference(kind,legacy_id,source_id,status,reason) VALUES(?,?,?,?,?)").run(kind, id, source, status, reason);
  const existingOwner = (field: "local_source_id" | "subscription_id" | "ingestion_source_id", id: string): string | undefined => {
    const rows = db.prepare(`SELECT DISTINCT source_id FROM source_rule_version WHERE ${field}=? LIMIT 2`).all(id) as { source_id: string }[];
    return rows.length === 1 ? rows[0]!.source_id : undefined;
  };
  const insert = (input: { id: string; configuration: SourceConfiguration; version: number; paused: number; review: boolean; localId?: string; subscriptionId?: string; ingestionId?: string; targetId?: string; created: string; updated: string }) => {
    const json = JSON.stringify(input.configuration);
    const draft = db.prepare("SELECT type,version FROM source_rule WHERE id=?").get(input.id) as { type: string; version: number } | undefined;
    if (draft) {
      if (draft.type !== input.configuration.type || draft.version !== 0) throw new Error("旧来源身份与现有来源配置冲突");
      db.prepare("UPDATE source_rule SET version=?,paused=?,review_required=?,local_source_id=?,subscription_id=?,ingestion_source_id=? WHERE id=?")
        .run(input.version, input.paused, Number(input.review), input.localId ?? null, input.subscriptionId ?? null, input.ingestionId ?? null, input.id);
      db.prepare("UPDATE source_rule_preview SET state='EXPIRED' WHERE source_id=? AND state='READY'").run(input.id);
    } else db.prepare("INSERT INTO source_rule(id,type,version,draft_revision,draft_json,paused,review_required,local_source_id,subscription_id,ingestion_source_id,created_at,updated_at) VALUES(?,?,?,1,?,?,?,?,?,?,?,?)")
      .run(input.id, input.configuration.type, input.version, json, input.paused, Number(input.review), input.localId ?? null, input.subscriptionId ?? null, input.ingestionId ?? null, input.created, input.updated);
    if (input.version) db.prepare("INSERT INTO source_rule_version(source_id,version,configuration_json,local_source_id,subscription_id,ingestion_source_id,target_root_id,created_at) VALUES(?,?,?,?,?,?,?,?)")
      .run(input.id, input.version, json, input.localId ?? null, input.subscriptionId ?? null, input.ingestionId ?? null, input.targetId ?? null, input.updated);
  };
  const locals = db.prepare("SELECT s.*,i.mode,i.download_root_id,i.target_root_id FROM desktop_source s LEFT JOIN ingestion_source i ON i.source_id=s.id WHERE coalesce(i.mode,'local')='local' ORDER BY s.id").all() as LocalRow[];
  for (const source of locals) {
    const owner = existingOwner("local_source_id", source.id);
    if (owner) { legacy("local-source", source.id, owner, "MAPPED", "NONE"); continue; }
    const configuration = parsed({ type: "local", name: source.name, client: source.kind, sourcePath: source.source_path, organization: { targetPath: source.target_path, mediaType: source.media_type, operation: "COPY", automatic: false } });
    insert({ id: source.id, configuration, version: source.version, paused: source.paused, review: !source.mode, localId: source.id, targetId: source.target_root_id ?? undefined, created: source.created_at, updated: source.created_at });
    legacy("local-source", source.id, source.id, source.mode ? "MAPPED" : "REVIEW_REQUIRED", source.mode ? "NONE" : "NO_AUTHORIZATION");
  }
  const subscriptions = db.prepare("SELECT s.*,r.state,e.name FROM cloud_subscription s JOIN cloud_subscription_runtime r ON r.subscription_id=s.id LEFT JOIN remote_entry e ON e.id=s.remote_root_ref ORDER BY s.id").all() as SubscriptionRow[];
  const managed = db.prepare("SELECT s.*,i.mode,i.download_root_id,i.target_root_id FROM desktop_source s JOIN ingestion_source i ON i.source_id=s.id WHERE i.mode='managed' ORDER BY s.id").all() as LocalRow[];
  for (const subscription of subscriptions) {
    const owner = existingOwner("subscription_id", subscription.id);
    if (owner) { legacy("subscription", subscription.id, owner, "MAPPED", "NONE"); continue; }
    const matching = managed.filter((source) => source.download_root_id === subscription.target_root_id);
    const rootSubscriptions = subscriptions.filter((other) => other.target_root_id === subscription.target_root_id);
    // 根级绑定无法证明多个来源或一次性历史的整理意图，保留待核对而不分配当前策略。
    const otherJobs = db.prepare("SELECT 1 FROM download_job j JOIN cloud_preview p ON p.id=j.preview_id WHERE p.target_root_id=? AND (j.subscription_id IS NULL OR j.subscription_id!=?) LIMIT 1").get(subscription.target_root_id, subscription.id);
    const binding = matching.length === 1 && rootSubscriptions.length === 1 && !otherJobs ? matching[0] : undefined;
    const unconfirmed = !subscription.confirmed_preview_id;
    const review = unconfirmed || subscription.state === "CANCELLED" || subscription.state === "RESELECT_REQUIRED" || !subscription.name || (matching.length > 0 && !binding);
    const configuration = parsed({ type: "cloud", name: sourceName(subscription.name), accountId: subscription.account_id, remoteRef: subscription.remote_root_ref, downloadRootId: subscription.target_root_id, filters: JSON.parse(subscription.filters_json), periodic: { enabled: !unconfirmed, intervalSeconds: subscription.interval_seconds }, organization: binding ? { targetPath: binding.target_path, mediaType: binding.media_type, operation: "COPY", automatic: false } : null });
    const version = unconfirmed ? 0 : subscription.configuration_version;
    insert({ id: subscription.id, configuration, version, paused: version ? Number(!subscription.enabled) : 1, review, subscriptionId: version ? subscription.id : undefined, ingestionId: version ? binding?.id : undefined, targetId: version ? binding?.target_root_id ?? undefined : undefined, created: subscription.created_at, updated: subscription.updated_at });
    legacy("subscription", subscription.id, subscription.id, review ? "REVIEW_REQUIRED" : "MAPPED", unconfirmed ? "UNCONFIRMED" : subscription.state === "CANCELLED" ? "CANCELLED" : review ? "AMBIGUOUS_OWNERSHIP" : "NONE");
  }
  for (const binding of managed) {
    const owners = db.prepare("SELECT id FROM source_rule WHERE ingestion_source_id=? ORDER BY id LIMIT 2").all(binding.id) as { id: string }[];
    legacy("managed-binding", binding.id, owners.length === 1 ? owners[0]!.id : null, owners.length === 1 ? "MAPPED" : "REVIEW_REQUIRED", owners.length === 1 ? "NONE" : "AMBIGUOUS_OWNERSHIP");
  }
  // SQLite 的活动游标不能同时写本连接；分批读完再写，并限制升级内存。
  type Job = { id: string; subscription_id: string | null; configuration_version: number; account_id: string; remote_root_ref: string; target_root_id: string; snapshot_json: string };
  let cursor = "";
  for (;;) {
    const jobs = db.prepare("SELECT j.id,j.subscription_id,j.configuration_version,p.account_id,p.remote_root_ref,p.target_root_id,p.snapshot_json FROM download_job j JOIN cloud_preview p ON p.id=j.preview_id WHERE j.id>? ORDER BY j.id LIMIT 250").all(cursor) as Job[];
    if (!jobs.length) break;
    cursor = jobs.at(-1)!.id;
    for (const job of jobs) {
    const recorded = db.prepare("SELECT source_id FROM download_source_demand WHERE job_id=?").get(job.id) as { source_id: string } | undefined;
    if (recorded) { legacy("download-job", job.id, recorded.source_id, "MAPPED", "NONE"); continue; }
    if (!job.subscription_id) { legacy("download-job", job.id, null, "HISTORICAL", "NO_SOURCE"); continue; }
    const reference = db.prepare("SELECT source_id FROM source_rule_legacy_reference WHERE kind='subscription' AND legacy_id=?").get(job.subscription_id) as { source_id: string | null } | undefined;
    const active = reference?.source_id ? db.prepare("SELECT s.version,v.configuration_json FROM source_rule s JOIN source_rule_version v ON v.source_id=s.id AND v.version=s.version WHERE s.id=?").get(reference.source_id) as { version: number; configuration_json: string } | undefined : undefined;
    const configuration = active ? parsed(JSON.parse(active.configuration_json)) : null;
    const decoded: unknown = JSON.parse(job.snapshot_json);
    const snapshot = decoded && typeof decoded === "object" ? decoded as { filters?: unknown; layout?: string } : {};
    const previousConfiguration = configuration?.type === "cloud" ? sourceConfigurationSchema.safeParse({ ...configuration, filters: snapshot.filters }) : null;
    const sameScope = configuration?.type === "cloud" && job.configuration_version === active?.version && configuration.accountId === job.account_id && configuration.remoteRef === job.remote_root_ref && configuration.downloadRootId === job.target_root_id && snapshot.layout === "drive" && previousConfiguration?.success && JSON.stringify(previousConfiguration.data) === JSON.stringify(configuration);
    if (sameScope && reference?.source_id && active) {
      const review = configuration?.organization ? 1 : 0;
      db.prepare("INSERT INTO download_source_demand(job_id,source_id,source_version,review_required) VALUES(?,?,?,?)").run(job.id, reference.source_id, active.version, review);
      legacy("download-job", job.id, reference.source_id, review ? "REVIEW_REQUIRED" : "MAPPED", review ? "SNAPSHOT_UNAVAILABLE" : "NONE");
    } else legacy("download-job", job.id, reference?.source_id ?? null, "REVIEW_REQUIRED", "SNAPSHOT_UNAVAILABLE");
    }
  }
}
