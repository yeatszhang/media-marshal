/** 追加绑定快照和请求收据；历史直接路径关联在首次重新验证时升级。 */
export const embyBindingMigrationSql = `
ALTER TABLE emby_library ADD COLUMN binding_json TEXT CHECK(binding_json IS NULL OR json_valid(binding_json));
ALTER TABLE emby_delivery ADD COLUMN binding_json TEXT CHECK(binding_json IS NULL OR json_valid(binding_json));
CREATE TABLE emby_binding_command (
 request_key TEXT PRIMARY KEY, signature TEXT NOT NULL, connection_version INTEGER NOT NULL
);
`;
