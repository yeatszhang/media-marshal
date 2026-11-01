import { createRequire } from "node:module";
import { mkdtemp, rm, open, constants } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { checkProcess } from "./check-process.ts";
import { verificationTests, type VerificationResult } from "./verify-results.ts";
import type { VerificationStep } from "./verify-steps.ts";
import { agentFile } from "./paths.ts";
import { nativeHelperRecord } from "./native-fingerprint.ts";
import { nativeCapabilities } from "./native-capabilities.ts";
import { ToolError } from "./protocol.ts";
import { redactExport } from "./export-redaction.ts";
import { stripVTControlCharacters } from "node:util";
async function readReport(path: string) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 32 * 1024 * 1024)
      throw new Error("结果超量或不可信");
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}
function environment(root: string, packaged = false) {
  const env: NodeJS.ProcessEnv = { ...process.env, MARSHAL_E2E_MODE: "background" };
  for (const key of Object.keys(env))
    if (
      /^(?:NODE_TEST_CONTEXT|NODE_CHANNEL_FD|NODE_CHANNEL_SERIALIZATION_MODE|ELECTRON_RUN_AS_NODE|MARSHAL_(?:APP_PATH|EXECUTABLE|ARTIFACT_RESOURCES|INSTALL_MATRIX|PREVIOUS_APP_PATH))$/.test(
        key,
      )
    )
      delete env[key];
  if (packaged) {
    const directory =
      process.platform === "darwin"
        ? join(
            root,
            "apps/desktop/release",
            process.arch === "arm64" ? "mac-arm64" : "mac",
            "Media Marshal.app/Contents",
          )
        : join(root, "apps/desktop/release/win-unpacked");
    Object.assign(env, {
      MARSHAL_APP_PATH:
        process.platform === "darwin"
          ? join(directory, "MacOS/Media Marshal")
          : join(directory, "Media Marshal.exe"),
      MARSHAL_ARTIFACT_RESOURCES: join(
        directory,
        process.platform === "darwin" ? "Resources" : "resources",
      ),
      MARSHAL_EXECUTABLE: "1",
    });
  }
  return env;
}
async function benchmarkResult(
  root: string,
  text: string,
  exitCode: number | null,
): Promise<VerificationResult> {
  const data = JSON.parse(text);
  if (exitCode !== 0 || data.status !== "completed")
    return {
      status:
        data.status === "blocked" ? "blocked" : data.status === "failed" ? "failed" : "unknown",
      reason: "VERIFY_BENCHMARK_INCOMPLETE",
      exitCode,
    };
  const measurement = z
    .object({
      runId: z.uuid(),
      buildId: z.string().regex(/^[a-f0-9]{64}$/),
      reportPath: z.string(),
    })
    .parse(data);
  await agentFile(root, measurement.reportPath);
  return {
    status: "passed",
    exitCode,
    measurement: { ...measurement, regression: "not-evaluated" },
  };
}
async function executeStep(root: string, step: VerificationStep): Promise<VerificationResult> {
  const temporary = await mkdtemp(join(tmpdir(), "marshal-verify-")),
    output = join(temporary, "result.json");
  let execution: Awaited<ReturnType<typeof checkProcess>> | undefined;
  try {
    const env = environment(root, step.packaged);
    let executable = process.execPath,
      args = step.args;
    const flags = [
      "--disable-warning=ExperimentalWarning",
      "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
      "--experimental-strip-types",
    ];
    if (step.runner === "node")
      args = [
        ...flags,
        "--test",
        "--test-concurrency=1",
        "--test-reporter=" + join(root, "tools/desktop-agent/check-node-reporter.mjs"),
        ...args,
      ];
    if (step.runner === "vitest") {
      executable = createRequire(join(root, "package.json"))("electron") as string;
      env.ELECTRON_RUN_AS_NODE = "1";
      args = [
        join(root, "node_modules/vitest/vitest.mjs"),
        "run",
        ...args,
        "--reporter=json",
        "--outputFile=" + output,
      ];
    }
    if (step.runner === "playwright") {
      env.PLAYWRIGHT_JSON_OUTPUT_NAME = output;
      args = [
        "node_modules/@playwright/test/cli.js",
        "test",
        "--config",
        "apps/desktop/playwright.config.ts",
        ...args,
        "--max-failures=1",
        "--reporter=./tools/desktop-agent/evidence-reporter.ts,json",
      ];
    }
    if (step.runner === "benchmark") args = [...flags, ...args];
    if (step.runner === "command" && args[0] === "openspec") {
      executable = process.platform === "win32" ? "openspec.cmd" : "openspec";
      args = args.slice(1);
    }
    const result = (execution = await checkProcess(root, executable, args, env, step.timeoutMs));
    if (result.timedOut || result.truncated)
      return {
        status: "unknown",
        reason: result.timedOut ? "CHECK_TIMEOUT" : "CHECK_OUTPUT_LIMIT",
        exitCode: result.exitCode,
        owner: result.owner,
      };
    if (step.runner === "command")
      return {
        status: result.exitCode === 0 ? "passed" : result.exitCode === null ? "unknown" : "failed",
        exitCode: result.exitCode,
        ...(result.exitCode !== 0
          ? {
              diagnostics: redactExport(
                root,
                stripVTControlCharacters(result.text + "\n" + result.errorText).slice(0, 8192),
              ).value,
            }
          : {}),
      };
    if (step.runner === "benchmark")
      return await benchmarkResult(root, result.text, result.exitCode);
    return verificationTests(
      step.runner,
      step.runner === "node" ? result.text : await readReport(output),
      result.exitCode,
    );
  } catch (error) {
    return {
      status:
        execution &&
        !execution.timedOut &&
        !execution.truncated &&
        execution.exitCode !== null &&
        execution.exitCode !== 0
          ? "failed"
          : error instanceof ToolError && error.state === "blocked"
            ? "blocked"
            : "unknown",
      reason: error instanceof ToolError ? error.code : "VERIFY_RESULT_UNAVAILABLE",
      exitCode: execution?.exitCode,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
export async function executeVerificationStep(root: string, step: VerificationStep) {
  const startedAt = Date.now();
  return {
    ...(await executeStep(root, step)),
    command: [step.runner, ...step.args],
    durationMs: Date.now() - startedAt,
  };
}
export async function nativeVerificationCapability(root: string) {
  try {
    const helper = await nativeHelperRecord(root);
    const result = await checkProcess(root, helper.path, ["capabilities"], environment(root), 5000);
    if (result.timedOut || result.truncated || result.exitCode !== 0)
      return "NATIVE_CAPABILITY_UNKNOWN";
    return nativeCapabilities(JSON.parse(result.text)).input.reason;
  } catch (error) {
    return error instanceof ToolError ? error.code : "NATIVE_CAPABILITY_UNKNOWN";
  }
}
