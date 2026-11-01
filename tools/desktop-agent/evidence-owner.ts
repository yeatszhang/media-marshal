import { createHash } from "node:crypto";
import { mkdir, open, constants, readdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { agentFile, agentRunHome } from "./paths.ts";
import { identify } from "./process.ts";
import { ToolError } from "./protocol.ts";
export const writerSchema = z.strictObject({
  pid: z.number().int().positive(),
  created: z.string().min(1).max(200),
  commandHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export type EvidenceWriter = z.output<typeof writerSchema>;
let current: EvidenceWriter | undefined;
export function evidenceWriter() {
  if (!current) {
    const identity = identify(process.pid);
    if (!identity)
      throw new ToolError(
        "EVIDENCE_OWNER_UNKNOWN",
        "无法核实证据写入者",
        "保留现有文件并检查进程能力",
        "unknown",
      );
    current = {
      pid: identity.pid,
      created: identity.created,
      commandHash: createHash("sha256").update(identity.command).digest("hex"),
    };
  }
  return current;
}
export async function ownEvidence(root: string, runId: string) {
  const directory = join(await agentFile(root, agentRunHome(root, runId)), ".leases");
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await agentFile(root, directory);
  const writer = evidenceWriter(),
    name = createHash("sha256").update(JSON.stringify(writer)).digest("hex") + ".json";
  if ((await readdir(directory)).length > 128)
    throw new ToolError(
      "EVIDENCE_OWNER_LIMIT",
      "本轮写入者记录已满",
      "开始新运行，保留未知写入者记录",
      "blocked",
    );
  let file;
  try {
    file = await open(join(directory, name), "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await agentFile(root, join(directory, name));
    return;
  }
  try {
    await file.writeFile(JSON.stringify(writer));
    await file.sync();
  } finally {
    await file.close();
  }
}
export function writerAlive(writer: EvidenceWriter): boolean {
  if (writer.pid === process.pid) return writer.created === evidenceWriter().created;
  const current = identify(writer.pid);
  if (current) return current.created === writer.created;
  try {
    process.kill(writer.pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    return true;
  }
}
export async function runWriters(root: string, runId: string) {
  const directory = await agentFile(root, join(agentRunHome(root, runId), ".leases"));
  const files = await readdir(directory);
  if (!files.length || files.length > 128) throw new Error("写入者清单不可信");
  const writers: EvidenceWriter[] = [];
  for (const name of files) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error("未知写入者文件");
    const file = await open(
      await agentFile(root, join(directory, name)),
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      if ((await file.stat()).size > 4096) throw new Error("写入者文件超量");
      writers.push(writerSchema.parse(JSON.parse(await file.readFile("utf8"))));
    } finally {
      await file.close();
    }
  }
  return writers;
}
