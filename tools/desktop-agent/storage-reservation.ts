import { open, constants } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { agentBase } from "./paths.ts";
import { atomicJson } from "./build.ts";
import { lockEvidenceWriter } from "./evidence-store.ts";
import { evidenceWriter, ownEvidence, writerAlive, writerSchema } from "./evidence-owner.ts";
import { evidenceUsage, EVIDENCE_BUDGET } from "./storage-meter.ts";
import { ToolError } from "./protocol.ts";
const schema = z.strictObject({
  format: z.literal(1),
  measuredAt: z.number().nonnegative(),
  measuredBytes: z.number().nonnegative(),
  delta: z.number().nonnegative(),
  reservations: z
    .array(
      z.strictObject({ id: z.uuid(), bytes: z.number().int().nonnegative(), writer: writerSchema }),
    )
    .max(128),
});
type State = z.output<typeof schema>;
export interface StoragePolicy {
  maxBytes?: number;
  now?: () => number;
}
/** 调用者必须已持有 .storage.lock；保留其他进程尚未完成的预留。 */
export async function invalidateStorage(root: string) {
  const path = join(await agentBase(root), ".storage.json");
  const current = await state(root, path, Date.now());
  current.measuredAt = 0;
  await atomicJson(path, current);
}
async function state(root: string, path: string, now: number): Promise<State> {
  let current: State;
  try {
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if ((await file.stat()).size > 128 * 1024) throw new Error("容量账本过大");
      current = schema.parse(JSON.parse(await file.readFile("utf8")));
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new ToolError(
        "STORAGE_STATE_UNKNOWN",
        "容量账本格式或写入权不可信",
        "保留原件并检查存储状态",
        "unknown",
      );
    current = { format: 1, measuredAt: 0, measuredBytes: 0, delta: 0, reservations: [] };
  }
  current.reservations = current.reservations.filter((item) => writerAlive(item.writer));
  if (!current.measuredAt || now - current.measuredAt >= 2000) {
    const usage = await evidenceUsage(root);
    if (usage.unknownRoots)
      throw new ToolError(
        "STORAGE_SCOPE_UNKNOWN",
        "证据根含未知对象，无法确认容量",
        "核对链接和特殊文件，不自动追踪或删除",
        "blocked",
      );
    current.measuredAt = now;
    current.measuredBytes = usage.bytes;
    current.delta = 0;
  }
  return current;
}
export async function reserveEvidence(
  root: string,
  runId: string | undefined,
  bytes: number,
  policy: StoragePolicy = {},
) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("无效证据容量");
  if (runId) await ownEvidence(root, runId);
  const base = await agentBase(root),
    path = join(base, ".storage.json"),
    id = randomUUID();
  const unlock = await lockEvidenceWriter(base, ".storage.lock");
  try {
    const current = await state(root, path, (policy.now ?? Date.now)());
    const maximum = policy.maxBytes ?? EVIDENCE_BUDGET;
    const payloadLimit = maximum - Math.min(4 * 1024 * 1024, Math.floor(maximum / 20));
    const used =
      current.measuredBytes +
      current.delta +
      current.reservations.reduce((sum, item) => sum + item.bytes, 0);
    if (used + bytes > payloadLimit || current.reservations.length >= 128)
      throw new ToolError(
        "EVIDENCE_CAPACITY_EXHAUSTED",
        "证据预算已满或预留尚未释放",
        "运行 gc 查看可回收项；固定失败不自动删除",
        "blocked",
      );
    current.reservations.push({ id, bytes, writer: evidenceWriter() });
    await atomicJson(path, current);
  } finally {
    await unlock();
  }
  let released = false;
  return async (written = 0) => {
    if (released) return;
    const unlock = await lockEvidenceWriter(base, ".storage.lock");
    try {
      const current = await state(root, path, (policy.now ?? Date.now)());
      current.reservations = current.reservations.filter((item) => item.id !== id);
      current.delta += Math.max(0, written);
      await atomicJson(path, current);
      released = true;
    } finally {
      await unlock();
    }
  };
}
