import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureMainLogging } from "./main";
import { createProcessLogger } from "./node";
import { createLogReceiver } from "./receiver";
import { logLevel, RENDERER_LOG_PREFIX } from "./shared";

const directories: string[] = [];
const outputs: Awaited<ReturnType<typeof configureMainLogging>>[] = [];
async function fixture(options: Parameters<typeof configureMainLogging>[1] = {}) {
  const directory = await mkdtemp(join(tmpdir(), "marshal-logging-"));
  directories.push(directory);
  let consoleOutput = "";
  const output = await configureMainLogging(directory, {
    console: {
      write: (chunk) => {
        consoleOutput += chunk;
      },
    },
    level: "debug",
    ...options,
  });
  outputs.push(output);
  return { ...output, directory, consoleOutput: () => consoleOutput };
}
afterEach(async () => {
  for (const output of outputs.splice(0)) await output.close();
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

describe("桌面统一日志", () => {
  it("同一结构化记录写入控制台与文件，退出前落盘，并保留已有日志", async () => {
    const f = await fixture();
    f.logger.child({ scope: "test" }).info({ event: "first" }, "最后一条日志");
    await f.close();
    await f.close();
    expect(JSON.parse(await readFile(f.path, "utf8"))).toMatchObject({
      process: "main",
      scope: "test",
      event: "first",
      msg: "最后一条日志",
    });
    expect(await readFile(f.path, "utf8")).toBe(f.consoleOutput());
    const next = await configureMainLogging(f.directory, { console: { write() {} } });
    outputs.push(next);
    next.logger.info("重启追加");
    await next.close();
    expect((await readFile(f.path, "utf8")).trim().split("\n")).toHaveLength(2);
    if (process.platform !== "win32") {
      expect((await stat(f.directory)).mode & 0o777).toBe(0o700);
      expect((await stat(f.path)).mode & 0o777).toBe(0o600);
    }
  });

  it("脱敏嵌套字段、绑定、文本与地址，不泄漏原始异常及 cause", async () => {
    const f = await fixture();
    const error = Object.assign(new Error("原始远端秘密", { cause: "底层秘密" }), {
      code: "EACCES",
    });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    f.logger
      .child({ authorization: "绑定秘密", scope: "父模块" })
      .child({ component: "子模块" })
      .error(
        {
          nested: [
            { API_KEY: "字段秘密", deeper: { refreshToken: "令牌秘密", Cookie: "会话秘密" } },
          ],
          error,
          cyclic,
          url: "https://user:地址秘密@example.com/path?key=查询秘密#片段秘密",
        },
        "Authorization: Bearer 文本秘密",
      );
    await f.close();
    const content = await readFile(f.path, "utf8");
    for (const secret of [
      "绑定秘密",
      "字段秘密",
      "令牌秘密",
      "会话秘密",
      "地址秘密",
      "查询秘密",
      "片段秘密",
      "文本秘密",
      "原始远端秘密",
      "底层秘密",
    ]) {
      expect(content).not.toContain(secret);
    }
    expect(JSON.parse(content)).toMatchObject({
      scope: "父模块",
      component: "子模块",
      error: { type: "Error", code: "EACCES", stack: expect.stringContaining("logging.test.ts") },
      url: "https://example.com/path",
    });
    expect(content).toBe(f.consoleOutput());
  });

  it("按大小轮转且最多保留五份历史，归档权限仍受限", async () => {
    const f = await fixture({ size: "1K" });
    for (let index = 0; index < 40; index++) f.logger.info({ index }, "轮转记录".repeat(35));
    await f.close();
    const files = await readdir(f.directory);
    expect(files).toHaveLength(6);
    expect(files).toContain("desktop.log");
    const contents = await Promise.all(
      files.map((file) => readFile(join(f.directory, file), "utf8")),
    );
    expect(contents.join("")).toContain('"index":39');
    expect(contents.join("")).not.toContain('"index":0,');
    for (const content of contents)
      for (const line of content.trim().split("\n").filter(Boolean))
        expect(() => JSON.parse(line)).not.toThrow();
    if (process.platform !== "win32")
      for (const file of files)
        expect((await stat(join(f.directory, file))).mode & 0o777).toBe(0o600);
  });

  it("级别过滤同时作用于两个目标，允许 trace 且非法级别回退", async () => {
    expect(logLevel("invalid", "info")).toBe("info");
    const f = await fixture({ level: "trace" });
    f.logger.trace("追踪日志");
    await f.close();
    expect(JSON.parse(await readFile(f.path, "utf8"))).toMatchObject({ level: 10 });
    const filtered = await fixture({ level: "warn" });
    filtered.logger.info("不输出");
    filtered.logger.error("输出");
    await filtered.close();
    expect(await readFile(filtered.path, "utf8")).toBe(filtered.consoleOutput());
    expect(filtered.consoleOutput()).not.toContain("不输出");
  });

  it("按完整 UTF-8 行转发子进程，忽略非日志输出、超长行和伪造的进程字段", () => {
    let output = "";
    const logger = createProcessLogger("main", {
      write: (chunk) => {
        output += chunk;
      },
    });
    const receive = createLogReceiver(logger, "core").stream();
    const row = Buffer.from(
      JSON.stringify({
        level: 30,
        msg: "中文消息",
        process: "forged",
        event: "core.ready",
        payload: "私有请求",
      }) + "\n",
    );
    const split = row.indexOf(Buffer.from("中文")) + 1;
    receive(row.subarray(0, split));
    expect(output).toBe("");
    receive(row.subarray(split));
    receive("Cookie: 原始秘密\n" + "x".repeat(40 * 1024));
    receive("截断\n");
    receive(row);
    const records = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.filter((record) => record.event === "core.ready")).toHaveLength(2);
    expect(records.some((record) => record.event === "logging.dropped")).toBe(true);
    expect(records.find((record) => record.event === "core.ready")).toMatchObject({
      process: "core",
      msg: "中文消息",
      event: "core.ready",
    });
    expect(output).not.toContain("私有请求");
    expect(output).not.toContain("原始秘密");
  });

  it("Renderer 只接收带固定前缀的记录，转发再次脱敏并限流", () => {
    let output = "";
    const receive = createLogReceiver(
      createProcessLogger("main", {
        write: (chunk) => {
          output += chunk;
        },
      }),
      "renderer",
    );
    receive.renderer('{"level":50,"msg":"未标记原始内容"}');
    for (let count = 0; count < 220; count++)
      receive.renderer(
        RENDERER_LOG_PREFIX +
          JSON.stringify({ level: 50, msg: "界面异常", error: { token: "秘密" } }),
      );
    expect(output).not.toContain("未标记原始内容");
    expect(output).not.toContain("秘密");
    const records = output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records.filter((record) => record.event !== "logging.dropped")).toHaveLength(200);
    expect(records.find((record) => record.event === "logging.dropped")).toMatchObject({
      dropReason: "RATE_LIMIT",
      dropCount: 1,
      batchComplete: false,
    });
  });

  it("日志目录不可写时只报告一次，仍输出控制台且关闭不阻塞", async () => {
    const parent = await mkdtemp(join(tmpdir(), "marshal-logging-failure-"));
    directories.push(parent);
    const directory = join(parent, "file");
    await writeFile(directory, "这是文件");
    const onFailure = vi.fn();
    let consoleOutput = "";
    const f = await configureMainLogging(directory, {
      onFailure,
      console: {
        write: (chunk) => {
          consoleOutput += chunk;
        },
      },
    });
    outputs.push(f);
    f.logger.info("仍可运行");
    await f.close();
    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(consoleOutput).toContain("本地日志写入失败");
    expect(consoleOutput).toContain("仍可运行");
  });

  it("异步打开日志文件失败时不产生未处理异常", async () => {
    const directory = await mkdtemp(join(tmpdir(), "marshal-logging-open-failure-"));
    directories.push(directory);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(directory, "desktop.log"));
    const onFailure = vi.fn();
    const f = await configureMainLogging(directory, { onFailure, console: { write() {} } });
    outputs.push(f);
    f.logger.info("触发打开");
    await vi.waitFor(() => expect(onFailure).toHaveBeenCalledTimes(1));
    await f.close();
  });
});
