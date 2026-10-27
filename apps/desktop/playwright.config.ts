import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  timeout: 45000,
  expect: { timeout: 20000 },
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: "../../test-results/desktop",
});
