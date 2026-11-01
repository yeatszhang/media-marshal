import { createHash } from "node:crypto";
import { z } from "zod";
export type VerificationState = "passed" | "failed" | "blocked" | "unknown" | "not-run";
export interface VerificationResult {
  status: VerificationState;
  reason?: string;
  command?: string[];
  durationMs?: number;
  diagnostics?: unknown;
  owner?: { pid: number; created: string; commandHash: string };
  exitCode?: number | null;
  counts?: { passed: number; failed: number; skipped: number };
  tests?: { testId: string; status: string }[];
  measurement?: { runId: string; buildId: string; reportPath: string; regression: "not-evaluated" };
}
const row = z.object({ name: z.string(), status: z.string() });
/** 仅保留用例摘要；断言值、标题和原始错误不进入汇总。 */
export function verificationTests(
  runner: "node" | "vitest" | "playwright",
  text: string,
  exitCode: number | null,
): VerificationResult {
  let rows: { name: string; status: string }[];
  if (runner === "node") {
    rows = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => row.parse(JSON.parse(line)));
  } else if (runner === "vitest") {
    const data = z
      .object({
        testResults: z.array(
          z.object({
            name: z.string(),
            assertionResults: z.array(z.object({ fullName: z.string(), status: z.string() })),
          }),
        ),
      })
      .parse(JSON.parse(text));
    rows = data.testResults.flatMap((file) =>
      file.assertionResults.map((test) => ({
        name: file.name + ":" + test.fullName,
        status: test.status,
      })),
    );
  } else {
    const data = JSON.parse(text);
    rows = [];
    const visit = (suites: unknown[]) => {
      for (const suite of suites) {
        const parsed = z
          .object({
            suites: z.array(z.unknown()).optional(),
            specs: z
              .array(
                z.object({
                  id: z.string(),
                  tests: z.array(
                    z.object({
                      results: z.array(z.object({ status: z.string() })),
                    }),
                  ),
                }),
              )
              .optional(),
          })
          .parse(suite);
        visit(parsed.suites ?? []);
        for (const spec of parsed.specs ?? [])
          for (const test of spec.tests)
            rows.push({
              name: spec.id,
              status: test.results.length === 1 ? test.results[0]!.status : "unknown",
            });
      }
    };
    visit(z.array(z.unknown()).parse(data.suites));
  }
  const counts = {
    passed: rows.filter((value) => value.status === "passed").length,
    failed: rows.filter((value) => ["failed", "timedOut", "interrupted"].includes(value.status))
      .length,
    skipped: rows.filter(
      (value) => !["passed", "failed", "timedOut", "interrupted"].includes(value.status),
    ).length,
  };
  return {
    status:
      counts.failed || (exitCode !== null && exitCode !== 0)
        ? "failed"
        : exitCode === null
          ? "unknown"
          : !rows.length || counts.skipped
            ? "blocked"
            : "passed",
    reason: !rows.length ? "VERIFY_NO_TESTS" : counts.skipped ? "VERIFY_TESTS_SKIPPED" : undefined,
    exitCode,
    counts,
    tests: rows.map((value) => ({
      testId: createHash("sha256")
        .update(runner + ":" + value.name)
        .digest("hex"),
      status: value.status,
    })),
  };
}
export function verificationOutcome(results: VerificationResult[], sourceChanged = false) {
  const status = results.some((value) => value.status === "failed")
    ? "failed"
    : sourceChanged || results.some((value) => value.status === "unknown")
      ? "unknown"
      : !results.length || results.some((value) => value.status !== "passed")
        ? "blocked"
        : "completed";
  return { status, allPlannedChecksPassed: status === "completed" } as const;
}
