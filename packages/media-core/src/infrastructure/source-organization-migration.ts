export const sourceOrganizationMigrationSql = `
CREATE TABLE ingestion_candidate_policy (
 candidate_id TEXT PRIMARY KEY REFERENCES ingestion_candidate(id), policy_key TEXT NOT NULL CHECK(length(policy_key)=64),
 configuration_json TEXT NOT NULL CHECK(json_valid(configuration_json)), target_root_id TEXT NOT NULL REFERENCES media_target_root(id)
);
CREATE TRIGGER ingestion_candidate_policy_immutable BEFORE UPDATE ON ingestion_candidate_policy
BEGIN SELECT RAISE(ABORT,'整理候选策略不可修改'); END;
`;
