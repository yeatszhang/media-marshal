import type { ElectronApplication } from "@playwright/test";
import { join } from "node:path";
import { TraceSession, type TracePolicy } from "./trace-session.ts";
import { EventCollector } from "./collector.ts";
import { GuiObserver } from "./gui-observe.ts";
import { commands } from "./protocol.ts";
import {
  captureJson,
  captureExisting,
  captureArtifact,
  lifecycleEvidence,
} from "./evidence-capture.ts";
import { agentRunHome } from "./paths.ts";
import { contextLogs } from "./test-context-logs.ts";
import { healthWithin } from "./health-budget.ts";
import { ToolError } from "./protocol.ts";
import type { RunIdentity } from "./evidence-model.ts";
export interface ManagedTestContext {
  run: RunIdentity;
  app: ElectronApplication;
  file: string;
  closed: boolean;
  completion?: Promise<void>;
}
async function finalObservation(
  root: string,
  run: RunIdentity,
  app: ElectronApplication,
  policy: TracePolicy,
) {
  if (policy === "sensitive") {
    for (const kind of ["aria", "image"] as const)
      await captureArtifact(root, run, {
        kind,
        source: "dom",
        status: "blocked",
        reason: "SENSITIVE_TEST_CONTEXT",
      });
    return;
  }
  try {
    await new GuiObserver(root, app, run).observe(commands.observe.parse({ image: true }));
  } catch {
    for (const kind of ["aria", "image"] as const)
      await captureArtifact(root, run, {
        kind,
        source: "dom",
        status: "missing",
        reason: "TEST_WINDOW_UNAVAILABLE",
      });
  }
}
export async function manageContext(
  root: string,
  run: RunIdentity,
  app: ElectronApplication,
  file: string,
  profile: string,
  policy: TracePolicy,
) {
  const collector = await EventCollector.create(root, run);
  collector.attach(app);
  const trace = new TraceSession(root, run, app.context());
  const originalClose = app.close.bind(app);
  const entry: ManagedTestContext = { run, app, file, closed: false };
  let requestedClose = false;
  try {
    if (policy === "safe-synthetic") {
      const page = await app.firstWindow();
      await page.getByText("核心已连接", { exact: true }).waitFor({ timeout: 20000 });
    }
    await trace.start(policy);
    await lifecycleEvidence(root, run, "running");
  } catch (error) {
    await trace.stop().catch(() => {});
    await collector.close().catch(() => {});
    throw error;
  }
  const finish = async (live: boolean) => {
    if (live) {
      await finalObservation(root, run, app, policy);
      try {
        await captureJson(root, run, { kind: "health", source: "tool" }, await healthWithin(app));
      } catch (error) {
        await captureArtifact(root, run, {
          kind: "health",
          source: "tool",
          status: "missing",
          reason: error instanceof ToolError ? error.code : "HEALTH_UNAVAILABLE",
        });
      }
    }
    await trace.stop();
    if (live) await originalClose();
    await collector.close();
    for (const name of ["observations.jsonl", "collector.json"])
      await captureExisting(root, run, join(agentRunHome(root, run.runId), name), {
        kind: "observation",
        source: "tool",
      });
    await contextLogs(root, run, profile);
    await lifecycleEvidence(
      root,
      run,
      live ? "closed" : "crashed",
      live ? undefined : { kind: "crash", code: "TEST_APPLICATION_EXITED" },
    );
    entry.closed = true;
  };
  app.close = async () => {
    if (!entry.completion) {
      requestedClose = true;
      entry.completion = finish(true).catch(async (error) => {
        await lifecycleEvidence(root, run, "unknown", {
          kind: "collection",
          code: "TEST_CONTEXT_CLOSE_FAILED",
        });
        throw error;
      });
    }
    await entry.completion;
  };
  app.on("close", () => {
    if (!requestedClose && !entry.completion) {
      entry.completion = finish(false);
      void entry.completion.catch(() => {});
    }
  });
  return entry;
}
