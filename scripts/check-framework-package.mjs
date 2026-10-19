import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { strict as assert } from "node:assert";

const require = createRequire(import.meta.url);
const root = new URL("..", import.meta.url);
const lock = JSON.parse(
  await readFile(new URL("package-lock.json", root), "utf8"),
);
const expected = JSON.parse(
  await readFile(
    new URL("apps/desktop/resources/framework-origin.json", root),
    "utf8",
  ),
);
const entry = lock.packages["node_modules/@yeatz/app-framework"];
assert.equal(entry.version, expected.version);
assert.equal(entry.integrity, expected.integrity);
assert.equal(entry.resolved, expected.resolved);
const paths = ["application", "ioc", "command", "registry", "lifecycle"];
for (const path of paths) {
  assert.ok(Object.keys(require(`@yeatz/app-framework/${path}`)).length > 0);
  assert.ok(
    Object.keys(await import(`@yeatz/app-framework/${path}`)).length > 0,
  );
}
assert.equal(
  typeof require("@yeatz/app-framework/application").createApplication,
  "function",
);
assert.equal(
  typeof require("@yeatz/app-framework/ioc").StatefulService,
  "function",
);
assert.equal(
  typeof (await import("@yeatz/app-framework/react")).useServiceState,
  "function",
);
assert.match(
  await readFile(
    new URL("apps/desktop/resources/app-framework.LICENSE", root),
    "utf8",
  ),
  /MIT License/,
);
for (const workspace of ["apps/desktop", "packages/media-core"]) {
  const manifest = JSON.parse(
    await readFile(new URL(`${workspace}/package.json`, root), "utf8"),
  );
  assert.equal(manifest.dependencies["@yeatz/app-framework"], expected.version);
}
console.log(
  "框架固定版本、来源、integrity、ESM/CJS/React 公开入口与许可检查通过",
);
