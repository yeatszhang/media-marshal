import { createHash } from "node:crypto";
import { sourceConfigurationSchema, type SourceConfiguration } from "@media-marshal/contracts";
import type { CoreDatabase } from "../infrastructure/database.js";

type CloudConfiguration = Extract<SourceConfiguration, { type: "cloud" }>;
export type OrganizationConfiguration = NonNullable<CloudConfiguration["organization"]>;
export interface ManagedOrganization { key: string; configuration: OrganizationConfiguration; sourceId: string; targetRootId: string }
export type ManagedOrganizationResolution = { state: "ENABLED"; policy: ManagedOrganization } | { state: "LEGACY"; sourceId: string } | { state: "NOT_ENABLED" | "PAUSED" | "REVIEW_REQUIRED" | "UNASSIGNED" };
export const organizationKey = (configuration: OrganizationConfiguration) => createHash("sha256").update(JSON.stringify(configuration)).digest("hex");

/** 只使用下载当时落库的需求版本；相同下载根不是整理意图的证据。 */
export function resolveManagedOrganization(database: CoreDatabase, itemId: string, versionKey: string, excludingSourceId?: string): ManagedOrganizationResolution {
  const db = database.connection;
  const item = db.prepare("SELECT target_root_id FROM download_item WHERE id=? AND version_key=?").get(itemId, versionKey) as { target_root_id: string } | undefined;
  if (!item) return { state: "UNASSIGNED" };
  const rows = db.prepare("SELECT d.source_version,d.review_required,s.version,s.paused,s.review_required AS source_review,v.configuration_json,v.ingestion_source_id,v.target_root_id,j.state,ji.demand_state FROM download_job_item ji JOIN download_job j ON j.id=ji.job_id JOIN download_source_demand d ON d.job_id=j.id JOIN source_rule s ON s.id=d.source_id JOIN source_rule_version v ON v.source_id=d.source_id AND v.version=d.source_version WHERE ji.item_id=? AND (? IS NULL OR s.id!=?)").all(itemId, excludingSourceId ?? null, excludingSourceId ?? null) as { source_version: number; review_required: number; version: number; paused: number; source_review: number; configuration_json: string; ingestion_source_id: string | null; target_root_id: string | null; state: string; demand_state: string }[];
  const policies = new Map<string, ManagedOrganization>(); let review = false, paused = false;
  for (const row of rows) {
    if (row.demand_state !== "ACTIVE" || ["CANCELLED", "CANCELLING"].includes(row.state)) continue;
    const configuration = sourceConfigurationSchema.parse(JSON.parse(row.configuration_json));
    if (row.source_review) { review = true; continue; }
    if (configuration.type !== "cloud" || !configuration.organization) continue;
    if (row.review_required || row.source_review || row.version !== row.source_version || configuration.downloadRootId !== item.target_root_id || !row.target_root_id || !row.ingestion_source_id) { review = true; continue; }
    if (row.paused) { paused = true; continue; }
    const key = organizationKey(configuration.organization);
    policies.set(key, { key, configuration: configuration.organization, sourceId: row.ingestion_source_id, targetRootId: row.target_root_id });
  }
  if (policies.size > 1) return { state: "REVIEW_REQUIRED" };
  if (policies.size === 1) return { state: "ENABLED", policy: policies.values().next().value! };
  if (review) return { state: "REVIEW_REQUIRED" };
  if (paused) return { state: "PAUSED" };
  if (rows.length) return { state: "NOT_ENABLED" };
  // 兼容尚未迁入统一来源的旧调用；迁移过的历史和新来源不能借此认领根内文件。
  if (db.prepare("SELECT 1 FROM download_job_item ji JOIN source_rule_legacy_reference r ON r.kind='download-job' AND r.legacy_id=ji.job_id WHERE ji.item_id=? LIMIT 1").get(itemId)
    || db.prepare("SELECT 1 FROM source_rule_version WHERE json_extract(configuration_json,'$.downloadRootId')=? LIMIT 1").get(item.target_root_id)) return { state: "UNASSIGNED" };
  const binding = db.prepare("SELECT source_id FROM ingestion_source WHERE download_root_id=?").get(item.target_root_id) as { source_id: string } | undefined;
  if (!binding) return { state: "UNASSIGNED" };
  const legacy = db.prepare("SELECT status FROM source_rule_legacy_reference WHERE kind='managed-binding' AND legacy_id=?").get(binding.source_id) as { status: string } | undefined;
  return legacy?.status === "REVIEW_REQUIRED" ? { state: "REVIEW_REQUIRED" } : { state: "LEGACY", sourceId: binding.source_id };
}

function filtersOverlap(a: CloudConfiguration["filters"], b: CloudConfiguration["filters"]) {
  const permits = (filter: CloudConfiguration["filters"], name: string) => (!filter.names.length || filter.names.includes(name)) && (!filter.extensions.length || filter.extensions.includes(name.split(".").at(-1)!.toLowerCase()));
  const names = a.names.length ? a.names : b.names;
  return names.length ? names.some((name) => permits(a, name) && permits(b, name)) : !a.extensions.length || !b.extensions.length || a.extensions.some((extension) => b.extensions.includes(extension));
}
function scopesOverlap(database: CoreDatabase, a: CloudConfiguration, b: CloudConfiguration) {
  if (a.accountId !== b.accountId || a.downloadRootId !== b.downloadRootId || !filtersOverlap(a.filters, b.filters)) return false;
  const node = (id: string) => database.connection.prepare("SELECT parent_ref,name,type FROM remote_entry WHERE id=? AND account_id=?").get(id, a.accountId) as { parent_ref: string | null; name: string; type: string } | undefined;
  const under = (child: string, parent: string): boolean | null => {
    const seen = new Set<string>(); let current: string | null = child;
    while (current && seen.size < 256) { if (current === parent) return true; if (seen.has(current)) return null; seen.add(current); const entry = node(current); if (!entry) return null; current = entry.parent_ref; }
    return current ? null : false;
  };
  const forward = under(a.remoteRef, b.remoteRef), backward = under(b.remoteRef, a.remoteRef);
  if (forward === false && backward === false) return false;
  for (const configuration of [a, b]) {
    const selected = node(configuration.remoteRef);
    if (selected?.type === "file") {
      for (const filters of [a.filters, b.filters]) if ((filters.names.length && !filters.names.includes(selected.name)) || (filters.extensions.length && !filters.extensions.includes(selected.name.split(".").at(-1)!.toLowerCase()))) return false;
    }
  }
  return true;
}
/** 比较已确认的范围及过滤，允许同根下不相交的来源使用不同整理目标。 */
export function organizationConflicts(database: CoreDatabase, sourceId: string, configuration: SourceConfiguration): { sourceId: string; name: string }[] {
  if (configuration.type !== "cloud" || !configuration.organization) return [];
  const key = organizationKey(configuration.organization), result: { sourceId: string; name: string }[] = [];
  const sources = database.connection.prepare("SELECT s.id,v.configuration_json FROM source_rule s JOIN source_rule_version v ON v.source_id=s.id AND v.version=s.version WHERE s.type='cloud' AND s.deleted_at IS NULL AND s.id!=? ORDER BY s.id LIMIT 1000").all(sourceId) as { id: string; configuration_json: string }[];
  for (const source of sources) {
    const other = sourceConfigurationSchema.parse(JSON.parse(source.configuration_json));
    if (other.type === "cloud" && other.organization && key !== organizationKey(other.organization) && scopesOverlap(database, configuration, other)) result.push({ sourceId: source.id, name: other.name });
  }
  return result;
}
