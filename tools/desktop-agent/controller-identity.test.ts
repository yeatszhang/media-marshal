import { test } from "node:test";
import assert from "node:assert/strict";
import { controllerIdentity } from "./controller-identity.ts";
test("控制进程身份覆盖工具、契约与共享驱动；应用更新可使用同控制器重启", () => {
  const files = [
    { path: "tools/desktop-agent/cli.ts", sha256: "one" },
    { path: "packages/contracts/src/index.ts", sha256: "two" },
    { path: "apps/desktop/tests/support/electron.ts", sha256: "three" },
    { path: "apps/desktop/src/renderer/src/App.tsx", sha256: "four" },
  ];
  const original = controllerIdentity(files);
  assert.equal(original, controllerIdentity([...files].reverse()));
  for (let index = 0; index < 3; index++)
    assert.notEqual(
      original,
      controllerIdentity(
        files.map((file, position) => (position === index ? { ...file, sha256: "updated" } : file)),
      ),
    );
  assert.equal(
    original,
    controllerIdentity(
      files.map((file) => (file.path.endsWith("App.tsx") ? { ...file, sha256: "new-app" } : file)),
    ),
  );
});
