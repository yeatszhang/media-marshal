import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { Electron, TestInfo } from "@playwright/test";
import { assertBuild } from "./build.ts";
import { initializeEvidence } from "./evidence-store.ts";
import { captureJson, lifecycleEvidence } from "./evidence-capture.ts";
import { createRunDirectory } from "./paths.ts";
import { digestFile } from "./resources.ts";
import { ToolError } from "./protocol.ts";
import { RUN_ANNOTATION, testKey } from "./test-result-evidence.ts";
import { assertPackagedCopy } from "./artifact-copy.ts";
import type { RunIdentity } from "./evidence-model.ts";
export type TestLaunchOptions = NonNullable<Parameters<Electron["launch"]>[0]>;
const profiles = new Map<string, string>();
export function annotateRun(info: TestInfo, run: RunIdentity) {
  const description = JSON.stringify({ sessionId: run.sessionId, runId: run.runId });
  if (
    !info.annotations.some(
      (item) => item.type === RUN_ANNOTATION && item.description === description,
    )
  )
    info.annotations.push({ type: RUN_ANNOTATION, description });
}
export async function contextIdentity(root: string, info: TestInfo, options: TestLaunchOptions) {
  const selected = (options.args ?? []).filter((item) => item.startsWith("--user-data-dir="));
  if (selected.length !== 1 || !selected[0]!.slice(16))
    throw new ToolError(
      "TEST_PROFILE_REQUIRED",
      "测试实例必须明确唯一的隔离资料目录",
      "保留原测试的 --user-data-dir 参数",
      "blocked",
    );
  const profile = resolve(selected[0]!.slice(16));
  const env = options.env ?? process.env;
  const sessionId = env.MARSHAL_AGENT_SESSION_ID
    ? z.uuid().parse(env.MARSHAL_AGENT_SESSION_ID)
    : randomUUID();
  const runId = env.MARSHAL_AGENT_RUN_ID ? z.uuid().parse(env.MARSHAL_AGENT_RUN_ID) : randomUUID();
  if (!profiles.has(profile)) {
    if (profiles.size >= 512)
      throw new ToolError(
        "TEST_PROFILE_LIMIT",
        "测试工作进程的隔离目录身份已满",
        "结束当前工作进程后开始新批次",
        "blocked",
      );
    profiles.set(profile, runId);
  }
  const run: RunIdentity = {
    producer: "test",
    sessionId,
    runId,
    profileRunId: profiles.get(profile)!,
    generation: 1,
    createdAt: new Date().toISOString(),
    options: {
      scenario: "test-fixture",
      seed: testKey(info.testId),
      mode: env.MARSHAL_E2E_MODE === "foreground" ? "foreground" : "background",
      target: options.executablePath ? "packaged" : "development",
    },
  };
  await createRunDirectory(root, runId);
  await initializeEvidence(root, run);
  annotateRun(info, run);
  return run;
}
export async function contextBuild(
  root: string,
  run: RunIdentity,
  info: TestInfo,
  options: TestLaunchOptions,
) {
  if (basename(info.file) === "installation.spec.ts" && options.executablePath) {
    // 安装矩阵刻意包含历史目标，只登记实际目标的局部身份，不认领当前源码构建。
    const executable = resolve(options.executablePath);
    const archive =
      process.platform === "darwin"
        ? join(dirname(executable), "../Resources/app.asar")
        : join(dirname(executable), "resources/app.asar");
    await captureJson(
      root,
      run,
      { kind: "build", source: "test" },
      {
        scope: "historical-installation-fixture",
        currentSourceVerified: false,
        fullArtifactVerified: false,
        executable: await digestFile(executable),
        archive: await digestFile(archive),
      },
    );
    return;
  }
  const build = await assertBuild(root, run.options.target);
  if (options.executablePath)
    await assertPackagedCopy(root, build.manifest, options.executablePath);
  if (options.env?.MARSHAL_AGENT_BUILD_ID && options.env.MARSHAL_AGENT_BUILD_ID !== build.buildId)
    throw new ToolError(
      "TEST_BUILD_MISMATCH",
      "测试诊断身份与当前构建不一致",
      "重新构建后使用当前 buildId",
      "blocked",
    );
  run.buildId = build.buildId;
  await lifecycleEvidence(root, run, "starting");
  await captureJson(
    root,
    run,
    { kind: "build", source: "tool" },
    JSON.parse(await readFile(build.manifest, "utf8")),
  );
}
