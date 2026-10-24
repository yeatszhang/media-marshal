import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createApplication } from "@yeatz/app-framework/application";
import { createMediaApplication } from "./application";
import { SCHEMA_VERSION } from "../infrastructure/database";
const directories: string[] = [];
const running: ReturnType<typeof createMediaApplication>[] = [];
const message = (action: string, payload: unknown = {}) => ({
  kind: "request",
  protocolVersion: 1,
  requestId: randomUUID(),
  action,
  payload,
});
async function create() {
  const directory = await mkdtemp(join(tmpdir(), "marshal-app-"));
  directories.push(directory);
  const runtime = createMediaApplication(join(directory, "app.sqlite3"));
  running.push(runtime);
  await runtime.app.start();
  return { runtime, directory };
}
afterEach(async () => {
  await Promise.allSettled(running.splice(0).map((app) => app.stop()));
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
describe("框架组装与核心消息", () => {
  it("两套 Application 的命令和 SQLite 数据独立", async () => {
    const first = await create(),
      second = await create();
    await first.runtime.dispatch(
      message("settings.save", { language: "en", embyUrl: "", tmdbProxy: "" }),
    );
    expect(
      await second.runtime.dispatch(message("settings.get")),
    ).toMatchObject({ language: "zh-CN" });
    expect(first.runtime.app.container).not.toBe(second.runtime.app.container);
    await first.runtime.stop();
    await expect(
      first.runtime.dispatch(message("runtime.get")),
    ).rejects.toMatchObject({ code: "INTERRUPTED" });
    expect(await second.runtime.dispatch(message("runtime.get"))).toMatchObject(
      { schemaVersion: SCHEMA_VERSION },
    );
  });
  it("通过真实目录保存 COPY 来源，重叠与符号链接绕过被阻止", async () => {
    const { runtime, directory } = await create();
    const source = join(directory, "source"),
      target = join(directory, "target");
    await mkdir(source);
    await mkdir(target);
    const draft = {
      name: "夸克电影",
      kind: "quark",
      sourcePath: source,
      targetPath: target,
      mediaType: "AUTO",
      operation: "COPY",
      automatic: false,
    };
    const saved = await runtime.dispatch(message("sources.save", draft));
    expect(saved).toMatchObject({
      ...draft,
      sourcePath: await realpath(source),
      targetPath: await realpath(target),
      version: 1,
    });
    expect(await runtime.dispatch(message("sources.list"))).toHaveLength(1);
    const link = join(directory, "alias");
    await symlink(source, link, process.platform==='win32'?'junction':'dir');
    await expect(
      runtime.dispatch(message("sources.save", { ...draft, sourcePath: link })),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    await expect(
      runtime.dispatch(
        message("sources.save", {
          ...draft,
          sourcePath: target,
          targetPath: target,
        }),
      ),
    ).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  });
  it("未知命令立即失败且设置不能用 URL 携带凭据", async () => {
    const { runtime } = await create();
    await expect(runtime.dispatch(message("shell.exec"))).rejects.toMatchObject(
      { code: "INVALID_REQUEST" },
    );
    await expect(
      runtime.dispatch(
        message("settings.save", {
          language: "zh-CN",
          embyUrl: "http://user:secret@localhost:8096",
          tmdbProxy: "",
        }),
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
  it("下游启动失败清理已打开数据库，可用新实例重试", async () => {
    const directory = await mkdtemp(join(tmpdir(), "marshal-fail-"));
    directories.push(directory);
    const path = join(directory, "app.sqlite3");
    const failed = createMediaApplication(path, [
      {
        id: "failed",
        dependencies: ["media.commands"],
        start() {
          throw new Error("注入启动失败");
        },
      },
    ]);
    await expect(failed.app.start()).rejects.toThrow("注入启动失败");
    expect(failed.app.state).toBe("failed");
    await expect(failed.app.start()).rejects.toThrow();
    const retried = createMediaApplication(path);
    running.push(retried);
    await retried.app.start();
    expect(await retried.dispatch(message("runtime.get"))).toMatchObject({
      schemaVersion: SCHEMA_VERSION,
    });
  });
  it("缺少依赖与循环依赖不能启动", async () => {
    const missing = createApplication({
      modules: [{ id: "a", dependencies: ["missing"] }],
    });
    await expect(missing.start()).rejects.toThrow("缺少模块依赖");
    const circular = createApplication({
      modules: [
        { id: "a", dependencies: ["b"] },
        { id: "b", dependencies: ["a"] },
      ],
    });
    await expect(circular.start()).rejects.toThrow("模块循环依赖");
  });
});
