import { DesktopError } from "@media-marshal/contracts";

/** 只投影受控原因；原始文件系统异常交给日志，不向界面透传路径或堆栈。 */
export function sourceFileFailure(error: unknown, managed = false): string {
  if (error instanceof DesktopError) return error.message.slice(0, 500);
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const receipt = managed ? "；同步成功记录仍保留，识别不会自动重新下载" : "";
  if (["ENOENT", "ENOTDIR"].includes(code))
    return `文件或其父目录已不存在，请恢复原路径后重新扫描${receipt}`;
  if (["EACCES", "EPERM"].includes(code))
    return "文件或其父目录读取权限不足，请恢复读取权限后重新扫描";
  if (["ENODEV", "ENXIO", "ESTALE"].includes(code))
    return "文件所在磁盘或挂载已不可用，请连接原磁盘并恢复原路径后重新扫描";
  if (code === "EIO") return "读取文件时发生磁盘 I/O 错误，请检查磁盘连接与健康状态后重新扫描";
  return "文件核对未完成，原因尚不明确，请重新扫描；若仍失败，请查看日志中的逐项诊断";
}
