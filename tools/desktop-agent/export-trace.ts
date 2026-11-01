import { unzipSync, zipSync } from "fflate";
import { sensitiveMarker, redactExport } from "./export-redaction.ts";
import { ToolError } from "./protocol.ts";
export function exportTrace(root: string, bytes: Uint8Array) {
  let count = 0,
    total = 0;
  let redactions = 0,
    truncated = false;
  try {
    const files = unzipSync(bytes, {
      filter(file) {
        count++;
        total += file.originalSize;
        if (
          count > 512 ||
          total > 64 * 1024 * 1024 ||
          file.originalSize > 16 * 1024 * 1024 ||
          file.name.startsWith("/") ||
          file.name.split(/[\\/]/).includes("..") ||
          file.name.includes("\0") ||
          !/^(?:[^/]+\.(?:trace|network|stacks)|(?:resources|screencast)\/[a-zA-Z0-9@._-]+)$/.test(
            file.name,
          )
        )
          throw new Error("归档范围不可信");
        return true;
      },
    });
    if (!Object.keys(files).some((name) => name.endsWith(".trace")))
      throw new Error("缺少 trace 流");
    for (const [name, value] of Object.entries(files)) {
      const head = Buffer.from(value.subarray(0, 12));
      const binary =
        head.subarray(0, 8).toString("hex") === "89504e470d0a1a0a" ||
        head.subarray(0, 3).toString("hex") === "ffd8ff" ||
        (head.subarray(0, 4).toString("ascii") === "RIFF" &&
          head.subarray(8, 12).toString("ascii") === "WEBP");
      if (!binary) {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(value);
        if (sensitiveMarker(text))
          throw new ToolError(
            "TRACE_SENSITIVE_MARKER",
            "trace 存在敏感标记，整份不导出",
            "只采集无账号合成流程",
            "blocked",
          );
        if (/\.(trace|network|stacks)$/.test(name)) {
          const lines = text
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const safe = redactExport(root, JSON.parse(line));
              redactions += safe.redactions;
              truncated ||= safe.truncated;
              return JSON.stringify(safe.value);
            });
          files[name] = new TextEncoder().encode(lines.join("\n") + "\n");
        } else {
          const safe = redactExport(root, text);
          redactions += safe.redactions;
          truncated ||= safe.truncated;
          files[name] = new TextEncoder().encode(String(safe.value));
        }
      }
      if (name.endsWith(".trace") && value.length === 0) throw new Error("空 trace 流");
    }
    return {
      bytes: zipSync(files, { level: 1 }),
      entries: count,
      inflatedBytes: total,
      redactions,
      truncated,
    };
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(
      "TRACE_ARCHIVE_REJECTED",
      "trace 格式、路径或解压预算不可信",
      "保留本地原件并缩小采集",
      "blocked",
    );
  }
}
