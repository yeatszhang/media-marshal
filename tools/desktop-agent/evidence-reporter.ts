import { resolve } from "node:path";
import type { Reporter, FullResult, TestCase, TestResult } from "@playwright/test/reporter";
import { recordTestResult, testRun } from "./test-result-evidence.ts";
import { recordFailure } from "./evidence-artifacts.ts";
import { updateEvidence } from "./evidence-store.ts";

export default class EvidenceReporter implements Reporter {
  private root: string;
  private queue = Promise.resolve();
  private collectionFailures = 0;
  constructor(options: { root?: string } = {}) {
    this.root = options.root ?? resolve(process.cwd());
  }
  private enqueue(operation: () => Promise<unknown>) {
    this.queue = this.queue
      .then(async () => {
        await operation();
      })
      .catch(() => {
        this.collectionFailures++;
      });
  }
  onTestEnd(test: TestCase, result: TestResult) {
    this.enqueue(() => recordTestResult(this.root, test, result));
  }
  onError() {
    this.enqueue(async () => {
      const run = await testRun(this.root, "runner-error");
      await recordFailure(this.root, run.runId, { kind: "startup", code: "TEST_RUNNER_ERROR" });
      await updateEvidence(this.root, run.runId, (value) => {
        value.lifecycle = "failed";
        value.assertions = "not-run";
      });
    });
  }
  async onEnd(result: FullResult) {
    await this.queue;
    if (this.collectionFailures)
      process.stderr.write(
        JSON.stringify({
          event: "evidence.reporter.collection.failed",
          count: this.collectionFailures,
        }) + "\n",
      );
    return {
      status:
        result.status === "passed" && this.collectionFailures ? ("failed" as const) : result.status,
    };
  }
}
