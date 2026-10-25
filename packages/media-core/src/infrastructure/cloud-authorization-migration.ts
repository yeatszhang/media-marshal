// 授权作业只保存保险箱引用；认证网络请求不占用公开 RPC 的等待窗口。
export const cloudAuthorizationMigrationSql = `
CREATE TABLE cloud_authorization (
  id TEXT PRIMARY KEY CHECK(length(id)=36), request_key TEXT NOT NULL UNIQUE CHECK(length(request_key)=36),
  account_id TEXT NOT NULL REFERENCES cloud_account(id), binding_id TEXT NOT NULL REFERENCES provider_binding(id),
  previous_binding_id TEXT REFERENCES provider_binding(id),
  credential_ref TEXT NOT NULL CHECK(length(credential_ref)=36),
  intent_json TEXT NOT NULL CHECK(json_valid(intent_json)),
  state TEXT NOT NULL CHECK(state IN ('RUNNING','SUCCEEDED','FAILED','INTERRUPTED')),
  failure_json TEXT CHECK(failure_json IS NULL OR json_valid(failure_json)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX cloud_authorization_active ON cloud_authorization(account_id) WHERE state='RUNNING';
`;
