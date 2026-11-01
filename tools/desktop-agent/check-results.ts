import { createHash } from "node:crypto";
import { z } from "zod";
import type { CheckPhase } from "./fault-catalog.ts";
const state = z.enum(["passed", "failed", "pending", "skipped", "todo", "disabled"]);
const row = z.object({
  name: z.string().max(2000),
  status: state,
  durationMs: z.number().nonnegative(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
});
const vitest = z.object({
  testResults: z
    .array(
      z.object({
        assertionResults: z
          .array(
            z.object({
              title: z.string().max(2000),
              status: state,
              duration: z.number().nonnegative().optional(),
              failureMessages: z.array(z.string().max(500000)).max(100).optional(),
            }),
          )
          .max(10000),
      }),
    )
    .max(1000),
});
function failurePosition(phase: CheckPhase, messages: string[] = []) {
  const pattern = new RegExp(phase.file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ":(\\d+):(\\d+)");
  for (const text of messages) {
    const position = pattern.exec(text);
    if (position) return { line: Number(position[1]), column: Number(position[2]) };
  }
  return {};
}
export function checkResults(phase: CheckPhase, text: string, exitCode: number | null) {
  const rows =
    phase.runner === "node"
      ? text
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => row.parse(JSON.parse(line)))
      : vitest.parse(JSON.parse(text)).testResults.flatMap((file) =>
          file.assertionResults.map((value) => ({
            name: value.title,
            status: value.status,
            durationMs: value.duration ?? 0,
            ...failurePosition(phase, value.failureMessages),
          })),
        );
  const selected = rows.filter((value) => phase.tests.includes(value.name));
  const missing = phase.tests.filter((name) => !selected.some((value) => value.name === name));
  const duplicate = selected.length !== new Set(selected.map((value) => value.name)).size;
  const failed =
    selected.some((value) => value.status === "failed") || (exitCode !== null && exitCode !== 0);
  const status = failed
    ? "failed"
    : exitCode === null
      ? "unknown"
      : missing.length || duplicate || selected.some((value) => value.status !== "passed")
        ? "blocked"
        : "passed";
  return {
    status,
    exitCode,
    selected: selected.map((value) => ({
      testId: createHash("sha256")
        .update(phase.file + ":" + value.name)
        .digest("hex"),
      status: value.status,
      durationMs: value.durationMs,
      ...(value.line
        ? {
            location: {
              file: phase.file,
              line: value.line,
              column: value.column,
              kind: phase.runner === "node" ? "test-registration" : "assertion-stack",
            },
          }
        : {}),
    })),
    missing: missing.length,
    duplicate,
    assertionSource: "repository",
    standardsComparison: "not-run",
    rawErrorRecorded: false,
    historyComplete: false,
  };
}
