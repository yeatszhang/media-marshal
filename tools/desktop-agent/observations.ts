import { open, constants } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { agentFile } from "./paths.ts";
import { runHome, type Session } from "./session-store.ts";
import { sanitizeLogValue } from "../../apps/desktop/src/logging/shared.ts";
const count = z.number().int().nonnegative();
const summary = z.object({
  available: z.boolean(),
  closed: z.boolean(),
  pending: count,
  bytes: count,
  dropped: count,
  historyComplete: z.literal(false),
});
export async function collectionState(root: string, session: Session) {
  const directory = runHome(root, session.runId);
  try {
    const file = await open(
      await agentFile(root, join(directory, "collector.json")),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const buffer = Buffer.alloc(65537),
        { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65536) throw new Error();
      return {
        ...summary.parse(JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"))),
        path: join(directory, "observations.jsonl"),
      };
    } finally {
      await file.close();
    }
  } catch {
    return { available: false, historyComplete: false, reason: "控制器未保存采集总结，完整性未知" };
  }
}
export async function recentObservations(root: string, session: Session) {
  try {
    const file = await open(
      await agentFile(root, join(runHome(root, session.runId), "observations.jsonl")),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const info = await file.stat(),
        start = Math.max(0, info.size - 65536),
        buffer = Buffer.alloc(info.size - start);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, start);
      const lines = buffer.subarray(0, bytesRead).toString("utf8").split("\n");
      if (start > 0) lines.shift();
      let invalid = 0;
      const records = lines
        .filter(Boolean)
        .flatMap((line) => {
          try {
            const value = JSON.parse(line);
            return value.sessionId === session.sessionId && value.runId === session.runId
              ? [sanitizeLogValue(value)]
              : [];
          } catch {
            invalid++;
            return [];
          }
        })
        .slice(-30);
      return {
        records,
        integrity: {
          historyComplete: false,
          coverage: "bounded-tail",
          invalidLines: invalid,
          truncated: start > 0,
        },
      };
    } finally {
      await file.close();
    }
  } catch {
    return {
      records: [],
      integrity: { historyComplete: false, reasons: ["OBSERVATIONS_UNAVAILABLE"] },
    };
  }
}
