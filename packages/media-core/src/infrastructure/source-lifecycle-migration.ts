/** 删除来源保留配置和执行证据；生命周期栅栏阻止删除／恢复后旧请求重新生效。 */
export const sourceLifecycleMigrationSql = `
CREATE TABLE desktop_source_rebuild (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('quark','baidu','alipan','custom')),
 source_path TEXT NOT NULL, target_path TEXT NOT NULL,
 media_type TEXT NOT NULL CHECK(media_type IN ('AUTO','MOVIE','TV_SHOW')),
 operation TEXT NOT NULL CHECK(operation='COPY'), automatic INTEGER NOT NULL DEFAULT 0 CHECK(automatic=0),
 version INTEGER NOT NULL DEFAULT 1, paused INTEGER NOT NULL DEFAULT 0,
 health TEXT NOT NULL DEFAULT 'unverified', created_at TEXT NOT NULL
);
INSERT INTO desktop_source_rebuild SELECT * FROM desktop_source;
DROP TABLE desktop_source;
ALTER TABLE desktop_source_rebuild RENAME TO desktop_source;
CREATE INDEX desktop_source_path ON desktop_source(source_path);
ALTER TABLE source_rule ADD COLUMN deleted_at TEXT;
ALTER TABLE source_rule ADD COLUMN lifecycle_revision INTEGER NOT NULL DEFAULT 0 CHECK(lifecycle_revision>=0);
ALTER TABLE source_rule_preview ADD COLUMN lifecycle_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_rule_execution_preview ADD COLUMN lifecycle_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_rule_control ADD COLUMN lifecycle_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE source_rule_run_request ADD COLUMN lifecycle_revision INTEGER NOT NULL DEFAULT 0;
CREATE TABLE source_rule_lifecycle_command (
 request_key TEXT PRIMARY KEY, source_id TEXT NOT NULL REFERENCES source_rule(id),
 version INTEGER NOT NULL, draft_revision INTEGER NOT NULL, lifecycle_revision INTEGER NOT NULL,
 operation TEXT NOT NULL CHECK(operation IN ('remove','restore')), created_at TEXT NOT NULL
);
CREATE TRIGGER source_rule_deleted_paused_insert BEFORE INSERT ON source_rule WHEN NEW.deleted_at IS NOT NULL AND NEW.paused!=1
BEGIN SELECT RAISE(ABORT,'已删除来源必须保持暂停'); END;
CREATE TRIGGER source_rule_deleted_paused_update BEFORE UPDATE ON source_rule WHEN NEW.deleted_at IS NOT NULL AND NEW.paused!=1
BEGIN SELECT RAISE(ABORT,'已删除来源必须保持暂停'); END;
`;
