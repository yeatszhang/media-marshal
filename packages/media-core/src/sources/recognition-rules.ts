import { createHash, randomUUID } from "node:crypto";
import { DesktopError, recognitionRuleConfigurationSchema, recognitionRuleSchema, recognitionRuleSnapshotSchema, type CoreInput, type CoreOutput, type RecognitionRule, type RecognitionRuleSnapshot } from "@media-marshal/contracts";
import type { CoreDatabase } from "../infrastructure/database.js";
import type { IngestionPipeline } from "../ingestion/pipeline.js";
import type { ConfigurationDirectories } from "./configuration-directories.js";
import { assertDirectoryGraph } from "./directory-graph.js";
import { recognitionLegacyFingerprint } from "../infrastructure/independent-recognition-migration.js";
import { recognitionEmbyBinding, recognitionScopeHash } from "../ingestion/recognition-routing.js";
import { SourceScans } from "./scans.js";

interface Row { id: string; version: number; draft_revision: number; lifecycle_revision: number; draft_json: string; paused: number; deleted_at: string | null; review_json: string; created_at: string; updated_at: string }
interface Preview { id: string; rule_id: string; request_key: string; version: number; draft_revision: number; lifecycle_revision: number; snapshot_json: string; default_dependency: number; state: "READY" | "APPLIED" | "EXPIRED"; expires_at: number }
const conflict = (message = "识别配置、目录或预览版本已变化，请刷新并重新预览") => new DesktopError("CONFLICT", message);
const signature = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class RecognitionRules {
  readonly scans: SourceScans;
  private closed = false; private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly database: CoreDatabase, readonly directories: ConfigurationDirectories, private readonly ingestion: IngestionPipeline, private readonly now = Date.now, private readonly legacyChanged?: () => void) {
    this.scans = new SourceScans(database, (id) => {
      const rule = this.get(id), physicalId = rule.runtime?.sourceId;
      if (!rule.runtime?.claimed || !physicalId || rule.deletedAt) throw conflict("识别规则已删除或尚未确认输入，请先核对配置");
      const source = database.connection.prepare("SELECT available,source_version FROM ingestion_source WHERE source_id=?").get(physicalId) as { available: number; source_version: number };
      return { physicalId, name: rule.snapshot!.configuration.name, context: JSON.stringify([id, rule.version, this.runtime(id)?.scan_generation ?? 0, physicalId, source.source_version]), waiting: rule.paused || ingestion.pauseStatus().paused ? "识别规则或全局整理已暂停；恢复后重新补扫，不解除其他暂停" : !source.available ? "等待原输入目录和卷授权恢复" : null };
    }, (id) => ingestion.scan(id), now, "recognition");
  }
  private row(id: string) { return this.database.connection.prepare("SELECT * FROM recognition_rule WHERE id=?").get(id) as Row | undefined; }
  private runtime(id: string) { return this.database.connection.prepare("SELECT * FROM recognition_runtime WHERE rule_id=?").get(id) as { claimed: number; edited: number; scan_generation: number; legacy_fingerprint: string | null; failure: string | null } | undefined; }
  private writable() { if (this.closed) throw new DesktopError("INTERRUPTED", "识别配置正在停止，请重新进入后查询原任务", true); }
  private previous<T>(key: string, input: unknown): T | null { const row = this.database.connection.prepare("SELECT signature,result_json FROM configuration_command WHERE request_key=?").get(key) as { signature: string; result_json: string } | undefined; if (!row) return null; if (row.signature !== signature(input)) throw conflict("请求标识已用于另一操作，请刷新后重试"); return JSON.parse(row.result_json); }
  private receipt(key: string, input: unknown, result: unknown) { this.database.connection.prepare("INSERT INTO configuration_command VALUES(?,?,?)").run(key, signature(input), JSON.stringify(result)); }
  private versions(row: Row | undefined, input: { expectedVersion: number; expectedDraftRevision: number; expectedLifecycleRevision: number }, deleted = false) { if (!row || !deleted && row.deleted_at || row.version !== input.expectedVersion || row.draft_revision !== input.expectedDraftRevision || row.lifecycle_revision !== input.expectedLifecycleRevision) throw conflict(); }
  private legacyIds(id: string) { return (this.database.connection.prepare("SELECT source_id FROM recognition_legacy_owner WHERE rule_id=? ORDER BY source_id").all(id) as { source_id: string }[]).map((row) => row.source_id); }
  private assertLegacy(id: string) { const runtime = this.runtime(id); if (runtime && !runtime.claimed && runtime.legacy_fingerprint !== recognitionLegacyFingerprint(this.database.connection, id)) throw conflict("旧配置在拆分后已有变化，请在旧入口核对当前输入和目标，再重新保存并预览接管；独立草稿保留"); }
  get(id: string): RecognitionRule {
    const row = this.row(id); if (!row) throw conflict("识别规则不存在，请刷新列表");
    const saved = this.database.connection.prepare("SELECT snapshot_json FROM recognition_rule_version WHERE rule_id=? AND version=?").get(id, row.version) as { snapshot_json: string } | undefined, runtime = this.runtime(id), source = this.database.connection.prepare("SELECT source_id FROM recognition_input WHERE rule_id=? AND active=1").get(id) as { source_id: string } | undefined;
    const stale = runtime && !runtime.claimed && runtime.legacy_fingerprint !== recognitionLegacyFingerprint(this.database.connection, id);
    return recognitionRuleSchema.parse({ id, version: row.version, draftRevision: row.draft_revision, lifecycleRevision: row.lifecycle_revision, draft: JSON.parse(row.draft_json), snapshot: saved ? JSON.parse(saved.snapshot_json) : null, paused: !!row.paused, deletedAt: row.deleted_at, reviewReasons: [...new Set([...JSON.parse(row.review_json), ...(stale ? ["LEGACY_SCOPE_REVIEW_REQUIRED"] : [])])], createdAt: row.created_at, updatedAt: row.updated_at, runtime: { claimed: !!runtime?.claimed, sourceId: source?.source_id ?? null, failure: stale ? "旧配置已有变化，请核对后重新保存并预览；独立草稿仍保留" : runtime?.failure ?? null, unavailableInputs: (this.database.connection.prepare("SELECT count(*) AS n FROM recognition_receipt p JOIN recognition_input i ON i.source_id=p.source_id WHERE i.rule_id=? AND p.state='UNAVAILABLE'").get(id) as { n: number }).n, automaticAuthorized: !!saved && this.automaticAuthorized(JSON.parse(saved.snapshot_json)) } });
  }
  list(includeDeleted = false) { return (this.database.connection.prepare("SELECT id FROM recognition_rule WHERE ?=1 OR deleted_at IS NULL ORDER BY created_at,id LIMIT 1000").all(Number(includeDeleted)) as { id: string }[]).map((row) => this.get(row.id)); }
  save(input: CoreInput<"recognition.save">) {
    this.writable(); const command = { action: "recognition.save", input }, db = this.database.connection;
    return db.transaction(() => { const repeated = this.previous<RecognitionRule>(input.requestKey, command); if (repeated) return repeated;
      const row = this.row(input.id); if (row) this.versions(row, input); else if (input.expectedVersion || input.expectedDraftRevision || input.expectedLifecycleRevision) throw conflict();
      if (!row && (db.prepare("SELECT count(*) AS n FROM recognition_rule").get() as { n: number }).n >= 1000) throw conflict("识别规则超过一千项，请复用现有规则");
      const configuration = recognitionRuleConfigurationSchema.parse(input.configuration), stamp = new Date(this.now()).toISOString();
      for (const target of configuration.targets) {
        if (!db.prepare("SELECT 1 FROM configuration_directory WHERE id=? AND kind='media'").get(target.directoryId)) throw conflict("映射目标目录尚未授权，请通过原生目标选择器核验目录后保存");
        const identity = db.prepare("SELECT rule_id,directory_id,media_type FROM recognition_target_identity WHERE id=?").get(target.id) as { rule_id: string; directory_id: string; media_type: string } | undefined;
        if (identity && (identity.rule_id !== input.id || identity.directory_id !== target.directoryId || identity.media_type !== target.mediaType)) throw conflict("映射目录或类型已变化，请使用新目标标识保存；旧目标身份用于原任务及 Emby 交付");
      }
      const known = (db.prepare("SELECT count(*) AS n FROM recognition_target_identity").get() as { n: number }).n, added = configuration.targets.filter((target) => !db.prepare("SELECT 1 FROM recognition_target_identity WHERE id=?").get(target.id)).length;
      if (known + added > 2000) throw conflict("映射目标与历史身份超过两千项，请复用已有目标并先处理历史任务");
      db.prepare("INSERT INTO recognition_rule VALUES(?,0,1,0,?,1,NULL,'[]',?,?) ON CONFLICT(id) DO UPDATE SET draft_json=excluded.draft_json,draft_revision=draft_revision+1,updated_at=excluded.updated_at").run(input.id, JSON.stringify(configuration), stamp, stamp);
      db.prepare("INSERT INTO recognition_runtime(rule_id,edited,legacy_fingerprint) VALUES(?,1,?) ON CONFLICT(rule_id) DO UPDATE SET edited=1,legacy_fingerprint=CASE WHEN claimed=0 THEN excluded.legacy_fingerprint ELSE legacy_fingerprint END").run(input.id, recognitionLegacyFingerprint(db, input.id));
      for (const target of configuration.targets) db.prepare("INSERT INTO recognition_target_identity VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name").run(target.id, input.id, target.directoryId, target.mediaType, target.name);
      db.prepare("UPDATE recognition_configuration_preview SET state='EXPIRED' WHERE rule_id=? AND state='READY'").run(input.id); const result = this.get(input.id); this.receipt(input.requestKey, command, result); return result;
    })();
  }
  private async checkSnapshot(snapshot: RecognitionRuleSnapshot, checkBinding = true) {
    if (!["ordinary", "managed"].includes(this.directories.kind(snapshot.inputDirectory.id) ?? "")) throw conflict("识别输入必须是普通目录或受管下载根，请重新选择");
    const bindings = [snapshot.inputDirectory, ...snapshot.targets.map((target) => target.directory)];
    for (const binding of bindings) { if (JSON.stringify(this.directories.binding(binding.id)) !== JSON.stringify(binding)) throw conflict("目录授权版本已变化，请重新预览"); await this.directories.reader(binding.id).check(); }
    for (const target of snapshot.targets) {
      if (this.directories.kind(target.directory.id) !== "media") throw conflict("映射目标需要独立媒体目录授权，请使用目标目录选择器");
      if (checkBinding && JSON.stringify(target.embyBinding) !== JSON.stringify(recognitionEmbyBinding(this.database, target.targetId))) throw conflict("目标的 Emby 关联已有变化，请重新预览配置；文件和原计划保留");
    }
    assertDirectoryGraph(this.database, "recognition", snapshot, this.legacyIds(snapshot.ruleId));
  }
  private previewRow(id: string) { const row = this.database.connection.prepare("SELECT * FROM recognition_configuration_preview WHERE id=?").get(id) as Preview | undefined; if (!row) throw conflict("配置预览不存在，请重新预览"); return row; }
  async preview(input: CoreInput<"recognition.preview">) {
    this.writable(); const db = this.database.connection, repeated = db.prepare("SELECT * FROM recognition_configuration_preview WHERE request_key=?").get(input.requestKey) as Preview | undefined;
    if (repeated) { const old = this.previous<{ id: string }>(input.requestKey, { action: "recognition.preview", input }); if (!old || old.id !== repeated.id) throw conflict(); return this.getPreview(repeated.id); }
    const row = this.row(input.id); this.versions(row, input); this.assertLegacy(input.id);
    const configuration = recognitionRuleConfigurationSchema.parse(JSON.parse(row!.draft_json)), active = this.get(input.id).snapshot;
    if (input.useCurrentDefault && configuration.input.kind !== "default") throw conflict("只有默认输入可以明确重新绑定当前默认目录");
    const resolved = configuration.input.kind === "default" && active?.configuration.input.kind === "default" && !input.useCurrentDefault ? { directory: active.inputDirectory, defaultDirectoryVersion: active.defaultDirectoryVersion } : this.directories.resolve(configuration.input), dependent = configuration.input.kind === "default" && (!active || active.configuration.input.kind !== "default" || !!input.useCurrentDefault);
    const snapshot = recognitionRuleSnapshotSchema.parse({ ruleId: input.id, ruleVersion: row!.version + 1, configuration, inputDirectory: resolved.directory, inputMode: this.directories.kind(resolved.directory.id) === "managed" ? "managed-completed" : "ordinary", defaultDirectoryVersion: resolved.defaultDirectoryVersion, targets: configuration.targets.map((target) => ({ targetId: target.id, directory: this.directories.binding(target.directoryId), embyBinding: recognitionEmbyBinding(this.database, target.id) })) });
    await this.checkSnapshot(snapshot); this.writable(); this.versions(this.row(input.id), input); this.assertLegacy(input.id); if (dependent && this.directories.defaults().version !== snapshot.defaultDirectoryVersion) throw conflict("默认目录已变化，请重新预览");
    const id = randomUUID(); db.transaction(() => { const prior = this.previous<{ id: string }>(input.requestKey, { action: "recognition.preview", input }); if (prior) return;
      db.prepare("INSERT INTO recognition_configuration_preview VALUES(?,?,?,?,?,?,?,?, 'READY',?)").run(id, input.id, input.requestKey, row!.version, row!.draft_revision, row!.lifecycle_revision, JSON.stringify(snapshot), Number(dependent), this.now() + 15 * 60 * 1000); this.receipt(input.requestKey, { action: "recognition.preview", input }, { id }); })();
    return this.getPreview((this.previous<{ id: string }>(input.requestKey, { action: "recognition.preview", input }))!.id);
  }
  getPreview(id: string): CoreOutput<"recognition.get-preview"> {
    const row = this.previewRow(id), current = this.row(row.rule_id), snapshot = recognitionRuleSnapshotSchema.parse(JSON.parse(row.snapshot_json));
    const expired = !current || !!current.deleted_at || current.version !== row.version || current.draft_revision !== row.draft_revision || current.lifecycle_revision !== row.lifecycle_revision || row.expires_at <= this.now() || !!row.default_dependency && snapshot.defaultDirectoryVersion !== this.directories.defaults().version || row.state === "EXPIRED";
    return { id, ruleId: row.rule_id, state: row.state === "APPLIED" ? "APPLIED" : expired ? "EXPIRED" : "READY", snapshot, expiresAt: row.expires_at, automaticAuthorized: this.automaticAuthorized(snapshot) };
  }
  private automaticAuthorized(snapshot: RecognitionRuleSnapshot) { return !!this.database.connection.prepare("SELECT 1 FROM recognition_automatic_consent WHERE rule_id=? AND rule_version=? AND scope_hash=?").get(snapshot.ruleId, snapshot.ruleVersion, recognitionScopeHash(snapshot)); }
  confirm(input: CoreInput<"recognition.confirm">): Promise<RecognitionRule> { const task = this.queue.catch(() => {}).then(() => this.confirmOnce(input)); this.queue = task; return task; }
  private async confirmOnce(input: CoreInput<"recognition.confirm">) {
    this.writable(); const command = { action: "recognition.confirm", input }, repeated = this.previous<RecognitionRule>(input.requestKey, command); if (repeated) return repeated;
    const preview = this.getPreview(input.previewId), row = this.previewRow(input.previewId), rule = this.get(row.rule_id); if (preview.state !== "READY") throw conflict("配置预览已过期或已确认，请重新读取"); this.assertLegacy(rule.id); await this.checkSnapshot(preview.snapshot);
    this.ingestion.assertRecognitionChangeSafe(rule.id);
    const prepared = await this.ingestion.prepareRecognitionInput(preview.snapshot, this.directories.grant(preview.snapshot.inputDirectory.id));
    try {
      const result = this.database.connection.transaction(() => {
        this.writable(); const again = this.previous<RecognitionRule>(input.requestKey, command); if (again) return again;
        if (this.getPreview(row.id).state !== "READY") throw conflict(); this.assertLegacy(rule.id); this.ingestion.assertRecognitionChangeSafe(rule.id); assertDirectoryGraph(this.database, "recognition", preview.snapshot, this.legacyIds(rule.id));
        const db = this.database.connection; db.prepare("INSERT INTO recognition_rule_version VALUES(?,?,?)").run(rule.id, preview.snapshot.ruleVersion, JSON.stringify(preview.snapshot));
        db.prepare("UPDATE recognition_rule SET version=?,paused=?,review_json='[]',updated_at=? WHERE id=?").run(preview.snapshot.ruleVersion, Number(rule.version > 0 && rule.paused), new Date(this.now()).toISOString(), rule.id);
        db.prepare("INSERT INTO recognition_runtime(rule_id,claimed) VALUES(?,1) ON CONFLICT(rule_id) DO UPDATE SET claimed=1,failure=NULL").run(rule.id);
        this.retireLegacy(rule.id); prepared.commit(rule.version > 0 && rule.paused);
        db.prepare("UPDATE recognition_configuration_preview SET state=CASE WHEN id=? THEN 'APPLIED' ELSE 'EXPIRED' END WHERE rule_id=? AND state='READY'").run(row.id, rule.id);
        const saved = this.get(rule.id); this.receipt(input.requestKey, command, saved); return saved;
      })(); await prepared.activate(); this.legacyChanged?.(); return result;
    } catch (error) { await prepared.close(); throw error; }
  }
  private retireLegacy(id: string) {
    const db = this.database.connection;
    for (const sourceId of this.legacyIds(id)) { db.prepare("INSERT INTO legacy_configuration_owner(source_id,recognition_claimed) VALUES(?,1) ON CONFLICT(source_id) DO UPDATE SET recognition_claimed=1").run(sourceId); db.prepare("UPDATE desktop_source SET paused=1 WHERE id IN (SELECT local_source_id FROM source_rule WHERE id=? UNION SELECT ingestion_source_id FROM source_rule WHERE id=?)").run(sourceId, sourceId); }
  }
  async control(input: CoreInput<"recognition.control">) {
    this.writable(); const command = { action: "recognition.control", input }, repeated = this.previous<RecognitionRule>(input.requestKey, command); if (repeated) return repeated;
    const row = this.row(input.id); this.versions(row, input, true); const rule = this.get(input.id);
    if (!rule.runtime?.claimed && this.legacyIds(rule.id).length && input.operation !== "remove") throw conflict("请先核对旧配置并预览确认接管，再独立控制识别");
    if (input.operation === "resume") { if (!rule.snapshot || rule.reviewReasons.length) throw conflict("请先完整预览确认识别配置"); await this.checkSnapshot(rule.snapshot, false); }
    if (input.operation === "remove") { if (!rule.paused) throw conflict("请先暂停识别并等待在途操作安全点，再删除规则；文件保留"); this.ingestion.assertRecognitionChangeSafe(rule.id); }
    const result = this.database.connection.transaction(() => { this.writable(); this.versions(this.row(input.id), input, true); const db = this.database.connection, again = this.previous<RecognitionRule>(input.requestKey, command); if (again) return again;
      if (input.operation === "reset") { if (!rule.snapshot || rule.deletedAt) throw conflict("没有可重置的生效配置"); db.prepare("UPDATE recognition_rule SET draft_json=?,draft_revision=draft_revision+1 WHERE id=?").run(JSON.stringify(rule.snapshot.configuration), rule.id); }
      else { if (input.operation === "restore" ? !rule.deletedAt : !!rule.deletedAt) throw conflict("规则删除状态已变化，请刷新"); db.prepare("UPDATE recognition_rule SET paused=?,deleted_at=?,lifecycle_revision=lifecycle_revision+1,updated_at=? WHERE id=?").run(Number(input.operation !== "resume"), input.operation === "remove" ? new Date(this.now()).toISOString() : null, new Date(this.now()).toISOString(), rule.id); if (input.operation === "remove") this.retireLegacy(rule.id); }
      if (input.operation === "remove" || input.operation === "restore") db.prepare("UPDATE recognition_runtime SET scan_generation=scan_generation+1 WHERE rule_id=?").run(rule.id);
      if (input.operation === "resume") db.prepare("UPDATE ingestion_source_scan SET next_attempt_at=0 WHERE owner_kind='recognition' AND source_id=? AND state IN ('PENDING','RUNNING','WAITING_SOURCE')").run(rule.id);
      db.prepare("UPDATE desktop_source SET paused=(SELECT paused FROM recognition_rule WHERE id=?) WHERE id IN (SELECT source_id FROM recognition_input WHERE rule_id=?)").run(rule.id, rule.id);
      if (input.operation === "resume") for (const intent of db.prepare("SELECT id FROM ingestion_automatic WHERE source_id=? AND state IN ('PREVIEWING','CONFIRMING') AND selection_json IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ingestion_operation o WHERE o.request_key=ingestion_automatic.confirmation_key)").all(rule.id) as { id: string }[]) db.prepare("UPDATE ingestion_automatic SET state='PREVIEWING',preview_id=NULL,preview_key=?,failure=NULL WHERE id=?").run(randomUUID(), intent.id);
      db.prepare("UPDATE recognition_configuration_preview SET state='EXPIRED' WHERE rule_id=? AND state='READY'").run(rule.id); const saved = this.get(rule.id); this.receipt(input.requestKey, command, saved); return saved;
    })(); this.ingestion.recognitionRuleChanged(rule.id); this.scans.kick(); this.legacyChanged?.(); return result;
  }
  scan(input: CoreInput<"recognition.scan">): CoreOutput<"recognition.scan"> {
    this.writable(); this.versions(this.row(input.id), input); const rule = this.get(input.id); if (!rule.runtime?.claimed || !rule.runtime.sourceId || rule.deletedAt || rule.paused) throw conflict("请先确认识别配置并恢复此规则后补扫");
    return this.scans.enqueue({ sourceId: rule.id, requestKey: input.requestKey });
  }
  authorizeAutomatic(input: CoreInput<"recognition.authorize-automatic">) {
    this.writable(); const command = { action: "recognition.authorize-automatic", input };
    return this.database.connection.transaction(() => { const repeated = this.previous<RecognitionRule>(input.requestKey, command); if (repeated) return repeated; const rule = this.get(input.id);
      if (rule.version !== input.expectedVersion || !rule.snapshot?.configuration.automatic || !rule.runtime?.claimed || rule.deletedAt) throw conflict("自动策略或规则版本已变化，请重新核对首次样本预览");
      this.ingestion.assertRecognitionAutomaticSample(rule.snapshot, input.samplePreviewId);
      this.database.connection.prepare("INSERT INTO recognition_automatic_consent VALUES(?,?,?,?,?) ON CONFLICT(rule_id,rule_version) DO UPDATE SET sample_preview_id=excluded.sample_preview_id,scope_hash=excluded.scope_hash,acknowledged_at=excluded.acknowledged_at").run(rule.id, rule.version, input.samplePreviewId, recognitionScopeHash(rule.snapshot), new Date(this.now()).toISOString()); const result = this.get(rule.id); this.receipt(input.requestKey, command, result); return result;
    })();
  }
  async restore() { if (!this.closed) await this.ingestion.restoreRecognitionInputs(this.directories); }
  start() { if (!this.closed) this.scans.start(); }
  async close() { this.closed = true; await this.scans.close(); await this.queue.catch(() => {}); }
}
