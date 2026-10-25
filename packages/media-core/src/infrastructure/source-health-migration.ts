/** 只记录最近一次版本化目录检查，不创建来源、候选或文件作业。 */
export const sourceHealthMigrationSql = `
CREATE TABLE source_rule_local_health (
 source_id TEXT PRIMARY KEY REFERENCES source_rule(id),
 version INTEGER NOT NULL CHECK(version>0), lifecycle_revision INTEGER NOT NULL CHECK(lifecycle_revision>=0),
 checked_at TEXT NOT NULL, snapshot_json TEXT NOT NULL CHECK(json_valid(snapshot_json))
);
`;
