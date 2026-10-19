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

export const DatabaseToken = createIdentifier<CoreDatabase>(
  "media-core.database",
);
function contains(parent: string, child: string): boolean {
  const rest = relative(parent, child);
  return (
    rest === "" ||
    (rest !== ".." && !rest.startsWith(`..${sep}`) && !isAbsolute(rest))
  );
}
interface SourceRow {
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
    name: row.name,
    kind: row.kind,
    sourcePath: row.source_path,
    targetPath: row.target_path,
    mediaType: row.media_type,
    operation: "COPY",
    automatic: false,
    version: row.version,
    paused: Boolean(row.paused),
    health: row.health,
    createdAt: row.created_at,
  });
}

@injectable()
export class CoreService {
  private accepting = true;
  constructor(@inject(DatabaseToken) private readonly database: CoreDatabase) {}
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
  getRuntime(): CoreStatus {
    const count = (table: "desktop_source" | "media_task") =>
      (
        this.database.connection
          .prepare(`SELECT count(*) AS count FROM ${table}`)
          .get() as { count: number }
      ).count;
    return {
      schemaVersion: this.database.schemaVersion,
      sourceCount: count("desktop_source"),
      taskCount: count("media_task"),
      mode: "manual-only",
      parser: "unavailable",
    };
  }
  listSources(): DesktopSource[] {
    return (
      this.database.connection
        .prepare(
          "SELECT * FROM desktop_source ORDER BY created_at, id LIMIT 1000",
        )
        .all() as SourceRow[]
    ).map(sourceDto);
  }
  async saveSource(input: SourceDraft): Promise<DesktopSource> {
    this.writable();
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
        `SELECT id,source_id AS sourceId,source_path AS sourcePath,title,status,delivery_status AS deliveryStatus,target_path AS targetPath,updated_at AS updatedAt FROM media_task${where} ORDER BY updated_at DESC,id LIMIT ? OFFSET ?`,
      )
      .all(
        ...params,
        input.pageSize,
        (input.page - 1) * input.pageSize,
      ) as TaskPage["items"];
    return { items, total, page: input.page, pageSize: input.pageSize };
  }
  listJobs(): DesktopJob[] {
    return this.database.connection
      .prepare(
        "SELECT id,kind,state,updated_at AS updatedAt FROM desktop_job ORDER BY updated_at DESC LIMIT 100",
      )
      .all() as DesktopJob[];
  }
}
