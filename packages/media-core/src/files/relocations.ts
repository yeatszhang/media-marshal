import { randomUUID } from "node:crypto";
import { open } from "node:fs/promises";
import { z } from "zod";
import { CloudError, DesktopError } from "@media-marshal/contracts";
import { localFileEvidenceSchema, managedRootGrantSchema, type LocalFileEvidence } from "@media-marshal/contracts/internal";
import { CoreDatabase } from "../infrastructure/database.js";
import { ManagedRoot, ManagedRoots, assertSpaceBudget, sameVolumeRoot } from "./index.js";
import { SourceRoot } from "./source-root.js";
import type { NativeRenameApi, NativeRenameResult } from "./native-rename.js";

const sideSchema = z.strictObject({ grant: managedRootGrantSchema, segments: z.array(z.string().min(1).max(255)).min(1).max(128) });
const planSchema = z.strictObject({ from: sideSchema, to: sideSchema, expected: localFileEvidenceSchema, mode: z.enum(["NONE", "MOVE", "COPY"]) });
export type RelocationPlan = z.infer<typeof planSchema>;
type Phase = "PENDING" | "COPYING" | "VERIFIED" | "QUARANTINED" | "PUBLISHED" | "OLD_QUARANTINED" | "REMOVING_OLD" | "OLD_REMOVED" | "DONE" | "NEEDS_ATTENTION";
export interface RelocationRow { id: string; item_id: string; ordinal: number; plan_json: string; phase: Phase; resume_phase: Phase | null; attempt_id: string | null; stage_evidence_json: string | null; evidence_json: string | null; recorded: number; failure_code: string | null; failure: string | null; waiting_reason: string | null; next_attempt_at: number }
const sameEvidence = (a: LocalFileEvidence, b: LocalFileEvidence) => a.volumeId === b.volumeId && a.inode === b.inode && a.birthtimeNs === b.birthtimeNs && a.modifiedNs === b.modifiedNs && a.size === b.size && a.sha256 === b.sha256;
const conflict = () => new DesktopError("CONFLICT", "修正文件的原位置、隔离位置或新位置与计划不符，已保留现存文件；请核对逐项记录后重试");
const stamp = (now: () => number) => new Date(now()).toISOString();

/** 只执行已持久化的媒体目标文件计划；不读取下载来源，也不自行创建任务历史或 Emby 交付。 */
export class FileRelocations {
  private readonly flights = new Map<string, Promise<RelocationRow>>();
  private controller = new AbortController();
  private closed = false;
  constructor(private readonly database: CoreDatabase, private readonly roots: ManagedRoots, private readonly native: NativeRenameApi, private readonly now = Date.now, private readonly mayRun = () => true) {}
  get(id: string) { const row = this.database.connection.prepare("SELECT * FROM media_file_relocation WHERE id=?").get(id) as RelocationRow | undefined; if (!row) throw new DesktopError("CONFLICT", "修正文件步骤不存在，请刷新作业列表"); return row; }
  list(itemId: string) { return this.database.connection.prepare("SELECT * FROM media_file_relocation WHERE item_id=? ORDER BY ordinal,id").all(itemId) as RelocationRow[]; }
  private root(side: RelocationPlan["from"]) {
    const registered = this.database.connection.prepare("SELECT grant_json FROM media_target_root WHERE id=?").get(side.grant.id) as { grant_json: string } | undefined;
    if (!registered) throw new DesktopError("LOCAL_UNAVAILABLE", "修正计划中的原媒体目标授权不可用，请恢复原目录授权", true);
    const grant = managedRootGrantSchema.parse(JSON.parse(registered.grant_json)), root = this.roots.get(grant.id);
    if (grant.path !== side.grant.path || !sameVolumeRoot(grant.volume, side.grant.volume) || root.grant.path !== grant.path || !sameVolumeRoot(root.grant.volume, grant.volume)) throw new DesktopError("LOCAL_UNAVAILABLE", "修正计划中的原磁盘或根目录已变化，请恢复原目标后重试", true);
    return root;
  }
  /** 调用方可在建立 correction_item 的同一短事务内为全部成员登记；此处不做媒体文件写入。 */
  plan(input: { id: string; itemId: string; ordinal: number; from: RelocationPlan["from"]; to: RelocationPlan["to"]; expected: LocalFileEvidence }) {
    z.strictObject({ id: z.uuid(), itemId: z.uuid(), ordinal: z.number().int().nonnegative(), from: sideSchema, to: sideSchema, expected: localFileEvidenceSchema }).parse(input);
    if (this.closed) throw new DesktopError("INTERRUPTED", "修正服务正在停止", true);
    const from = this.root(input.from), to = this.root(input.to); from.segments(input.from.segments); to.segments(input.to.segments);
    if (input.expected.volumeId !== input.from.grant.volume.volumeId) throw conflict();
    const mode = input.from.grant.id === input.to.grant.id && JSON.stringify(input.from.segments) === JSON.stringify(input.to.segments) ? "NONE" : input.from.grant.volume.volumeId === input.to.grant.volume.volumeId ? "MOVE" : "COPY";
    const plan = planSchema.parse({ from: input.from, to: input.to, expected: input.expected, mode }), json = JSON.stringify(plan), db = this.database.connection;
    return db.transaction(() => {
      const previous = db.prepare("SELECT * FROM media_file_relocation WHERE id=?").get(input.id) as RelocationRow | undefined;
      if (previous) { if (previous.item_id !== input.itemId || previous.ordinal !== input.ordinal || previous.plan_json !== json) throw conflict(); return previous; }
      if (!db.prepare("SELECT 1 FROM correction_item WHERE id=? AND state IN ('PENDING','RUNNING')").get(input.itemId)) throw conflict();
      const key = (root: ManagedRoot, parts: string[]) => root.mappingIdentity(parts).join("/"), intersects = (a: string, b: string) => a === b || a.startsWith(b + "/") || b.startsWith(a + "/");
      for (const row of db.prepare("SELECT plan_json FROM media_file_relocation WHERE recorded=0 AND (from_root_id IN (?,?) OR to_root_id IN (?,?))").iterate(from.grant.id, to.grant.id, from.grant.id, to.grant.id) as Iterable<{ plan_json: string }>) {
        const other = planSchema.parse(JSON.parse(row.plan_json));
        for (const [root, current] of [[from, plan.from], [to, plan.to]] as const) for (const side of [other.from, other.to]) if (side.grant.id === current.grant.id && intersects(key(root, current.segments), key(root, side.segments))) throw new DesktopError("CONFLICT", "文件位置已被另一修正步骤占用，请先处理原作业");
      }
      const time = stamp(this.now);
      db.prepare("INSERT INTO media_file_relocation(id,item_id,ordinal,from_root_id,from_slot,to_root_id,to_slot,plan_json,phase,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'PENDING',?,?)").run(input.id, input.itemId, input.ordinal, from.grant.id, from.slotKey(plan.from.segments), to.grant.id, to.slotKey(plan.to.segments), json, time, time);
      return this.get(input.id);
    })();
  }
  private advance(id: string, phase: Phase, values: { attempt?: string; stage?: LocalFileEvidence; evidence?: LocalFileEvidence } = {}) {
    this.database.connection.prepare("UPDATE media_file_relocation SET phase=?,resume_phase=NULL,attempt_id=COALESCE(?,attempt_id),stage_evidence_json=COALESCE(?,stage_evidence_json),evidence_json=COALESCE(?,evidence_json),failure_code=NULL,failure=NULL,waiting_reason=NULL,next_attempt_at=0,updated_at=? WHERE id=?").run(phase, values.attempt ?? null, values.stage ? JSON.stringify(values.stage) : null, values.evidence ? JSON.stringify(values.evidence) : null, stamp(this.now), id);
  }
  private async probe(root: ManagedRoot, parts: string[], expected: LocalFileEvidence, signal?: AbortSignal) {
    try { const current = await root.inspectForRelocation(parts, signal); if (!sameEvidence(current.evidence, expected)) throw conflict(); return current; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  private renamed(result: NativeRenameResult) {
    if (result.state === "RENAMED") return;
    if (result.state === "UNCERTAIN" || ["UNAVAILABLE", "SYNC_FAILED", "INTERRUPTED"].includes(result.code)) throw new DesktopError("LOCAL_UNAVAILABLE", "改名结果仍需按原计划核对，请恢复原磁盘和目录后重试；现存文件已保留", true);
    if (result.code === "UNSUPPORTED") throw new DesktopError("UNSUPPORTED_CAPABILITY", "目标文件系统不支持独占改名，请保留文件并重新预览兼容目标");
    throw conflict();
  }
  private evidence(json: string | null) { if (!json) throw conflict(); return localFileEvidenceSchema.parse(JSON.parse(json)); }
  private async confirmFinal(row: RelocationRow, plan: RelocationPlan, target: ManagedRoot, signal?: AbortSignal) {
    const expected = this.evidence(row.evidence_json);
    try { return await target.confirmRelocation(plan.to.segments, expected, signal); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || plan.mode !== "COPY" || !row.attempt_id) throw error;
      // 历史记账前保留的原暂存锚点可重建缺失目标；绝不借用下载原件或覆盖陌生文件。
      const published = await target.publishRelocationStage(row.attempt_id, plan.to.segments, this.evidence(row.stage_evidence_json), this.native, signal); if (!sameEvidence(published, expected)) throw conflict(); return published;
    }
  }
  private async step(row: RelocationRow, plan: RelocationPlan, signal: AbortSignal) {
    const to = this.root(plan.to), quarantine = to.relocationSegments(row.id);
    if (plan.mode === "NONE") { const evidence = await to.confirmRelocation(plan.to.segments, plan.expected, signal); this.advance(row.id, "DONE", { evidence }); return; }
    if ((row.phase === "PUBLISHED" && plan.mode === "MOVE") || row.phase === "OLD_REMOVED") { const evidence = await this.confirmFinal(row, plan, to, signal); this.advance(row.id, "DONE", { evidence }); return; }
    if (row.phase === "VERIFIED") { const evidence = await to.publishRelocationStage(row.attempt_id!, plan.to.segments, this.evidence(row.stage_evidence_json), this.native, signal); this.advance(row.id, "PUBLISHED", { evidence }); return; }
    if (["PUBLISHED", "OLD_QUARANTINED"].includes(row.phase)) await this.confirmFinal(row, plan, to, signal);
    const from = this.root(plan.from);
    if (row.phase === "PENDING") {
      const source = await this.probe(from, plan.from.segments, plan.expected, signal), isolated = await this.probe(from, quarantine, plan.expected, signal);
      if (plan.mode === "COPY") {
        if (!source || isolated) throw conflict(); await to.assertVacant(plan.to.segments); assertSpaceBudget(await to.check(), plan.expected.size); this.advance(row.id, "COPYING", { attempt: randomUUID() }); return;
      }
      if (source && isolated || !source && !isolated) throw conflict();
      if (source) {
        // 大小写不敏感卷的目标仍指向旧目录项；先隔离旧项，再让独占发布检查真实占用。
        const alias = from.grant.id === to.grant.id && from.slotKey(plan.from.segments) === to.slotKey(plan.to.segments);
        if (!alias && await this.probe(to, plan.to.segments, plan.expected, signal)) throw conflict();
        if (!this.mayRun()) throw new CloudError("INTERRUPTED"); this.renamed(await from.renameForRelocation(plan.from.segments, from, quarantine, source.snapshot, this.native, signal));
      }
      // 已收到原生独占改名回执即可记隔离阶段；发布前仍会完整核验隔离文件。
      if (!source) await from.confirmRelocation(quarantine, plan.expected, signal); this.advance(row.id, "QUARANTINED"); return;
    }
    if (row.phase === "QUARANTINED") {
      const isolated = await this.probe(from, quarantine, plan.expected, signal), target = await this.probe(to, plan.to.segments, plan.expected, signal);
      if (isolated && target || !isolated && !target) throw conflict();
      if (isolated) { if (!this.mayRun()) throw new CloudError("INTERRUPTED"); this.renamed(await from.renameForRelocation(quarantine, to, plan.to.segments, isolated.snapshot, this.native, signal)); }
      const evidence = isolated ? isolated.evidence : await to.confirmRelocation(plan.to.segments, plan.expected, signal); this.advance(row.id, "PUBLISHED", { evidence }); return;
    }
    if (row.phase === "COPYING") { await this.copy(row, plan, from, to, signal); return; }
    if (row.phase === "PUBLISHED") {
      const source = await this.probe(from, plan.from.segments, plan.expected, signal), isolated = await this.probe(from, quarantine, plan.expected, signal);
      if (source && isolated || !source && !isolated) throw conflict();
      if (source) { if (!this.mayRun()) throw new CloudError("INTERRUPTED"); this.renamed(await from.renameForRelocation(plan.from.segments, from, quarantine, source.snapshot, this.native, signal)); }
      if (!source) await from.confirmRelocation(quarantine, plan.expected, signal); this.advance(row.id, "OLD_QUARANTINED"); return;
    }
    if (row.phase === "OLD_QUARANTINED") {
      if (await this.probe(from, plan.from.segments, plan.expected, signal)) throw conflict(); await from.confirmRelocation(quarantine, plan.expected, signal); this.advance(row.id, "REMOVING_OLD"); return;
    }
    if (row.phase === "REMOVING_OLD") {
      if (await this.probe(from, plan.from.segments, plan.expected, signal)) throw conflict();
      try { await from.removeRelocation(row.id, plan.expected, async () => { if (!this.mayRun()) throw new CloudError("INTERRUPTED"); await this.confirmFinal(row, plan, to, signal); }, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await this.confirmFinal(row, plan, to, signal); }
      this.advance(row.id, "OLD_REMOVED"); return;
    }
    throw conflict();
  }
  private async copy(row: RelocationRow, plan: RelocationPlan, from: ManagedRoot, to: ManagedRoot, signal: AbortSignal) {
    // 中断的 COPY 只清理本 attempt；标记缺失时保留未知私有目录并使用新 UUID。
    if (row.attempt_id) try { await to.cleanupAttempt(row.attempt_id); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const attempt = randomUUID(); this.advance(row.id, "COPYING", { attempt });
    const current = await from.inspectForRelocation(plan.from.segments, signal); if (!sameEvidence(current.evidence, plan.expected)) throw conflict();
    await to.assertVacant(plan.to.segments); assertSpaceBudget(await to.check(), plan.expected.size); await to.prepareStage(attempt);
    const reader = await SourceRoot.open(from.grant);
    try {
      const snapshot = await reader.inspect(plan.from.segments);
      if (snapshot.inode !== plan.expected.inode || snapshot.birthtimeNs !== plan.expected.birthtimeNs || snapshot.modifiedNs !== plan.expected.modifiedNs || snapshot.size !== plan.expected.size) throw conflict();
      await reader.read(plan.from.segments, snapshot, async (source) => {
        const destination = await open(await to.stageFilePath(attempt, plan.to.segments), "wx", 0o600); let position = 0;
        try {
          const sha = await reader.digest(source, snapshot.size, signal, async (bytes) => { let offset = 0; while (offset < bytes.length) { if (signal.aborted) throw new CloudError("INTERRUPTED"); const { bytesWritten } = await destination.write(bytes, offset, bytes.length - offset, position); if (!bytesWritten) throw new CloudError("LOCAL_UNAVAILABLE"); offset += bytesWritten; position += bytesWritten; } });
          if (sha !== plan.expected.sha256) throw conflict(); await destination.sync();
        } finally { await destination.close(); }
      });
      const stage = await to.verifyStage(attempt, plan.to.segments, plan.expected.size, undefined, signal); if (stage.sha256 !== plan.expected.sha256) throw conflict(); this.advance(row.id, "VERIFIED", { stage });
    } finally { await reader.close(); }
  }
  private fail(id: string, error: unknown) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "CONFLICT", waiting = ["LOCAL_UNAVAILABLE", "INTERRUPTED", "BUSY", "ENOSPC", "EACCES", "EPERM", "EROFS", "EIO", "ENODEV", "ENXIO", "ESTALE"].includes(code);
    const plan = planSchema.parse(JSON.parse(this.get(id).plan_json)), object = `修正文件「${plan.from.segments.at(-1)}」：`;
    const reason = code === "INTERRUPTED" ? "操作已暂停或服务正在停止；现存文件已保留，恢复整理后从原阶段继续" : code === "BUSY" ? "文件操作等待数已达上限，请等待在途操作完成后重试" : code === "ENOSPC" ? "媒体目标磁盘空间不足，请释放空间后从原步骤重试" : ["EACCES", "EPERM", "EROFS"].includes(code) ? "媒体目标目录不可写，请恢复读写权限或解除只读状态后重试" : waiting ? "原媒体目标磁盘或目录当前不可用，请连接原盘、恢复原目录授权后重试" : code === "UNSUPPORTED_CAPABILITY" ? "文件系统不支持原计划的安全操作，现存文件已保留，请使用兼容目标核对原作业；更换目标必须重新预览" : "文件位置或内容与原计划不符，现存文件已保留，请核对原位置、私有隔离位置与新位置后重试";
    const failure = object + reason;
    this.database.connection.prepare("UPDATE media_file_relocation SET resume_phase=CASE WHEN ? THEN NULL ELSE phase END,phase=CASE WHEN ? THEN phase ELSE 'NEEDS_ATTENTION' END,failure_code=?,failure=?,waiting_reason=?,next_attempt_at=?,updated_at=? WHERE id=?").run(Number(waiting), Number(waiting), waiting ? code === "INTERRUPTED" ? code : "LOCAL_UNAVAILABLE" : code === "UNSUPPORTED_CAPABILITY" ? code : "CONFLICT", waiting ? null : failure, waiting ? failure : null, waiting ? this.now() + 5000 : 0, stamp(this.now), id);
  }
  run(id: string, signal?: AbortSignal): Promise<RelocationRow> {
    const previous = this.flights.get(id); if (previous) return previous;
    if (this.closed) return Promise.reject(new DesktopError("INTERRUPTED", "修正服务正在停止", true));
    const active = AbortSignal.any([this.controller.signal, ...(signal ? [signal] : [])]);
    const flight = (async () => {
      try {
        for (;;) {
          const row = this.get(id); if (row.recorded || row.phase === "NEEDS_ATTENTION" || row.next_attempt_at > this.now()) return row;
          if (active.aborted || !this.mayRun()) throw new CloudError("INTERRUPTED");
          const plan = planSchema.parse(JSON.parse(row.plan_json));
          if (row.phase === "DONE") { await this.confirmFinal(row, plan, this.root(plan.to), active); return this.get(id); }
          await this.step(row, plan, active);
          if (this.get(id).phase === "DONE") return this.get(id);
        }
      } catch (error) { const row = this.get(id); if (row.phase === "DONE" && !row.recorded) { const plan = planSchema.parse(JSON.parse(row.plan_json)); this.advance(id, plan.mode === "COPY" ? "OLD_REMOVED" : plan.mode === "MOVE" ? "PUBLISHED" : "PENDING"); } this.fail(id, error); return this.get(id); }
    })().finally(() => { if (this.flights.get(id) === flight) this.flights.delete(id); }); this.flights.set(id, flight); return flight;
  }
  retry(id: string) { const row = this.get(id); if (row.recorded || row.phase === "DONE") return row; if (row.phase === "NEEDS_ATTENTION") { if (!row.resume_phase || row.resume_phase === "NEEDS_ATTENTION") throw conflict(); this.advance(id, row.resume_phase); } else this.database.connection.prepare("UPDATE media_file_relocation SET next_attempt_at=0,waiting_reason=NULL,failure_code=NULL,updated_at=? WHERE id=?").run(stamp(this.now), id); return this.get(id); }
  /** 历史事务已将成员标为 RECORDED 后才释放文件位置；文件 DONE 本身不释放活动占用。 */
  releaseRecorded(itemId: string) { const db = this.database.connection; db.transaction(() => { if (!db.prepare("SELECT 1 FROM correction_item WHERE id=? AND state='RECORDED'").get(itemId) || db.prepare("SELECT 1 FROM media_file_relocation WHERE item_id=? AND phase!='DONE'").get(itemId)) throw conflict(); db.prepare("UPDATE media_file_relocation SET recorded=1,updated_at=? WHERE item_id=?").run(stamp(this.now), itemId); })(); }
  async cleanupRecorded(id: string, signal?: AbortSignal) { const row = this.get(id), plan = planSchema.parse(JSON.parse(row.plan_json)); if (!row.recorded || row.phase !== "DONE") throw conflict(); if (plan.mode !== "COPY") return; const target = this.root(plan.to); await target.confirmRelocation(plan.to.segments, this.evidence(row.evidence_json), signal); if (row.attempt_id) { try { const stage = await target.verifyStage(row.attempt_id, plan.to.segments, plan.expected.size, undefined, signal); if (!sameEvidence(stage, this.evidence(row.stage_evidence_json))) throw conflict(); await target.cleanupAttempt(row.attempt_id); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } } }
  interrupt() { this.controller.abort(); this.controller = new AbortController(); }
  async close() { this.closed = true; this.interrupt(); await Promise.allSettled(this.flights.values()); }
}
