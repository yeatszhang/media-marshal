import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { agentFile, agentRunHome } from "./paths.ts";
import { reserveEvidence } from "./storage-reservation.ts";
import { updateEvidence } from "./evidence-store.ts";
/** 先预留全局容量，再核对运行仍可写；锁顺序与 GC 相同。 */
export async function writeEvidence(root: string, runId: string, name: string, bytes: Uint8Array) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,239}$/.test(name)) throw new Error("证据文件名无效");
  const release = await reserveEvidence(root, runId, bytes.length);
  let written = 0;
  try {
    await updateEvidence(root, runId, () => {});
    const path = join(await agentFile(root, agentRunHome(root, runId)), name);
    await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
    written = bytes.length;
    return path;
  } finally {
    await release(written);
  }
}
export function writeEvidenceJson(root: string, runId: string, name: string, value: unknown) {
  return writeEvidence(root, runId, name, Buffer.from(JSON.stringify(value, null, 2) + "\n"));
}
