import { _electron, type ElectronApplication, type TestInfo } from "@playwright/test";
import { basename, relative } from "node:path";
import { digestFile } from "./resources.ts";
import {
  contextIdentity,
  contextBuild,
  annotateRun,
  type TestLaunchOptions,
} from "./test-context-identity.ts";
import { manageContext, type ManagedTestContext } from "./test-context-lifecycle.ts";
import { captureJson, lifecycleEvidence } from "./evidence-capture.ts";
import { STARTUP_ANNOTATION, testKey } from "./test-result-evidence.ts";
import type { RunIdentity } from "./evidence-model.ts";
const contexts = new Set<ManagedTestContext>();
const safeFiles = new Set([
  "presentation.spec.ts",
  "workspace-design.spec.ts",
  "evidence-context.spec.ts",
]);
export function annotateContexts(info: TestInfo) {
  for (const entry of contexts)
    if (entry.file === info.file && !entry.closed) annotateRun(info, entry.run);
}
export async function awaitContextCollection(info: TestInfo) {
  annotateContexts(info);
  const selected = [...contexts].filter((entry) => entry.file === info.file);
  await Promise.all(selected.map((entry) => entry.completion?.catch(() => {})));
  for (const entry of selected) if (entry.closed) contexts.delete(entry);
}
export async function launchTestContext(
  root: string,
  info: TestInfo,
  options: TestLaunchOptions,
): Promise<ElectronApplication> {
  let run: RunIdentity | undefined, app: ElectronApplication | undefined;
  try {
    run = await contextIdentity(root, info, options);
    await contextBuild(root, run, info, options);
    await captureJson(
      root,
      run,
      { kind: "scenario", source: "test" },
      {
        name: "test-fixture",
        definition: basename(info.file),
        definitionDigest: await digestFile(info.file),
        testId: testKey(info.testId),
        parametersOwnedBy: "version-controlled-test",
        fixtureContentsCaptured: false,
      },
    );
    await captureJson(
      root,
      run,
      { kind: "reproduction", source: "test" },
      {
        testId: testKey(info.testId),
        file: basename(info.file),
        command: ["npm", "run", "test:desktop", "--", `${relative(root, info.file)}:${info.line}`],
        fixtureRequired: true,
        currentBuildRequired: Boolean(run.buildId),
      },
    );
    app = await _electron.launch({
      ...options,
      env: {
        ...((options.env ?? process.env) as Record<string, string>),
        MARSHAL_AGENT_SESSION_ID: run.sessionId,
        MARSHAL_AGENT_RUN_ID: run.runId,
        ...(run.buildId ? { MARSHAL_AGENT_BUILD_ID: run.buildId } : {}),
      },
    });
    const profile = options.args!.find((item) => item.startsWith("--user-data-dir="))!.slice(16);
    const entry = await manageContext(
      root,
      run,
      app,
      info.file,
      profile,
      safeFiles.has(basename(info.file)) ? "safe-synthetic" : "sensitive",
    );
    contexts.add(entry);
    return app;
  } catch (error) {
    info.annotations.push({ type: STARTUP_ANNOTATION, ...(run ? { description: run.runId } : {}) });
    await app?.close().catch(() => {});
    if (run)
      await lifecycleEvidence(root, run, "failed", {
        kind: "startup",
        code: "TEST_CONTEXT_START_FAILED",
      });
    throw error;
  }
}
