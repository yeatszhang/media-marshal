import { createHash } from "node:crypto";
import { join } from "node:path";
import { DesktopError, automaticSampleSchema, sourceConfigurationSchema, type AutomaticSample, type SourceConfiguration } from "@media-marshal/contracts";
import type { CoreDatabase } from "../infrastructure/database.js";

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)])) : value;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
function stableGrant(grant: { id: string; path: string; volume: Record<string, unknown> }) { const { observedDevice: _device, ...volume } = grant.volume; return { id: grant.id, path: grant.path, volume }; }
function configurationScope(value: SourceConfiguration) {
  const { name: _name, organization, ...input } = value;
  if (input.type === "cloud") { const { periodic: _periodic, ...range } = input; return { ...range, organization: organization ? { ...organization, automatic: false } : null }; }
  return { ...input, ignoredFilePatterns: input.ignoredFilePatterns ?? null, organization: organization ? { ...organization, automatic: false } : null };
}
/** 首次授权引用真实人工 COPY 预览；目录、范围或卷身份变化不沿用旧授权。 */
export class AutomaticConsents {
  constructor(private readonly database: CoreDatabase, private readonly now = Date.now) {}
  scope(sourceId: string, configuration: SourceConfiguration) {
    const row = this.database.connection.prepare("SELECT i.source_grant_json FROM source_rule s JOIN ingestion_source i ON i.source_id=coalesce(s.local_source_id,s.ingestion_source_id) WHERE s.id=?").get(sourceId) as { source_grant_json: string } | undefined;
    const targets = this.database.connection.prepare("SELECT grant_json FROM media_target_root WHERE json_extract(grant_json,'$.path')=? LIMIT 2").all(configuration.organization?.targetPath ?? "") as { grant_json: string }[];
    if (!row || targets.length !== 1 || !configuration.organization) return null;
    return hash({ configuration: configurationScope(configuration), input: stableGrant(JSON.parse(row.source_grant_json)), target: stableGrant(JSON.parse(targets[0]!.grant_json)) });
  }
  sample(sourceId: string, configuration: SourceConfiguration, expectedId?: string | null): AutomaticSample | null {
    if (!configuration.organization?.automatic) return null;
    const db = this.database.connection, scope = this.scope(sourceId, configuration);
    if (!scope) return null;
    const accepted = db.prepare("SELECT preview_id,summary_json FROM source_automatic_consent WHERE source_id=? AND scope_hash=?").get(sourceId, scope) as { preview_id: string; summary_json: string } | undefined;
    if (accepted && (!expectedId || accepted.preview_id === expectedId)) return automaticSampleSchema.parse(JSON.parse(accepted.summary_json));
    const source = db.prepare("SELECT s.version,s.lifecycle_revision,s.deleted_at,v.configuration_json FROM source_rule s JOIN source_rule_version v ON v.source_id=s.id AND v.version=s.version WHERE s.id=?").get(sourceId) as { version: number; lifecycle_revision: number; deleted_at: string | null; configuration_json: string } | undefined;
    if (!source || source.deleted_at || hash(configurationScope(sourceConfigurationSchema.parse(JSON.parse(source.configuration_json)))) !== hash(configurationScope(configuration))) return null;
    const rows = db.prepare(`SELECT p.id,p.plan_json,c.source_id,c.managed_item_id,s.version AS physical_version,c.task_id,t.parsed_json,e.revision
      FROM ingestion_preview p JOIN ingestion_candidate c ON c.task_id=p.task_id JOIN media_task t ON t.id=p.task_id
      JOIN desktop_source s ON s.id=c.source_id LEFT JOIN ingestion_recognition_edit e ON e.task_id=t.id
      WHERE p.expires_at>? AND (? IS NULL OR p.id=?) AND NOT EXISTS(SELECT 1 FROM ingestion_automatic a WHERE a.preview_key=p.request_key)
      AND ((c.is_current=1 AND c.source_id=(SELECT local_source_id FROM source_rule WHERE id=?)) OR EXISTS(
        SELECT 1 FROM download_job_item ji JOIN download_source_demand d ON d.job_id=ji.job_id JOIN download_job j ON j.id=ji.job_id
        WHERE ji.item_id=c.managed_item_id AND d.source_id=? AND d.source_version=? AND d.review_required=0 AND ji.demand_state='ACTIVE' AND j.state NOT IN ('CANCELLED','CANCELLING')))
      ORDER BY p.rowid DESC LIMIT 20`).all(this.now(), expectedId ?? null, expectedId ?? null, sourceId, sourceId, source.version) as { id: string; plan_json: string; physical_version: number; revision: number | null }[];
    for (const row of rows) {
      const plan = JSON.parse(row.plan_json);
      if (plan.sourceVersion !== row.physical_version || (plan.recognitionRevision ?? 0) !== (row.revision ?? 0) || plan.target.path !== configuration.organization.targetPath || (configuration.organization.mediaType !== "AUTO" && plan.selection.mediaType !== configuration.organization.mediaType)) continue;
      if (hash({ configuration: configurationScope(configuration), input: stableGrant(plan.source), target: stableGrant(plan.target) }) !== scope) continue;
      if (plan.sourceLifecycles?.some((value: { id: string; revision: number }) => value.id === sourceId && value.revision !== source.lifecycle_revision)) continue;
      return automaticSampleSchema.parse({ previewId: row.id, title: plan.metadata.title, sourcePath: join(plan.source.path, ...plan.sourceSegments), targetPath: join(plan.target.path, ...plan.targetSegments), size: plan.snapshot.size });
    }
    return null;
  }
  prepare(sourceId: string, configuration: SourceConfiguration, previewId?: string) {
    if (!configuration.organization?.automatic) {
      if (previewId) throw new DesktopError("CONFLICT", "当前配置未开启自动整理，请重新预览配置");
      return { commit() {} };
    }
    const scope = this.scope(sourceId, configuration), sample = previewId ? this.sample(sourceId, configuration, previewId) : null;
    if (!scope || !sample) throw new DesktopError("CONFLICT", "请先在待处理生成当前范围与目标的 COPY 预览，再核对自动整理说明并确认配置");
    return { commit: () => {
      if (!this.database.connection.inTransaction) throw new Error("自动授权必须随来源配置事务提交");
      this.database.connection.prepare("INSERT INTO source_automatic_consent(source_id,scope_hash,preview_id,summary_json,acknowledged_at) VALUES(?,?,?,?,?) ON CONFLICT(source_id,scope_hash) DO UPDATE SET preview_id=excluded.preview_id,summary_json=excluded.summary_json,acknowledged_at=excluded.acknowledged_at")
        .run(sourceId, scope, sample.previewId, JSON.stringify(sample), new Date(this.now()).toISOString());
    } };
  }
  accepted(sourceId: string, configuration: SourceConfiguration) {
    const scope = this.scope(sourceId, configuration);
    return !!scope && !!this.database.connection.prepare("SELECT 1 FROM source_automatic_consent WHERE source_id=? AND scope_hash=?").get(sourceId, scope);
  }
}
