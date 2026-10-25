import Database from "better-sqlite3";
import { mkdirSync, existsSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { DesktopError } from "@media-marshal/contracts";
import { cloudMigrationSql } from "./cloud-migration.js";
import { cloudAuthorizationMigrationSql } from "./cloud-authorization-migration.js";
import { cloudDownloadMigrationSql } from "./cloud-download-migration.js";
import { cloudSubscriptionMigrationSql } from "./cloud-subscription-migration.js";
import { ingestionMigrationSql, ingestionAccessoryMigrationSql, ingestionContentReviewMigrationSql } from "./ingestion-migration.js";
import { sourceRuleMigrationSql } from "./source-rule-migration.js";
import { sourceRuleLegacyMigrationSql, migrateLegacySourceRules } from "./source-rule-legacy-migration.js";
import { sourceExecutionMigrationSql } from "./source-execution-migration.js";
import { sourceOrganizationMigrationSql } from "./source-organization-migration.js";
import { sourceExecutionPreviewMigrationSql } from "./source-execution-preview-migration.js";

import { CORE_DATA_SCHEMA_VERSION } from "@media-marshal/contracts/internal/core";
export const SCHEMA_VERSION = CORE_DATA_SCHEMA_VERSION;
export interface Migration {
  version: number;
  sql: string;
  apply?: (connection: Database.Database) => void;
}
export const migrations: readonly Migration[] = [
  {
    version: 1,
    sql: `
  CREATE TABLE desktop_source (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('quark','baidu','alipan','custom')),
    source_path TEXT NOT NULL UNIQUE, target_path TEXT NOT NULL,
    media_type TEXT NOT NULL CHECK(media_type IN ('AUTO','MOVIE','TV_SHOW')),
    operation TEXT NOT NULL CHECK(operation = 'COPY'), automatic INTEGER NOT NULL DEFAULT 0 CHECK(automatic = 0),
    version INTEGER NOT NULL DEFAULT 1, paused INTEGER NOT NULL DEFAULT 0,
    health TEXT NOT NULL DEFAULT 'unverified', created_at TEXT NOT NULL
  );
  CREATE TABLE app_setting (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE media_task (
    id TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES desktop_source(id),
    source_path TEXT NOT NULL, title TEXT, status TEXT NOT NULL CHECK(status IN ('PENDING','PROCESSING','AWAITING_CONFIRMATION','DONE','FAILED','SKIPPED','CORRECTED')),
    delivery_status TEXT NOT NULL DEFAULT 'NOT_READY', target_path TEXT, parsed_json TEXT, confirmed_json TEXT, metadata_json TEXT,
    corrected_from_id TEXT, corrected_to_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE INDEX media_task_status_updated ON media_task(status, updated_at DESC);
  CREATE TABLE task_candidate (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES media_task(id), metadata_json TEXT NOT NULL, confidence REAL NOT NULL);
  CREATE TABLE tmdb_cache (key TEXT PRIMARY KEY, value TEXT NOT NULL, expires_at INTEGER NOT NULL);
  CREATE TABLE desktop_job (id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, plan_json TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE correction_item (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES desktop_job(id), task_id TEXT NOT NULL REFERENCES media_task(id), state TEXT NOT NULL, plan_json TEXT NOT NULL);
  CREATE UNIQUE INDEX correction_active_task ON correction_item(task_id) WHERE state IN ('PENDING','RUNNING');
`,
  },
  { version: 2, sql: cloudMigrationSql },
  { version: 3, sql: cloudAuthorizationMigrationSql },
  { version: 4, sql: cloudDownloadMigrationSql },
  { version: 5, sql: cloudSubscriptionMigrationSql },
  { version: 6, sql: "ALTER TABLE provider_binding ADD COLUMN object_namespace TEXT;" },
  { version: 7, sql: ingestionMigrationSql },
  { version: 8, sql: ingestionAccessoryMigrationSql },
  { version: 9, sql: sourceRuleMigrationSql },
  { version: 10, sql: sourceRuleLegacyMigrationSql, apply: migrateLegacySourceRules },
  { version: 11, sql: sourceExecutionMigrationSql },
  { version: 12, sql: sourceOrganizationMigrationSql },
  { version: 13, sql: sourceExecutionPreviewMigrationSql },
  // 来源 JSON 增加可配置忽略语义；保留旧快照原文，阻止旧核心误读新配置。
  { version: 14, sql: "SELECT 1;" },
  // 恢复核对中的 RECORDED 操作可暂为 PROCESSING；旧核心不得忽略持久核对队列。
  { version: 15, sql: "SELECT 1;" },
  { version: 16, sql: ingestionContentReviewMigrationSql },
];

export class CoreDatabase {
  readonly connection: Database.Database;
  private closed = false;
  private constructor(connection: Database.Database) {
    this.connection = connection;
  }

  static async open(
    path: string,
    plan: readonly Migration[] = migrations,
    options: { exclusiveOwner?: boolean } = {},
  ): Promise<CoreDatabase> {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const existed =
      path !== ":memory:" && existsSync(path) && statSync(path).size > 0;
    const connection = new Database(path, { timeout: 3000 });
    try {
      const version = connection.pragma("user_version", {
        simple: true,
      }) as number;
      const latest = plan.at(-1)?.version ?? 0;
      if (version > latest || !Number.isInteger(version))
        throw new DesktopError(
          "STORAGE_ERROR",
          "数据版本高于应用支持版本，需使用兼容版本或对应备份",
        );
      if (
        version === 0 &&
        existed &&
        (
          connection
            .prepare(
              "SELECT count(*) AS count FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
            )
            .get() as { count: number }
        ).count > 0
      ) {
        throw new DesktopError(
          "STORAGE_ERROR",
          "发现未知数据库结构，已停止写入",
        );
      }
      for (let index = 0; index < plan.length; index++) {
        if (plan[index]?.version !== index + 1)
          throw new DesktopError("STORAGE_ERROR", "数据库迁移顺序无效");
      }
      if (options.exclusiveOwner && path !== ":memory:") {
        // 操作系统锁跨进程生效；旧 Core 未关闭连接时，新 Core 无法开始迁移或业务写入。
        connection.pragma("locking_mode = EXCLUSIVE");
        connection.exec("BEGIN EXCLUSIVE; COMMIT;");
      }
      if (existed && version < latest) {
        const original = `${path}.before-v${latest}.bak`;
        // 部分升级失败后的重试不覆盖最初版本的恢复证据。
        await connection.backup(existsSync(original) ? `${path}.from-v${version}.before-v${latest}.${randomUUID()}.bak` : original);
      }
      connection.pragma("foreign_keys = ON");
      connection.pragma("busy_timeout = 3000");
      connection.pragma("journal_mode = WAL");
      for (const migration of plan) {
        if (migration.version <= version) continue;
        connection.transaction(() => {
          connection.exec(migration.sql);
          migration.apply?.(connection);
          connection.pragma(`user_version = ${migration.version}`);
        })();
      }
      return new CoreDatabase(connection);
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  get schemaVersion(): number {
    return this.connection.pragma("user_version", { simple: true }) as number;
  }
  async backup(path: string): Promise<void> {
    await this.connection.backup(path);
  }
  close(): void {
    if (!this.closed) {
      this.closed = true;
      this.connection.close();
    }
  }
}
