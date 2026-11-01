import { open, unlink, constants } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { agentFile, agentRunHome } from "./paths.ts";
import { atomicJson } from "./build.ts";
import { identify } from "./process.ts";
import { ToolError } from "./protocol.ts";
import {
  artifactKinds,
  evidenceChecksum,
  manifestContent,
  manifestSchema,
  type EvidenceManifest,
  type RunIdentity,
} from "./evidence-model.ts";
const MAXIMUM_MANIFEST = 4 * 1024 * 1024;
export async function readEvidence(root: string, runId: string): Promise<EvidenceManifest> {
  const path = await agentFile(root, join(agentRunHome(root, runId), "manifest.json"));
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if ((await file.stat()).size > MAXIMUM_MANIFEST) throw new Error("超量");
    const parsed = manifestSchema.parse(JSON.parse(await file.readFile("utf8")));
    const { checksum, ...value } = parsed;
    if (value.runId !== runId || checksum !== evidenceChecksum(value))
      throw new Error("身份或摘要错误");
    return value;
  } catch {
    throw new ToolError(
      "EVIDENCE_MANIFEST_INVALID",
      "证据索引身份、格式或摘要无效",
      "保留原文件，不能覆盖为成功结果",
      "blocked",
    );
  } finally {
    await file.close();
  }
}
async function lockManifest(directory: string) {
  const path = join(directory, ".manifest.lock"),
    deadline = Date.now() + 1000;
  while (true) {
    try {
      const file = await open(path, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify({ owner: identify(process.pid), nonce: randomUUID() }));
        return async () => {
          await file.close();
          await unlink(path);
        };
      } catch (error) {
        await file.close();
        await unlink(path);
        throw error;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline)
        throw new ToolError(
          "EVIDENCE_WRITER_UNKNOWN",
          "证据写入权未确认释放",
          "核对 .manifest.lock 的原进程；不删除未知写入者记录",
          "unknown",
        );
      await new Promise((done) => setTimeout(done, 20));
    }
  }
}
export async function updateEvidence(
  root: string,
  runId: string,
  mutate: (value: EvidenceManifest) => void,
) {
  const directory = await agentFile(root, agentRunHome(root, runId)),
    unlock = await lockManifest(directory);
  try {
    const value = await readEvidence(root, runId);
    mutate(value);
    value.updatedAt = new Date().toISOString();
    const checked = manifestContent.parse(value);
    await atomicJson(join(directory, "manifest.json"), {
      ...checked,
      checksum: evidenceChecksum(checked),
    });
    return checked;
  } finally {
    await unlock();
  }
}
export async function initializeEvidence(
  root: string,
  identity: RunIdentity,
  producer: "controller" | "test" = "controller",
) {
  const directory = await agentFile(root, agentRunHome(root, identity.runId)),
    unlock = await lockManifest(directory);
  try {
    try {
      const current = await readEvidence(root, identity.runId);
      if (
        current.sessionId !== identity.sessionId ||
        current.generation !== identity.generation ||
        current.producer !== producer ||
        current.profileRunId !== identity.profileRunId ||
        current.mode !== identity.options.mode ||
        current.target !== identity.options.target ||
        current.scenario.name !== identity.options.scenario ||
        current.scenario.seed !== identity.options.seed ||
        (current.buildId && identity.buildId && current.buildId !== identity.buildId)
      )
        throw new ToolError(
          "EVIDENCE_IDENTITY_CONFLICT",
          "运行证据身份已被其他实例使用",
          "新建 runId，保留原证据",
          "blocked",
        );
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const now = new Date().toISOString();
    const value = manifestContent.parse({
      format: 1,
      sessionId: identity.sessionId,
      runId: identity.runId,
      profileRunId: identity.profileRunId,
      generation: identity.generation,
      producer,
      createdAt: now,
      updatedAt: now,
      buildId: identity.buildId,
      scenario: { name: identity.options.scenario, seed: identity.options.seed },
      mode: identity.options.mode,
      target: identity.options.target,
      lifecycle: "starting",
      historyComplete: false,
      assertions: "not-run",
      failures: [],
      artifacts: artifactKinds.map((kind) => ({
        id: randomUUID(),
        kind,
        source: ["aria", "image", "trace"].includes(kind) ? "dom" : "tool",
        time: now,
        status: "not-run",
        reason: "NOT_CAPTURED",
        historyComplete: false,
      })),
    });
    await atomicJson(join(directory, "manifest.json"), {
      ...value,
      checksum: evidenceChecksum(value),
    });
    return value;
  } finally {
    await unlock();
  }
}
