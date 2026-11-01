import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { runHome, type Session } from "./session-store.ts";
import { initializeEvidence } from "./evidence-store.ts";
import {
  captureJson,
  captureArtifact,
  captureExisting,
  lifecycleEvidence,
} from "./evidence-capture.ts";
import { recentLogs } from "./log-reader.ts";
import { readHealth } from "./health.ts";
import type { ElectronApplication } from "@playwright/test";

export async function beginEvidence(root: string, session: Session, manifest?: string) {
  await initializeEvidence(root, session);
  if (manifest) {
    await captureJson(
      root,
      session,
      { kind: "build", source: "tool" },
      JSON.parse(await readFile(manifest, "utf8")),
    );
    await lifecycleEvidence(root, session, "starting");
  }
  await captureJson(
    root,
    session,
    { kind: "reproduction", source: "tool" },
    {
      command: "start",
      payload: session.options,
      runId: session.runId,
      buildId: session.buildId,
      buildRequired: true,
      credentialRequired: false,
    },
  );
}
export async function healthEvidence(root: string, session: Session, app?: ElectronApplication) {
  if (!app)
    return captureArtifact(root, session, {
      kind: "health",
      source: "tool",
      status: "missing",
      reason: "APPLICATION_UNAVAILABLE",
    });
  try {
    return await captureJson(
      root,
      session,
      { kind: "health", source: "tool" },
      await readHealth(app),
    );
  } catch {
    return captureArtifact(root, session, {
      kind: "health",
      source: "tool",
      status: "missing",
      reason: "HEALTH_UNAVAILABLE",
    });
  }
}
export async function finishEvidence(root: string, session: Session) {
  const directory = runHome(root, session.runId);
  await captureExisting(root, session, join(directory, "observations.jsonl"), {
    kind: "observation",
    source: "tool",
  });
  await captureExisting(root, session, join(directory, "collector.json"), {
    kind: "observation",
    source: "tool",
  });
  try {
    await captureJson(
      root,
      session,
      { kind: "log", source: "tool" },
      await recentLogs(root, session.sessionId, { limit: 100 }),
    );
  } catch {
    await captureArtifact(root, session, {
      kind: "log",
      source: "tool",
      status: "missing",
      reason: "LOG_UNAVAILABLE",
    });
  }
  await lifecycleEvidence(root, session, "closed");
}
