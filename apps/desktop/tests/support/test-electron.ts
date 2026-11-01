import { test } from "@playwright/test";
import { resolve } from "node:path";
import { desktopLaunchOptions, type LaunchOptions } from "./electron";
import type { TestLaunchOptions } from "../../../../tools/desktop-agent/test-context-identity";
const driver = () => import("../../../../tools/desktop-agent/test-context.ts");
export { test, expect, type ElectronApplication, type Locator, type Page } from "@playwright/test";
test.beforeEach(async ({}, info) => {
  (await driver()).annotateContexts(info);
});
test.afterEach(async ({}, info) => {
  await (await driver()).awaitContextCollection(info);
});
export async function launchElectron(options: TestLaunchOptions) {
  return (await driver()).launchTestContext(resolve("."), test.info(), options);
}
export async function launchDesktop(root: string, options: LaunchOptions) {
  const selected =
    options.target === "packaged" && process.env.MARSHAL_APP_PATH
      ? { ...options, executablePath: process.env.MARSHAL_APP_PATH }
      : options;
  return (await driver()).launchTestContext(
    root,
    test.info(),
    await desktopLaunchOptions(root, selected),
  );
}
