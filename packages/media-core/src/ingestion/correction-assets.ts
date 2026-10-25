import { createHash, randomUUID } from "node:crypto";
import { extname, join } from "node:path";
import { DesktopError } from "@media-marshal/contracts";
import { localFileEvidenceSchema, type LocalFileEvidence, type ManagedRootGrant } from "@media-marshal/contracts/internal";
import type { CoreDatabase } from "../infrastructure/database.js";
import type { ParsedMedia } from "../domain/media.js";
import type { MetadataWork } from "../domain/matching.js";
import { ManagedRoot, ManagedRoots, sameVolumeRoot } from "../files/index.js";
import { SourceRoot } from "../files/source-root.js";
import type { MediaSelection } from "./coordinates.js";
import type { PreparationProgress } from "./correction-preparations.js";

export const correctionHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface CorrectionAsset { id: string; kind: "MAIN" | "ACCESSORY"; from: { grant: ManagedRootGrant; segments: string[] }; to: { grant: ManagedRootGrant; segments: string[] }; expected: LocalFileEvidence | null; action: "NONE" | "MOVE" | "COPY" | "KEEP"; reason: string | null }
export interface CorrectionPlan { taskId: string; originalContext: string; connectionVersion: number; previewGeneration: string; target: ManagedRootGrant; targetSegments: string[]; template?: string; selection: MediaSelection; metadata: MetadataWork; parsed: ParsedMedia; files: CorrectionAsset[]; warnings: string[]; includeAccessories: boolean }
interface Task { id: string; source_id: string; source_path: string; status: string; target_path: string | null; title: string | null; parsed_json: string | null; metadata_json: string | null; confirmed_json: string | null; corrected_from_id: string | null; corrected_to_id: string | null; updated_at: string }
interface StoredAsset { plan_json: string; evidence_json: string | null; phase: string }
export const correctionConflict = (message: string) => new DesktopError("CONFLICT", message);
const associated = /\.(?:srt|ass|ssa|sub|idx|nfo|jpg|jpeg|png|webp|md5|vtt)$/i, generic = /^(?:poster|folder|cover)\.jpg$/i;
const equalEvidence = (a: LocalFileEvidence, b: LocalFileEvidence) => correctionHash(a) === correctionHash(b);
export function correctionTask(database: CoreDatabase, id: string) {
  const task = database.connection.prepare("SELECT id,source_id,source_path,status,target_path,title,parsed_json,metadata_json,confirmed_json,corrected_from_id,corrected_to_id,updated_at FROM media_task WHERE id=?").get(id) as Task | undefined;
  if (!task) throw correctionConflict("修正任务不存在，请刷新任务列表"); return task;
}
/** 文件归属来自原 COPY 或已记账修正收据；原下载路径只作为历史字符串，不作文件读取。 */
export function correctionReceipt(database: CoreDatabase, roots: ManagedRoots, taskId: string) {
  const db = database.connection, task = correctionTask(database, taskId);
  if (task.status !== "DONE" || task.corrected_to_id) throw correctionConflict("只有当前已完成的普通视频可以修正；请查看最新任务和历史链");
  const original = db.prepare("SELECT id,target_root_id,plan_json,evidence_json,phase FROM ingestion_operation WHERE task_id=? AND phase='RECORDED'").get(taskId) as (StoredAsset & { id: string; target_root_id: string }) | undefined;
  const corrected = db.prepare("SELECT id,target_root_id,plan_json,evidence_json,phase FROM media_correction_operation WHERE new_task_id=? AND phase='RECORDED'").get(taskId) as (StoredAsset & { id: string; target_root_id: string }) | undefined;
  const receipt = corrected ?? original; if (!receipt?.evidence_json) throw correctionConflict("此任务缺少已整理文件的可信收据，不能仅按目标路径认领文件；请核对原任务");
  const plan = JSON.parse(receipt.plan_json) as { target: ManagedRootGrant; targetSegments: string[]; parsed: ParsedMedia; selection: MediaSelection };
  if (!plan.parsed || !plan.target || !plan.targetSegments?.length || !/\.(?:mkv|mp4|avi|mov|m4v|ts|m2ts|wmv|flv|webm|mpg|mpeg|rmvb)$/i.test(plan.parsed.originalFilename) || join(plan.target.path, ...plan.targetSegments) !== task.target_path) throw correctionConflict("原任务的普通视频收据或目标路径不完整，不能自动认领其他文件");
  const root = roots.get(receipt.target_root_id); if (root.grant.path !== plan.target.path || !sameVolumeRoot(root.grant.volume, plan.target.volume)) throw new DesktopError("LOCAL_UNAVAILABLE", "原媒体目标目录或磁盘身份不符，请恢复原目标授权", true);
  root.segments(plan.targetSegments);
  const assets = corrected
    ? db.prepare("SELECT plan_json,evidence_json,phase FROM media_file_relocation WHERE item_id=? AND ordinal>0 ORDER BY ordinal,id").all(corrected.id) as StoredAsset[]
    : db.prepare("SELECT plan_json,evidence_json,phase FROM ingestion_accessory WHERE operation_id=? ORDER BY id").all(original!.id) as StoredAsset[];
  return { task, root, plan, expected: localFileEvidenceSchema.parse(JSON.parse(receipt.evidence_json)), assets: assets.map((asset) => { const value = JSON.parse(asset.plan_json); return { segments: (corrected ? value.to.segments : value.targetSegments) as string[], expected: asset.evidence_json ? localFileEvidenceSchema.parse(JSON.parse(asset.evidence_json)) : null, phase: asset.phase }; }), context: correctionHash({ task, receipt, assets }) };
}
export function correctionMode(from: CorrectionAsset["from"], to: CorrectionAsset["to"]) { return from.grant.id === to.grant.id && JSON.stringify(from.segments) === JSON.stringify(to.segments) ? "NONE" as const : from.grant.volume.volumeId === to.grant.volume.volumeId ? "MOVE" as const : "COPY" as const; }
export const correctionManifest = (files: CorrectionAsset[]) => correctionHash(files.map(({ id: _id, ...file }) => file));
export async function collectCorrectionAssets(receipt: ReturnType<typeof correctionReceipt>, target: ManagedRoot, targetSegments: string[], include: boolean, signal?: AbortSignal, progress?: (value: PreparationProgress) => void) {
  const from = receipt.root, main = receipt.plan.targetSegments;
  const inspect = (parts: string[]) => from.inspectForRelocation(parts, signal, progress && ((readBytes, totalBytes) => progress({ currentPath: join(from.grant.path, ...parts), readBytes, totalBytes })));
  const original = await inspect(main).then((value) => value.evidence).catch((error) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw correctionConflict(`已整理视频「${main.at(-1)}」当前缺失，请核对原目标或恢复原文件后重新预览；不会从下载来源补复制`); throw error; });
  if (!equalEvidence(original, receipt.expected)) throw correctionConflict(`「${main.at(-1)}」与已整理收据不符，请核对原媒体文件；不会重新读取下载原件`);
  const files: CorrectionAsset[] = [{ id: randomUUID(), kind: "MAIN", from: { grant: from.grant, segments: main }, to: { grant: target.grant, segments: targetSegments }, expected: original, action: correctionMode({ grant: from.grant, segments: main }, { grant: target.grant, segments: targetSegments }), reason: null }], warnings: string[] = [];
  const base = (name: string) => name.slice(0, name.length - extname(name).length), sourceBase = base(main.at(-1)!), targetBase = base(targetSegments.at(-1)!), reader = await SourceRoot.open(from.grant);
  let discovered: string[][]; try { discovered = await reader.filesIn(main.slice(0, -1)); } finally { await reader.close(); }
  const entries = new Map<string, { segments: string[]; known?: typeof receipt.assets[number] }>();
  for (const entry of discovered) { const name = entry.at(-1)!; if (generic.test(name) || associated.test(name) && name.startsWith(sourceBase + ".")) entries.set(JSON.stringify(entry), { segments: entry }); }
  for (const asset of receipt.assets) entries.set(JSON.stringify(asset.segments), { segments: asset.segments, known: asset });
  for (const [, entry] of [...entries].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    const name = entry.segments.at(-1)!, side = { grant: from.grant, segments: entry.segments }; let expected: LocalFileEvidence | null = null, reason: string | null = null;
    try { expected = (await inspect(entry.segments)).evidence; if (entry.known?.expected && !equalEvidence(expected, entry.known.expected)) throw correctionConflict(`附属文件「${name}」与原收据不符，请先核对文件；未覆盖或删除`); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; reason = `历史附属文件「${name}」当前缺失，本次保留该历史，不从下载来源补复制`; }
    if (!reason && generic.test(name)) reason = `通用封面「${name}」留在原目录，不随单个视频移动`;
    if (!reason && (!associated.test(name) || !name.startsWith(sourceBase + "."))) reason = `历史附属文件「${name}」与当前视频不同名，保留原位`;
    if (!reason && !include) reason = `未选择移动附属文件，「${name}」保留原位`;
    if (entry.known && !["RECORDED", "DONE"].includes(entry.known.phase)) warnings.push(`附属文件「${name}」的原尝试尚未完成；本次只处理预览中核验的现存媒体目标，原尝试保留历史`);
    const to = reason ? side : { grant: target.grant, segments: [...targetSegments.slice(0, -1), targetBase + name.slice(sourceBase.length)] };
    files.push({ id: randomUUID(), kind: "ACCESSORY", from: side, to, expected, action: reason ? "KEEP" : correctionMode(side, to), reason });
    if (reason) warnings.push(reason); else if (/\.md5$/i.test(name)) warnings.push(`「${name}」只移动或改名，不修改校验文件内容`);
    if (files.length > 201 || warnings.length > 201) throw correctionConflict("附属文件超过本次预览上限，请先核对并缩小单个视频的附属范围");
  }
  target.assertMappings(files.filter((file) => file.action !== "KEEP").map((file) => file.to.segments)); return { files, warnings };
}

/** 新整理与修正统一核对活动步骤及当前修正收据，防止共享文件位置被另一入口领取。 */
export function assertCorrectionTarget(database: CoreDatabase, root: ManagedRoot, segments: string[], exceptTaskId?: string) {
  const normalize = (parts: string[]) => root.mappingIdentity(parts).join("/"), current = normalize(segments), overlap = (other: string) => current === other || current.startsWith(other + "/") || other.startsWith(current + "/");
  const rows = database.connection.prepare(`SELECT f.plan_json,f.recorded,c.task_id AS original_task_id,o.new_task_id,t.status FROM media_file_relocation f JOIN correction_item c ON c.id=f.item_id
    LEFT JOIN media_correction_operation o ON o.id=c.id LEFT JOIN media_task t ON t.id=o.new_task_id WHERE (f.from_root_id=? OR f.to_root_id=?) AND (f.recorded=0 OR t.status!='CORRECTED')`).iterate(root.grant.id, root.grant.id) as Iterable<{ plan_json: string; recorded: number; original_task_id: string; new_task_id: string | null; status: string | null }>;
  for (const row of rows) {
    if (row.recorded ? row.new_task_id === exceptTaskId : row.original_task_id === exceptTaskId) continue;
    const plan = JSON.parse(row.plan_json) as { from: CorrectionAsset["from"]; to: CorrectionAsset["to"] };
    for (const side of row.recorded ? [plan.to] : [plan.from, plan.to]) if (side.grant.id === root.grant.id && overlap(normalize(side.segments))) throw correctionConflict("此媒体位置已由另一修正任务占用，请查看原作业并处理后重新预览");
  }
  const operations = database.connection.prepare("SELECT o.plan_json FROM ingestion_operation o JOIN media_task t ON t.id=o.task_id WHERE o.target_root_id=? AND t.status!='CORRECTED' AND t.id!=?").iterate(root.grant.id, exceptTaskId ?? "") as Iterable<{ plan_json: string }>;
  for (const row of operations) { const plan = JSON.parse(row.plan_json) as { targetSegments?: string[] }; if (plan.targetSegments?.length && overlap(normalize(plan.targetSegments))) throw correctionConflict("此媒体位置已由已领取的整理任务占用，请核对原任务后重新预览"); }
}
