import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
export default defineConfig({
  testDir: "./probes",
  testMatch: "reporter.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 10000,
  reporter: [
    ["list"],
    [
      resolve("tools/desktop-agent/evidence-reporter.ts"),
      { root: process.env.MARSHAL_REPORTER_PROBE_ROOT ?? process.cwd() },
    ],
  ],
  outputDir: "../../test-results/reporter-probe",
});
