/** 人工识别字段与匹配版本独立持久化；字段保存不创建文件操作。 */
export const recognitionEditMigrationSql = `
CREATE TABLE ingestion_recognition_edit (
 task_id TEXT PRIMARY KEY REFERENCES media_task(id), revision INTEGER NOT NULL CHECK(revision>0),
 matched_revision INTEGER NOT NULL DEFAULT 0 CHECK(matched_revision>=0), parsed_json TEXT NOT NULL,
 updated_at TEXT NOT NULL
);
CREATE TABLE ingestion_recognition_command (
 request_key TEXT PRIMARY KEY, signature TEXT NOT NULL, result_json TEXT NOT NULL, created_at TEXT NOT NULL
);
`;
