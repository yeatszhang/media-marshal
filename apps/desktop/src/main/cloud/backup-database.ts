import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { DesktopError } from "@media-marshal/contracts";
import {
  CORE_DATA_SCHEMA_VERSION,
  CORE_DATABASE_STRUCTURE_DIGEST,
} from "@media-marshal/contracts/internal/core";

/** 仅核验已复制到私有 staging 的备份，不打开或修改当前业务数据库。 */
export function verifyBackupDatabase(path: string, declaredVersion: number) {
  let db: Database.Database | undefined;
  try {
    db = new Database(path, { readonly: true, fileMustExist: true });
    const version = db.pragma("user_version", { simple: true });
    const objects = db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE ? ORDER BY type,name",
      )
      .all("sqlite_%");
    const digest = createHash("sha256").update(JSON.stringify(objects)).digest("hex");
    const foreignKeys = db.pragma("foreign_key_check");
    if (
      version !== declaredVersion ||
      version !== CORE_DATA_SCHEMA_VERSION ||
      digest !== CORE_DATABASE_STRUCTURE_DIGEST ||
      db.pragma("integrity_check", { simple: true }) !== "ok" ||
      !Array.isArray(foreignKeys) ||
      foreignKeys.length > 0
    )
      throw new DesktopError(
        "STORAGE_ERROR",
        `备份数据库 ${path} 的格式、结构或完整性与当前构建不匹配，请使用匹配构建和完整备份；当前私有状态未替换`,
      );
  } catch (error) {
    if (error instanceof DesktopError) throw error;
    throw new DesktopError(
      "STORAGE_ERROR",
      `备份数据库 ${path} 无法完成只读核验，请选择完整的同格式备份；当前私有状态未替换`,
    );
  } finally {
    db?.close();
  }
}
