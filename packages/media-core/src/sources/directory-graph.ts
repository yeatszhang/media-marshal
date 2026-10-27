import { join, relative, isAbsolute, sep } from "node:path";
import { DesktopError, sourceConfigurationSchema, type RecognitionRuleSnapshot, type SyncSourceSnapshot } from "@media-marshal/contracts";
import type { CoreDatabase } from "../infrastructure/database.js";
import { pathsOverlap } from "../files/index.js";
import { managedRootGrantSchema } from "@media-marshal/contracts/internal";

interface Edge { id: string; name: string; kind: "sync" | "recognition"; input: string; targets: string[]; operational?: boolean }
/** 同步完成区接入识别是合法边；只有回到输入的链路及识别重复接管被阻断。 */
export function assertDirectoryGraph(database: CoreDatabase, kind: "sync" | "recognition", snapshot: SyncSourceSnapshot | RecognitionRuleSnapshot, legacySourceIds: string[] = []) {
  const grants = (database.connection.prepare("SELECT grant_json FROM configuration_directory WHERE grant_json IS NOT NULL UNION SELECT grant_json FROM media_target_root").all() as { grant_json: string }[]).flatMap((row) => { const result = managedRootGrantSchema.safeParse(JSON.parse(row.grant_json)); return result.success ? [result.data] : []; }).sort((a, b) => b.path.length - a.path.length);
  const policies = new Map<string, (typeof grants)[number]["volume"] | null>();
  const policy = (path: string) => { if (!policies.has(path)) policies.set(path, grants.find((grant) => { const part = relative(grant.path, path); return !part || part !== ".." && !part.startsWith(".." + sep) && !isAbsolute(part); })?.volume ?? null); return policies.get(path)!; };
  const overlap = (a: string, b: string) => { const first = policy(a), second = policy(b); return pathsOverlap(a, b, { caseSensitive: first?.caseSensitive === true && second?.caseSensitive === true, unicodeEquivalent: !first || !second || first.unicodeEquivalent || second.unicodeEquivalent }); };
  const edges: Edge[] = [];
  const syncEdge = (value: SyncSourceSnapshot): Edge | null => value.inputDirectory ? { id: value.sourceId, name: value.configuration.name, kind: "sync", input: value.inputDirectory.path, targets: [join(value.targetDirectory.path, "completed")] } : null;
  const recognitionEdge = (value: RecognitionRuleSnapshot): Edge => ({ id: value.ruleId, name: value.configuration.name, kind: "recognition", input: value.inputMode === "managed-completed" ? join(value.inputDirectory.path, "completed") : value.inputDirectory.path, targets: value.targets.map((target) => target.directory.path) });
  const candidate = kind === "sync" ? syncEdge(snapshot as SyncSourceSnapshot) : recognitionEdge(snapshot as RecognitionRuleSnapshot);
  for (const row of database.connection.prepare("SELECT v.snapshot_json FROM sync_source_rule r JOIN sync_source_version v ON v.source_id=r.id AND v.version=r.version WHERE r.deleted_at IS NULL").all() as { snapshot_json: string }[]) { const edge = syncEdge(JSON.parse(row.snapshot_json)); if (edge && !(kind === "sync" && edge.id === (snapshot as SyncSourceSnapshot).sourceId)) edges.push(edge); }
  for (const row of database.connection.prepare("SELECT v.snapshot_json FROM recognition_rule r JOIN recognition_rule_version v ON v.rule_id=r.id AND v.version=r.version WHERE r.deleted_at IS NULL").all() as { snapshot_json: string }[]) { const edge = recognitionEdge(JSON.parse(row.snapshot_json)); if (!(kind === "recognition" && edge.id === (snapshot as RecognitionRuleSnapshot).ruleId)) edges.push(edge); }
  // v28 后旧入口新建的本地识别也必须参与；迁移不能漏掉仍在执行的旧范围。
  for (const row of database.connection.prepare("SELECT r.id,v.configuration_json FROM source_rule r JOIN source_rule_version v ON v.source_id=r.id AND v.version=r.version LEFT JOIN legacy_configuration_owner o ON o.source_id=r.id WHERE r.deleted_at IS NULL AND coalesce(o.recognition_claimed,0)=0 AND json_extract(v.configuration_json,'$.organization') IS NOT NULL").all() as { id: string; configuration_json: string }[]) {
    if (legacySourceIds.includes(row.id) || edges.some((edge) => edge.kind === "recognition" && edge.id === row.id)) continue;
    const configuration = sourceConfigurationSchema.parse(JSON.parse(row.configuration_json));
    const root = configuration.type === "cloud" ? database.connection.prepare("SELECT canonical_path FROM managed_download_root WHERE id=?").get(configuration.downloadRootId) as { canonical_path: string } | undefined : null;
    const input = configuration.type === "local" ? configuration.sourcePath : root ? join(root.canonical_path, "completed") : null;
    if (input) edges.push({ id: "legacy:" + row.id, name: configuration.name, kind: "recognition", input, targets: [configuration.organization!.targetPath] });
  }
  if (candidate) edges.push(candidate);
  // 未完成文件计划仍保留原输入／目标；编辑当前规则不能抹掉恢复时可能出现的回流边。
  const pending = database.connection.prepare("SELECT DISTINCT json_extract(plan_json,'$.source.path') AS input,json_extract(plan_json,'$.target.path') AS target,json_extract(plan_json,'$.recognitionSnapshot.inputMode') AS mode,'recognition' AS kind FROM ingestion_operation WHERE phase!='RECORDED' UNION SELECT DISTINCT json_extract(plan_json,'$.source.path'),json_extract(plan_json,'$.target.path'),NULL,'sync' FROM local_sync_operation WHERE phase!='RECORDED' LIMIT 2001").all() as { input: string | null; target: string | null; mode: string | null; kind: "sync" | "recognition" }[];
  if (pending.length > 2000) throw new DesktopError("CONFLICT", "未完成目录链路超过两千项，请先处理原任务，再新增或调整目录关系");
  for (const [index, plan] of pending.entries()) if (plan.input && plan.target) edges.push({ id: `operation:${index}`, name: "原文件计划", kind: plan.kind, input: plan.mode === "managed-completed" ? join(plan.input, "completed") : plan.input, targets: [plan.kind === "sync" ? join(plan.target, "completed") : plan.target], operational: true });
  for (const edge of edges) if (edge.targets.some((target) => overlap(edge.input, target))) throw new DesktopError("UNSAFE_PATH", `规则「${edge.name}」的输入与目标相互包含，请选择独立目录`);
  if (candidate?.kind === "recognition") {
    const other = edges.find((edge) => edge !== candidate && !edge.operational && edge.kind === "recognition" && overlap(candidate.input, edge.input));
    if (other) throw new DesktopError("CONFLICT", `识别输入与「${other.name}」重叠，请调整输入或删除其接管规则后重新预览`);
  }
  const visited = new Set<Edge>(), active = new Set<Edge>();
  const walk = (edge: Edge) => {
    if (active.has(edge)) throw new DesktopError("UNSAFE_PATH", `目录链路经过「${edge.name}」回到输入，存在循环，请调整同步或识别目标`);
    if (visited.has(edge)) return;
    active.add(edge);
    for (const next of edges) if (edge.targets.some((target) => overlap(target, next.input))) walk(next);
    active.delete(edge); visited.add(edge);
  };
  for (const edge of edges) walk(edge);
}
