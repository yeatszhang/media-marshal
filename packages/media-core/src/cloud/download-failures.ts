import type { CloudErrorCode } from "@media-marshal/contracts";

/** 原失败类别用于调度；提交核对的细分原因单独持久化，避免将可修复条件混成通用冲突。 */
const details = new Set<CloudErrorCode>(["TARGET_OCCUPIED", "LOCAL_FILE_CHANGED", "FILE_EVIDENCE_MISMATCH", "LOCAL_FILE_MISSING", "RECEIPT_CONFLICT", "STOP_UNCONFIRMED"]);
export function downloadFailureColumns(code: CloudErrorCode | null): [CloudErrorCode | null, CloudErrorCode | null] {
  return code && details.has(code) ? ["CONFLICT", code] : [code, null];
}
