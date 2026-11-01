import { createRequire } from "node:module";
import { mkdtemp, rm, open, constants } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { type CheckPhase, faultPattern } from "./fault-catalog.ts";
import { checkResults } from "./check-results.ts";
import { checkProcess } from "./check-process.ts";
import { ToolError } from "./protocol.ts";
async function readResult(path: string) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || info.size > 16 * 1024 * 1024)
      throw new Error("测试结果不可信或超量");
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}
export async function executeCheck(root: string, phase: CheckPhase) {
  const temporary = await mkdtemp(join(tmpdir(), "marshal-check-")),
    output = join(temporary, "result.json");
  try {
    const executable =
      phase.runner === "vitest"
        ? (createRequire(join(root, "package.json"))("electron") as string)
        : process.execPath;
    const args =
      phase.runner === "vitest"
        ? [
            join(root, "node_modules/vitest/vitest.mjs"),
            "run",
            phase.file,
            "-t",
            faultPattern(phase),
            "--reporter=json",
            "--outputFile=" + output,
            "--no-file-parallelism",
          ]
        : [
            "--disable-warning=ExperimentalWarning",
            "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
            "--experimental-strip-types",
            "--test",
            "--test-concurrency=1",
            "--test-name-pattern=" + faultPattern(phase),
            "--test-reporter=" + join(root, "tools/desktop-agent/check-node-reporter.mjs"),
            phase.file,
          ];
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      ...(phase.runner === "vitest" ? { ELECTRON_RUN_AS_NODE: "1" } : {}),
    };
    delete environment.NODE_TEST_CONTEXT;
    delete environment.NODE_CHANNEL_FD;
    delete environment.NODE_CHANNEL_SERIALIZATION_MODE;
    const execution = await checkProcess(root, executable, args, environment, phase.timeoutMs);
    if (execution.timedOut || execution.truncated)
      return {
        status: "unknown",
        reason: execution.timedOut ? "CHECK_TIMEOUT" : "CHECK_OUTPUT_LIMIT",
        exitCode: execution.exitCode,
        owner: execution.owner,
        historyComplete: false,
      };
    return checkResults(
      phase,
      phase.runner === "vitest" ? await readResult(output) : execution.text,
      execution.exitCode,
    );
  } catch (error) {
    if (error instanceof ToolError) throw error;
    return { status: "unknown", reason: "CHECK_RESULT_UNAVAILABLE", historyComplete: false };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
