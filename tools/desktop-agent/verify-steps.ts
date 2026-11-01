import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { VerifyCheck } from "./verify-catalog.ts";
import type { BusinessScope } from "./verify-plan.ts";
export interface VerificationStep {
  runner: "command" | "node" | "vitest" | "playwright" | "benchmark";
  args: string[];
  timeoutMs: number;
  packaged?: boolean;
}
const command = (...args: string[]): VerificationStep => ({
  runner: "command",
  args,
  timeoutMs: 180000,
});
export async function verificationSteps(
  root: string,
  id: VerifyCheck,
  scope: BusinessScope,
): Promise<VerificationStep[]> {
  switch (id) {
    case "architecture":
      return architectureSteps(root);
    case "types":
      return [
        command("node_modules/typescript/bin/tsc", "-p", "packages/contracts"),
        ...["packages/media-core", "apps/desktop", "tools/desktop-agent"].map((path) =>
          command("node_modules/typescript/bin/tsc", "--noEmit", "-p", path),
        ),
      ];
    case "business":
      return [
        command("node_modules/typescript/bin/tsc", "-p", "packages/contracts"),
        command("node_modules/typescript/bin/tsc", "-p", "packages/media-core"),
        {
          runner: "vitest",
          args:
            scope === "renderer"
              ? ["apps/desktop/src/renderer", "packages/contracts"]
              : scope === "core"
                ? ["packages/media-core", "packages/contracts"]
                : [],
          timeoutMs: 600000,
        },
      ];
    case "tools":
      return [
        {
          runner: "node",
          args: (await readdir(join(root, "tools/desktop-agent")))
            .filter(
              (name) =>
                name.endsWith(".test.ts") ||
                [
                  "session",
                  "gui",
                  "gui-actions",
                  "gui-image",
                  "privacy",
                  "diagnostics",
                  "reporter",
                  "trace",
                  "scenarios",
                ].some((prefix) => name === prefix + ".integration.ts"),
            )
            .sort()
            .map((name) => "tools/desktop-agent/" + name),
          timeoutMs: 600000,
        },
      ];
    case "desktop":
      return [{ runner: "playwright", args: [], timeoutMs: 2700000 }];
    case "packaged":
      return [
        { ...command("scripts/check-desktop-artifact.mjs"), packaged: true },
        {
          runner: "playwright",
          args: ["apps/desktop/tests/evidence-context.spec.ts"],
          timeoutMs: 180000,
          packaged: true,
        },
      ];
    case "native":
      return [
        {
          runner: "node",
          args: [
            "tools/desktop-agent/native.integration.ts",
            "tools/desktop-agent/gui-coordinates.integration.ts",
          ],
          timeoutMs: 180000,
        },
      ];
    case "docs":
      return [command("node_modules/vitepress/bin/vitepress.js", "build", "docs")];
    case "specs":
      return [command("openspec", "validate", "--all", "--strict")];
    case "benchmark":
      return [
        {
          runner: "benchmark",
          args: ["scripts/benchmark-desktop.mjs", "--json", "--background"],
          timeoutMs: 600000,
        },
      ];
  }
}

async function architectureSteps(root: string): Promise<VerificationStep[]> {
  return [
    command("scripts/architecture/run.mjs"),
    {
      runner: "node",
      args: (await readdir(join(root, "scripts/architecture")))
        .filter((name) => name.endsWith(".test.mjs"))
        .sort()
        .map((name) => "scripts/architecture/" + name),
      timeoutMs: 120000,
    },
    command(
      "node_modules/prettier/bin/prettier.cjs",
      "--check",
      "--ignore-unknown",
      "apps/desktop",
      "packages",
      "scripts",
      "tools/desktop-agent",
      "package.json",
      "tsconfig.base.json",
      "vitest.config.ts",
      ".prettierrc.json",
    ),
  ];
}
