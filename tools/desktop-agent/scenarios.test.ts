import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseRequest, scenario } from "./protocol.ts";
import { sceneBytes, sceneIdentity, scenarios } from "./scenarios.ts";
import { newSession, saveSession } from "./session-store.ts";
import { prepareScenario } from "./scenario-prepare.ts";
import { identify } from "./process.ts";

test("场景目录完整、seed 决定数据但不能变成路径或命令", () => {
  assert.deepEqual(Object.keys(scenarios).sort(), [...scenario.options].sort());
  for (const name of scenario.options) {
    const seed = "../../个人目录; $(命令)\n特殊中文";
    const id = sceneIdentity(name, seed, "input");
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(id, sceneIdentity(name, seed, "input"));
    assert.notEqual(id, sceneIdentity(name, seed + "变更", "input"));
    assert.deepEqual(sceneBytes(name, seed), sceneBytes(name, seed));
    assert.equal(sceneBytes(name, seed).includes(Buffer.from("个人目录")), false);
  }
  assert.throws(
    () =>
      parseRequest({
        command: "scenario",
        payload: { mode: "run", name: "sql", path: "/个人目录" },
      }),
    /参数/,
  );
});
test("已登记应用写入者拒绝场景直接改库，不尝试创建或清空业务数据", async () => {
  const root = await mkdtemp(join(tmpdir(), "marshal-scene-admission-"));
  try {
    const session = await newSession(root, {
      scenario: "local-sync-ready",
      seed: "default",
      mode: "background",
      target: "development",
    });
    session.application = identify(process.pid);
    await saveSession(root, session);
    await assert.rejects(prepareScenario(root, session), /应用进程仍登记/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
