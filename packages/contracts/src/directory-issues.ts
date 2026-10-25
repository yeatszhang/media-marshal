import { z } from "zod";

/** 原因与配置引用只由宿主/核心生成，不从磁盘标记或组件错误中提取。 */
export const directoryIssueSchema = z.strictObject({
  reason: z.enum([
    "SOURCE_OVERLAP", "TARGET_OVERLAP", "DOWNLOAD_ROOT_OVERLAP", "PRIVATE_PATH",
    "IDENTITY_CHANGED", "PERMISSION_DENIED", "UNSUPPORTED_FILESYSTEM",
    "OWNERSHIP_MISMATCH", "DIRECTORY_UNAVAILABLE", "COMMIT_UNSUPPORTED",
  ]),
  conflict: z.strictObject({
    kind: z.enum(["source", "media-target", "download-root"]),
    id: z.uuid(),
  }).optional(),
});
export type DirectoryIssue = z.infer<typeof directoryIssueSchema>;

const messages: Record<DirectoryIssue["reason"], string> = {
  SOURCE_OVERLAP: "下载目录与已配置的本地来源重叠，请在来源配置中修改映射或选择独立目录",
  TARGET_OVERLAP: "下载目录与媒体目标重叠，请保留下载与媒体库分离，修改目标配置或选择独立目录",
  DOWNLOAD_ROOT_OVERLAP: "下载目录与其他受管下载目录重叠，请选择原授权目录或不重叠的独立目录",
  PRIVATE_PATH: "所选目录属于应用安装或私有数据范围，请选择独立下载目录",
  IDENTITY_CHANGED: "原卷或目录身份已变化，请连接原磁盘并重新选择原目录；不会接管同名替代目录",
  PERMISSION_DENIED: "所选目录权限不足，请检查系统文件访问权限及目录读写权限后重试",
  UNSUPPORTED_FILESYSTEM: "所选文件系统尚不支持安全下载，请选择已验证支持的本机目录",
  OWNERSHIP_MISMATCH: "目录管理标记无法与当前授权核对，请检查原应用配置或选择独立目录；不会自动接管或清理已有文件",
  DIRECTORY_UNAVAILABLE: "所选目录不可访问，请连接原磁盘并检查目录是否存在后重试",
  COMMIT_UNSUPPORTED: "所选目录未通过不覆盖提交能力检查，请选择支持该能力的本机目录",
};

export function directoryIssueMessage(issue: DirectoryIssue): string {
  return messages[issue.reason] + (issue.conflict ? `（关联配置：${issue.conflict.id}）` : "");
}
