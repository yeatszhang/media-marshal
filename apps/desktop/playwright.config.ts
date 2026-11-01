import { defineConfig } from "@playwright/test";
import { resolve } from "node:path";
const mode = process.env.MARSHAL_E2E_MODE ?? "background";
if (mode !== "background" && mode !== "foreground")
  throw new Error("MARSHAL_E2E_MODE 仅支持 background 或 foreground");
process.env.MARSHAL_E2E_MODE = mode;

export default defineConfig({
  testDir: "./tests",
  timeout: 45000,
  expect: { timeout: 20000 },
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    [resolve("tools/desktop-agent/evidence-reporter.ts"), { root: resolve(".") }],
  ],
  outputDir: "../../test-results/desktop",
});
