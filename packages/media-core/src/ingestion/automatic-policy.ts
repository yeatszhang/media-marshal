import { sourceConfigurationSchema, type SourceConfiguration } from "@media-marshal/contracts";
import { localFileEvidenceSchema } from "@media-marshal/contracts/internal";
import type { CoreDatabase } from "../infrastructure/database.js";
import { resolveManagedOrganization } from "../sources/organization.js";
import { AutomaticConsents } from "../sources/automatic-consent.js";
import type { AutomaticAvailability } from "./automatic.js";

interface Candidate {
  id: string; source_id: string; version_key: string; is_current: number; state: string; relative_json: string;
  snapshot_json: string; expected_sha256: string | null; managed_item_id: string | null; managed_version_key: string | null;
  available: number; physical_version: number; physical_paused: number; download_root_id: string | null;
}
interface Rule { id: string; version: number; lifecycle_revision: number; paused: number; review_required: number; configuration_json: string }
interface Capture { candidateId: string; sourceId: string; context: string }
/** 权限来自已确认来源和首次预览收据；就绪证据不从客户端标签或文件稳定性推断。 */
export class AutomaticPolicies {
  readonly consents: AutomaticConsents;
  constructor(private readonly database: CoreDatabase) { this.consents = new AutomaticConsents(database); }
  private candidate(id: string) {
    return this.database.connection.prepare("SELECT c.*,i.available,i.download_root_id,s.version AS physical_version,s.paused AS physical_paused FROM ingestion_candidate c JOIN ingestion_source i ON i.source_id=c.source_id JOIN desktop_source s ON s.id=c.source_id WHERE c.id=?").get(id) as Candidate | undefined;
  }
  private rules(candidate: Candidate) {
    return this.database.connection.prepare(`SELECT DISTINCT s.id,s.version,s.lifecycle_revision,s.paused,s.review_required,v.configuration_json
      FROM source_rule s JOIN source_rule_version v ON v.source_id=s.id AND v.version=s.version
      LEFT JOIN download_source_demand d ON d.source_id=s.id AND d.source_version=s.version AND d.review_required=0
      LEFT JOIN download_job_item ji ON ji.job_id=d.job_id AND ji.demand_state='ACTIVE'
      LEFT JOIN download_job j ON j.id=ji.job_id
      WHERE s.deleted_at IS NULL AND (s.local_source_id=? OR (ji.item_id=? AND j.state NOT IN ('CANCELLED','CANCELLING')))
      ORDER BY s.id`).all(candidate.source_id, candidate.managed_item_id) as Rule[];
  }
  capture(id: string): Capture | null {
    const candidate = this.candidate(id);
    if (!candidate || ["PROCESSED", "SKIPPED", "SUPERSEDED"].includes(candidate.state) || (!candidate.managed_item_id && !candidate.is_current)) return null;
    const rules = this.rules(candidate), authorizers = rules.filter((rule) => {
      const configuration = sourceConfigurationSchema.parse(JSON.parse(rule.configuration_json));
      return !rule.review_required && configuration.organization?.automatic && this.consents.accepted(rule.id, configuration);
    });
    if (!authorizers.length) return null;
    const rule = authorizers[0]!, configuration = sourceConfigurationSchema.parse(JSON.parse(rule.configuration_json));
    return { candidateId: id, sourceId: rule.id, context: JSON.stringify({ sourceId: rule.id, version: rule.version, lifecycle: rule.lifecycle_revision, scope: this.consents.scope(rule.id, configuration), candidateVersion: candidate.version_key, physicalVersion: candidate.physical_version }) };
  }
  check(id: string, sourceId: string, context: string): AutomaticAvailability {
    const candidate = this.candidate(id), captured = this.capture(id);
    if (!candidate || !captured || captured.sourceId !== sourceId || captured.context !== context) return { state: "MANUAL", reason: "自动授权、来源版本或文件版本已变化，请在待处理重新预览" };
    const rules = this.rules(candidate), rule = rules.find((value) => value.id === sourceId)!;
    if (candidate.physical_paused || rule.paused || this.database.connection.prepare("SELECT 1 FROM app_setting WHERE key='ingestion.paused' AND value='true'").get()) return { state: "WAITING", reason: "来源或全部整理已暂停，原自动意图保留；恢复后重新观察" };
    if (rule.review_required) return { state: "MANUAL", reason: "来源归属需要核对，请重新预览并确认来源配置" };
    if (!candidate.available) return { state: "WAITING", reason: "等待原磁盘和目录授权恢复，不接管同名替代目录" };
    const configuration = sourceConfigurationSchema.parse(JSON.parse(rule.configuration_json));
    if (!this.database.connection.prepare("SELECT 1 FROM media_target_root WHERE json_extract(grant_json,'$.path')=? AND available=1").get(configuration.organization?.targetPath ?? "")) return { state: "WAITING", reason: "等待原媒体目标及目录授权恢复" };
    if (configuration.type === "local") return this.localReadiness(configuration);
    // 共享自动权限的产品规则尚待确认；此分支不以任意一个来源替其他来源授权。
    if (rules.length !== 1) return { state: "MANUAL", reason: "此文件有多个有效来源，自动执行权限需要核对；请人工预览并确认" };
    const policy = resolveManagedOrganization(this.database, candidate.managed_item_id!, candidate.managed_version_key!);
    if (policy.state !== "ENABLED" || !policy.policy.configuration.automatic) return { state: "MANUAL", reason: "下载完成项没有唯一有效的自动整理策略，请人工核对来源" };
    const row = this.database.connection.prepare("SELECT i.state,i.failure_code,i.target_root_id,i.target_segments_json,c.file_evidence_json FROM download_item i JOIN download_commit_intent c ON c.item_id=i.id AND c.state='RECORDED' WHERE i.id=? AND i.version_key=?").get(candidate.managed_item_id, candidate.managed_version_key) as { state: string; failure_code: string | null; target_root_id: string; target_segments_json: string; file_evidence_json: string } | undefined;
    if (!row || row.target_root_id !== candidate.download_root_id || JSON.stringify(["completed", ...JSON.parse(row.target_segments_json)]) !== candidate.relative_json) return { state: "MANUAL", reason: "缺少该文件正式下载提交的完成证据，请人工核对" };
    if (row.state === "RECONCILING") return row.failure_code && row.failure_code !== "LOCAL_UNAVAILABLE" ? { state: "MANUAL", reason: "下载成果恢复核验未通过，请检查云端下载记录和原文件后人工重新预览" } : { state: "WAITING", reason: "下载成果正在恢复核验，等待原文件身份与摘要通过后继续观察" };
    if (row.state !== "COMPLETED") return { state: "MANUAL", reason: "该下载项尚无有效完成状态，请人工核对原下载记录" };
    if (this.database.connection.prepare("SELECT 1 FROM download_attempt a JOIN download_attempt_item ai ON ai.attempt_id=a.id WHERE ai.item_id=? AND a.state IN ('CLAIMED','RUNNING','STOPPING','UNCERTAIN')").get(candidate.managed_item_id)) return { state: "WAITING", reason: "下载写入者尚未完成回收，等待正式完成证据稳定" };
    const parsed = localFileEvidenceSchema.safeParse(JSON.parse(row.file_evidence_json)), snapshot = JSON.parse(candidate.snapshot_json);
    if (!parsed.success || parsed.data.sha256 !== candidate.expected_sha256 || parsed.data.size !== snapshot.size || parsed.data.inode !== snapshot.inode || parsed.data.birthtimeNs !== snapshot.birthtimeNs || parsed.data.modifiedNs !== snapshot.modifiedNs) return { state: "MANUAL", reason: "下载完成证据与当前文件身份或摘要不一致，请复核原文件后预览" };
    return { state: "READY" };
  }
  private localReadiness(configuration: Extract<SourceConfiguration, { type: "local" }>): AutomaticAvailability {
    // 当前官方行为矩阵不完整，没有可自动放行的本地客户端配置；不得注入猜测的已验证版本。
    return { state: "MANUAL", reason: configuration.client === "quark" ? "当前夸克客户端的暂停、预分配等行为尚未完整验证，请到官方客户端确认完整下载后人工整理" : "此本地来源没有经验证的下载完成规则，请确认文件完整后人工整理" };
  }
}
