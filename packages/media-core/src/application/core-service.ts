import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, realpath, stat, writeFile, unlink } from "node:fs/promises";
import { isAbsolute, relative, sep, join } from "node:path";
import { createIdentifier, inject, injectable } from "@yeatz/app-framework/ioc";
import {
  DesktopError,
  sourceSchema,
  settingsDraftSchema,
  type CoreStatus,
  type DesktopSource,
  type SettingsDraft,
  type SourceDraft,
  type PageInput,
  type TaskPage,
  type DesktopJob,
} from "@media-marshal/contracts";
import { CoreDatabase } from "../infrastructure/database.js";
import { embyFailureMessage } from "../ingestion/emby-failure.js";
import { pathsOverlap } from "../files/index.js";
import type { ManagedRootGrant } from "@media-marshal/contracts/internal";

export const DatabaseToken = createIdentifier<CoreDatabase>(
  "media-core.database",
);
export interface CoreComponents { parserReady(): boolean; correctionFilesReady?(): boolean }
export const ComponentsToken = createIdentifier<CoreComponents>("media-core.components");
function contains(parent: string, child: string): boolean {
  const rest = relative(parent, child);
  return (
    rest === "" ||
    (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
  );
}
interface SourceRow {
  mode?: "local" | "managed";
  effective_automatic?: number;
  download_root_id?: string | null;
  id: string;
  name: string;
  kind: DesktopSource["kind"];
  source_path: string;
  target_path: string;
  media_type: DesktopSource["mediaType"];
  version: number;
  paused: number;
  health: DesktopSource["health"];
  created_at: string;
}
function sourceDto(row: SourceRow): DesktopSource {
  return sourceSchema.parse({
    id: row.id,
    mode: row.mode ?? "local", downloadRootId: row.download_root_id ?? null,
    name: row.name,
    kind: row.kind,
    sourcePath: row.source_path,
    targetPath: row.target_path,
    mediaType: row.media_type,
    operation: "COPY",
    automatic: Boolean(row.effective_automatic),
    version: row.version,
    paused: Boolean(row.paused),
    health: row.health,
    createdAt: row.created_at,
  });
}

@injectable()
export class CoreService {
  private accepting = true;
  constructor(@inject(DatabaseToken) private readonly database: CoreDatabase, @inject(ComponentsToken) private readonly components: CoreComponents = { parserReady: () => false }) {}
  quiesce(): void {
    this.accepting = false;
  }
  private writable(): void {
    if (!this.accepting)
      throw new DesktopError(
        "INTERRUPTED",
        "核心正在停止，尚未接收此操作",
        true,
      );
  }
  private checkManagedRoots(paths: string[]) {
    const roots = this.database.connection.prepare("SELECT canonical_path,volume_identity FROM managed_download_root").all() as { canonical_path: string; volume_identity: string }[];
    if (roots.some((root) => paths.some((path) => pathsOverlap(root.canonical_path, path, JSON.parse(root.volume_identity) as ManagedRootGrant["volume"])))) throw new DesktopError("UNSAFE_PATH", "目录与受管下载目录重叠");
    const targets = this.database.connection.prepare("SELECT grant_json FROM media_target_root").all() as { grant_json: string }[];
    if (targets.some((row) => { const grant = JSON.parse(row.grant_json) as ManagedRootGrant; return pathsOverlap(paths[0]!, grant.path, grant.volume) || (paths[1] !== grant.path && pathsOverlap(paths[1]!, grant.path, grant.volume)); })) throw new DesktopError("UNSAFE_PATH", "目录与媒体目标或历史操作目录重叠");
  }
  getRuntime(): CoreStatus {
    const count = (table: "source_rule" | "media_task") =>
      (
        this.database.connection
          .prepare(`SELECT count(*) AS count FROM ${table}${table === "source_rule" ? " WHERE deleted_at IS NULL" : ""}`)
          .get() as { count: number }
      ).count;
    return {
      schemaVersion: this.database.schemaVersion,
      sourceCount: (this.database.connection.prepare("SELECT count(*) AS n FROM (SELECT id FROM sync_source_rule WHERE deleted_at IS NULL UNION SELECT s.id FROM source_rule s WHERE s.deleted_at IS NULL AND (s.type='cloud' OR NOT EXISTS(SELECT 1 FROM legacy_configuration_owner o WHERE o.source_id=s.id AND o.recognition_claimed=1)))").get() as { n: number }).n,
      recognitionCount: (this.database.connection.prepare("SELECT count(*) AS n FROM recognition_rule WHERE deleted_at IS NULL").get() as { n: number }).n,
      taskCount: count("media_task"),
      mode: this.database.connection.prepare("SELECT 1 FROM source_rule s JOIN source_rule_version v ON v.source_id=s.id AND v.version=s.version WHERE s.deleted_at IS NULL AND s.review_required=0 AND json_extract(v.configuration_json,'$.organization.automatic')=1 LIMIT 1").get() ? "automatic-enabled" : "manual-only",
      parser: this.components.parserReady() ? "ready" : "unavailable",
      correctionFiles: this.components.correctionFilesReady?.() ? "ready" : "unavailable",
    };
  }
  listSources(): DesktopSource[] {
    return (
      this.database.connection
        .prepare(
          "SELECT s.*,i.mode,i.download_root_id,EXISTS(SELECT 1 FROM source_rule r JOIN source_rule_version v ON v.source_id=r.id AND v.version=r.version WHERE r.deleted_at IS NULL AND r.review_required=0 AND (r.local_source_id=s.id OR r.ingestion_source_id=s.id) AND json_extract(v.configuration_json,'$.organization.automatic')=1) AS effective_automatic FROM desktop_source s LEFT JOIN ingestion_source i ON i.source_id=s.id WHERE NOT EXISTS(SELECT 1 FROM recognition_input ri WHERE ri.source_id=s.id) AND NOT EXISTS(SELECT 1 FROM source_rule r WHERE r.local_source_id=s.id AND r.deleted_at IS NOT NULL) ORDER BY s.created_at,s.id LIMIT 1000",
        )
        .all() as SourceRow[]
    ).map(sourceDto);
  }
  async saveSource(input: SourceDraft): Promise<DesktopSource> {
    this.writable();
    if (input.id && this.database.connection.prepare("SELECT 1 FROM source_rule_version WHERE local_source_id=? OR ingestion_source_id=? LIMIT 1").get(input.id, input.id)) throw new DesktopError("CONFLICT", "请通过统一来源配置修改此规则");
    if (
      !isAbsolute(input.sourcePath) ||
      !isAbsolute(input.targetPath) ||
      input.sourcePath.startsWith("\\\\") ||
      input.targetPath.startsWith("\\\\")
    )
      throw new DesktopError("UNSAFE_PATH", "请选择本机绝对目录");
    let sourcePath: string, targetPath: string;
    try {
      [sourcePath, targetPath] = await Promise.all([
        realpath(input.sourcePath),
        realpath(input.targetPath),
      ]);
      if (
        !(await stat(sourcePath)).isDirectory() ||
        !(await stat(targetPath)).isDirectory()
      )
        throw new Error();
      await access(sourcePath, constants.R_OK);
      await access(targetPath, constants.W_OK);
    } catch {
      throw new DesktopError(
        "UNSAFE_PATH",
        "目录不可访问，请检查挂载或重新选择",
        true,
      );
    }
    if (contains(sourcePath, targetPath) || contains(targetPath, sourcePath))
      throw new DesktopError("UNSAFE_PATH", "来源与目标不能相同或互相包含");
    this.checkManagedRoots([sourcePath, targetPath]);
    for (const other of this.listSources()) {
      if (other.id === input.id) continue;
      if (
        [other.sourcePath, other.targetPath].some(
          (path) =>
            contains(path, sourcePath) ||
            contains(sourcePath, path) ||
            contains(path, targetPath) ||
            contains(targetPath, path),
        )
      )
        throw new DesktopError("UNSAFE_PATH", "目录与其他来源或目标重叠");
    }
    const probe = join(targetPath, `.media-marshal-probe-${randomUUID()}`);
    try {
      await writeFile(probe, "", { flag: "wx", mode: 0o600 });
    } catch {
      throw new DesktopError("UNSAFE_PATH", "目标目录不可写", true);
    } finally {
      await unlink(probe).catch(() => {});
    }
    this.writable();
    this.checkManagedRoots([sourcePath, targetPath]);
    const id = input.id ?? randomUUID();
    const db = this.database.connection;
    // 异步目录探测之后再次检查，避免并发保存绕过重叠检查。
    const others = this.listSources().filter((item) => item.id !== id);
    if (
      others.some((other) =>
        [other.sourcePath, other.targetPath].some(
          (path) =>
            contains(path, sourcePath) ||
            contains(sourcePath, path) ||
            contains(path, targetPath) ||
            contains(targetPath, path),
        ),
      )
    )
      throw new DesktopError("CONFLICT", "目录已被其他规则接管");
    if (input.id) {
      const result = db
        .prepare(
          "UPDATE desktop_source SET name=?, kind=?, source_path=?, target_path=?, media_type=?, version=version+1 WHERE id=?",
        )
        .run(
          input.name,
          input.kind,
          sourcePath,
          targetPath,
          input.mediaType,
          id,
        );
      if (!result.changes)
        throw new DesktopError("CONFLICT", "来源已不存在，请刷新");
    } else {
      if (this.listSources().length >= 1000)
        throw new DesktopError("CONFLICT", "来源数量已达到上限");
      db.prepare(
        "INSERT INTO desktop_source (id,name,kind,source_path,target_path,media_type,operation,created_at) VALUES (?,?,?,?,?,?,?,?)",
      ).run(
        id,
        input.name,
        input.kind,
        sourcePath,
        targetPath,
        input.mediaType,
        "COPY",
        new Date().toISOString(),
      );
    }
    return sourceDto(
      db
        .prepare("SELECT * FROM desktop_source WHERE id=?")
        .get(id) as SourceRow,
    );
  }
  pauseSource(id: string, paused: boolean): DesktopSource {
    this.writable();
    if (this.database.connection.prepare("SELECT 1 FROM source_rule WHERE local_source_id=? OR ingestion_source_id=? LIMIT 1").get(id, id)) throw new DesktopError("CONFLICT", "请通过统一来源控制暂停状态");
    if (
      !this.database.connection
        .prepare("UPDATE desktop_source SET paused=? WHERE id=?")
        .run(Number(paused), id).changes
    )
      throw new DesktopError("CONFLICT", "来源已不存在");
    return sourceDto(
      this.database.connection
        .prepare("SELECT * FROM desktop_source WHERE id=?")
        .get(id) as SourceRow,
    );
  }
  getSettings(): SettingsDraft {
    const row = this.database.connection
      .prepare("SELECT value FROM app_setting WHERE key='desktop.preferences'")
      .get() as { value: string } | undefined;
    return settingsDraftSchema.parse(row ? JSON.parse(row.value) : {});
  }
  saveSettings(input: SettingsDraft): SettingsDraft {
    this.writable();
    for (const address of [input.embyUrl, input.tmdbProxy]) {
      if (!address) continue;
      const url = new URL(address);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
        || (address === input.tmdbProxy && url.pathname !== "/")
      )
        throw new DesktopError(
          "INVALID_REQUEST",
          "服务地址只允许不含凭据、查询和片段的 HTTP(S) 地址",
        );
    }
    this.database.connection
      .prepare(
        "INSERT INTO app_setting(key,value) VALUES('desktop.preferences',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(input));
    return input;
  }
  listTasks(input: PageInput): TaskPage {
    const params = input.status ? [input.status] : [];
    const where = input.status ? " WHERE status=?" : "";
    const total = (
      this.database.connection
        .prepare(`SELECT count(*) AS count FROM media_task${where}`)
        .get(...params) as { count: number }
    ).count;
    const items = this.database.connection
      .prepare(
        `SELECT id,source_id AS sourceId,coalesce((SELECT json_extract(o.plan_json,'$.recognitionSnapshot.ruleId') FROM ingestion_operation o WHERE o.task_id=media_task.id),(SELECT x.rule_id FROM media_correction_operation o JOIN recognition_target_identity x ON x.id=json_extract(o.plan_json,'$.logicalTargetId') WHERE o.new_task_id=media_task.id),(SELECT ri.rule_id FROM recognition_input ri WHERE ri.source_id=media_task.source_id)) AS recognitionRuleId,source_path AS sourcePath,title,status,delivery_status AS deliveryStatus,target_path AS targetPath,corrected_from_id AS correctedFromId,corrected_to_id AS correctedToId,(SELECT o.id FROM media_correction_operation o WHERE (o.original_task_id=media_task.id OR o.new_task_id=media_task.id) AND (o.phase!='RECORDED' OR EXISTS(SELECT 1 FROM app_setting s WHERE s.key='correction.restore.audit.'||o.id)) ORDER BY o.created_at DESC LIMIT 1) AS activeCorrectionId,updated_at AS updatedAt FROM media_task${where} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`,
      )
      .all(
        ...params,
        input.pageSize,
        (input.page - 1) * input.pageSize,
      ) as TaskPage["items"];
    const delivery = this.database.connection.prepare("SELECT last_failure FROM emby_delivery WHERE task_id=?");
    return { items: items.map((item) => { const failure = delivery.get(item.id) as { last_failure: string | null } | undefined; return failure?.last_failure ? { ...item, deliveryFailure: embyFailureMessage(failure.last_failure) } : item; }), total, page: input.page, pageSize: input.pageSize };
  }
  listJobs(): DesktopJob[] {
    return this.database.connection
      .prepare(
        "SELECT id,kind,state,updated_at AS updatedAt FROM desktop_job ORDER BY updated_at DESC LIMIT 100",
      )
      .all() as DesktopJob[];
  }
}
