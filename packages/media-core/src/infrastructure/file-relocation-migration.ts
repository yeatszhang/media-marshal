/** 文件步骤先于媒体 IO 落库，文件完成后继续保留占用，直到所属修正成员完成历史事务。 */
export const fileRelocationMigrationSql = `
CREATE TABLE media_file_relocation (
 id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES correction_item(id), ordinal INTEGER NOT NULL CHECK(ordinal>=0),
 from_root_id TEXT NOT NULL REFERENCES media_target_root(id), from_slot TEXT NOT NULL,
 to_root_id TEXT NOT NULL REFERENCES media_target_root(id), to_slot TEXT NOT NULL, plan_json TEXT NOT NULL,
 phase TEXT NOT NULL CHECK(phase IN ('PENDING','COPYING','VERIFIED','QUARANTINED','PUBLISHED','OLD_QUARANTINED','REMOVING_OLD','OLD_REMOVED','DONE','NEEDS_ATTENTION')),
 resume_phase TEXT CHECK(resume_phase IN ('PENDING','COPYING','VERIFIED','QUARANTINED','PUBLISHED','OLD_QUARANTINED','REMOVING_OLD','OLD_REMOVED')),
 attempt_id TEXT, stage_evidence_json TEXT, evidence_json TEXT,
 recorded INTEGER NOT NULL DEFAULT 0 CHECK(recorded IN (0,1)),
 failure_code TEXT, failure TEXT, waiting_reason TEXT, next_attempt_at INTEGER NOT NULL DEFAULT 0,
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(item_id,ordinal),
 CHECK(recorded=0 OR phase='DONE'), CHECK(phase!='NEEDS_ATTENTION' OR resume_phase IS NOT NULL),
 CHECK(phase!='VERIFIED' OR (stage_evidence_json IS NOT NULL AND attempt_id IS NOT NULL)),
 CHECK(phase NOT IN ('PUBLISHED','OLD_QUARANTINED','REMOVING_OLD','OLD_REMOVED','DONE') OR evidence_json IS NOT NULL)
);
CREATE UNIQUE INDEX relocation_active_from ON media_file_relocation(from_root_id,from_slot) WHERE recorded=0;
CREATE UNIQUE INDEX relocation_active_to ON media_file_relocation(to_root_id,to_slot) WHERE recorded=0;
CREATE INDEX relocation_items ON media_file_relocation(item_id,ordinal);
CREATE TRIGGER relocation_immutable_plan BEFORE UPDATE OF id,item_id,ordinal,from_root_id,from_slot,to_root_id,to_slot,plan_json ON media_file_relocation
BEGIN SELECT RAISE(ABORT,'修正文件计划不可变'); END;
`;
