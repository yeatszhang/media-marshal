import { open, constants, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { captureJson, captureArtifact } from "./evidence-capture.ts";
import { projectLog } from "./log-record.ts";
import type { RunIdentity } from "./evidence-model.ts";
export async function contextLogs(root: string, run: RunIdentity, profile: string) {
  try {
    const physical = await realpath(profile);
    const temporary = await realpath(tmpdir()),
      local = resolve(await realpath(root), "test-results");
    if (!(physical.startsWith(temporary + "/") || physical.startsWith(local + "/")))
      throw new Error("不是隔离测试目录");
    const path = join(physical, "logs/desktop.log");
    if ((await realpath(path)) !== path) throw new Error("日志路径含链接");
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error("不是日志文件");
      const start = Math.max(0, info.size - 192 * 1024),
        bytes = Buffer.alloc(info.size - start);
      const read = await file.read(bytes, 0, bytes.length, start);
      const lines = bytes.subarray(0, read.bytesRead).toString("utf8").split("\n");
      if (start) lines.shift();
      let invalid = 0;
      const records = lines
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const value = JSON.parse(line);
            return value.sessionId === run.sessionId && value.runId === run.runId
              ? [projectLog(value)]
              : [];
          } catch {
            invalid++;
            return [];
          }
        })
        .slice(-100);
      return await captureJson(
        root,
        run,
        { kind: "log", source: "tool" },
        {
          records,
          historyComplete: false,
          coverage: "bounded-tail",
          truncated: start > 0,
          invalidLines: invalid,
          ...(records.length ? {} : { reason: "NO_LINKED_LOG_RECORDS" }),
        },
      );
    } finally {
      await file.close();
    }
  } catch {
    return captureArtifact(root, run, {
      kind: "log",
      source: "tool",
      status: "missing",
      reason: "TEST_LOG_UNAVAILABLE",
    });
  }
}
