import { expect, test, launchElectron, type ElectronApplication } from "./support/test-electron";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let application: ElectronApplication | undefined;
let directory: string;
test.afterEach(async () => {
  await application?.close().catch(() => {});
  if (directory) await rm(directory, { recursive: true, force: true });
});

test("构建后的 Main、Core、Sidecar 错误映射到 TypeScript，页面和 Preload 保留可加载的源码映射", async () => {
  directory = await mkdtemp(join(tmpdir(), "marshal-source-maps-"));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  delete env.ELECTRON_RUN_AS_NODE;
  // 不依赖开发者终端的 Node 参数，覆盖应用自身的启用流程。
  delete env.NODE_OPTIONS;
  application = await launchElectron({
    ...(process.env.MARSHAL_EXECUTABLE ? { executablePath: process.env.MARSHAL_APP_PATH } : {}),
    args: [
      ...(process.env.MARSHAL_EXECUTABLE
        ? []
        : [process.env.MARSHAL_APP_PATH ?? resolve("apps/desktop")]),
      `--user-data-dir=${join(directory, "data")}`,
    ],
    env,
  });
  const page = await application.firstWindow();
  await expect(page.getByText("核心已连接", { exact: true })).toBeVisible();
  const mapping = await application.evaluate(({ app }) => {
    const { getSourceMapsSupport, findSourceMap } = process.getBuiltinModule("node:module");
    const { join } = process.getBuiltinModule("node:path");
    const { readFileSync, realpathSync } = process.getBuiltinModule("node:fs");
    const root = app.getAppPath();
    const preload = join(root, "out/preload/index.js");
    return {
      enabled: getSourceMapsSupport().enabled,
      applicationSources: findSourceMap(realpathSync(join(root, "out/main/application.js")))
        ?.payload.sources,
      preloadCode: readFileSync(preload, "utf8") as string,
      preloadMap: JSON.parse(readFileSync(`${preload}.map`, "utf8")) as {
        sources: string[];
        sourcesContent: string[];
      },
    };
  });
  expect(mapping.enabled).toBe(true);
  expect(mapping.applicationSources).toEqual(
    expect.arrayContaining([expect.stringMatching(/\/src\/main\/index\.ts$/)]),
  );
  expect(mapping.preloadCode).toContain("sourceMappingURL=index.js.map");
  expect(mapping.preloadMap.sources).toEqual(
    expect.arrayContaining([expect.stringMatching(/src\/preload\/index\.ts$/)]),
  );
  expect(
    mapping.preloadMap.sourcesContent.some((source) =>
      source.includes("contextBridge.exposeInMainWorld"),
    ),
  ).toBe(true);

  const rendererMap = await page.evaluate(async () => {
    const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]')!;
    const code = await (await fetch(script.src)).text();
    const sourceMapUrl = code.match(/sourceMappingURL=(\S+)/)?.[1];
    if (!sourceMapUrl) throw new Error("页面构建缺少 sourceMappingURL");
    return (await fetch(new URL(sourceMapUrl, script.src))).json() as Promise<{
      sources: string[];
      sourcesContent: string[];
    }>;
  });
  expect(rendererMap.sources).toEqual(
    expect.arrayContaining([expect.stringMatching(/src\/renderer\/src\/.*\.tsx?$/)]),
  );
  expect(rendererMap.sourcesContent.length).toBe(rendererMap.sources.length);

  // 不存在的来源触发真实 Core 异常，再经 Main IPC 处理；不创建媒体或下载任务。
  await page.evaluate(async () => {
    try {
      await window.desktopApi.previewSyncSource({
        id: crypto.randomUUID(),
        expectedVersion: 0,
        expectedDraftRevision: 0,
        expectedLifecycleRevision: 0,
        requestKey: crypto.randomUUID(),
      });
    } catch {
      /* 下面检查持久化日志中的源码位置。 */
    }
  });
  // 使用自有 Utility Process 和不存在的组件目录触发启动异常，不启动原生组件。
  const sidecarOutput = await application.evaluate(
    ({ app, utilityProcess, MessageChannelMain }, profile) =>
      new Promise<string>((done, fail) => {
        const { join } = process.getBuiltinModule("node:path");
        const { randomUUID } = process.getBuiltinModule("node:crypto");
        const child = utilityProcess.fork(join(app.getAppPath(), "out/main/sidecar-host.js"), [], {
          stdio: "pipe",
        });
        const { port1, port2 } = new MessageChannelMain();
        let output = "";
        child.stdout?.on("data", (bytes) => {
          output += bytes.toString();
        });
        child.stderr?.on("data", (bytes) => {
          output += bytes.toString();
        });
        const timeout = setTimeout(() => {
          child.kill();
          port1.close();
          fail(new Error("Sidecar 源码映射验证超时"));
        }, 10000);
        child.once("exit", () => {
          clearTimeout(timeout);
          port1.close();
          done(output);
        });
        child.once("spawn", () =>
          child.postMessage(
            {
              kind: "sidecar.initialize",
              protocolVersion: 1,
              hostGeneration: randomUUID(),
              coreGeneration: randomUUID(),
              resourceRoot: join(profile, "missing-components"),
              privateRoot: join(profile, "sidecar-private"),
              guardian: {
                schemaVersion: 1,
                target: `${process.platform}-${process.arch}`,
                goVersion: "go1.26.0",
                binary: {
                  path: `bin/guardian${process.platform === "win32" ? ".exe" : ""}`,
                  sha256: "a".repeat(64),
                  size: 1,
                },
              },
              bindings: [
                {
                  accountId: randomUUID(),
                  bindingId: randomUUID(),
                  generation: randomUUID(),
                  implementationId: "test.drive",
                },
              ],
            },
            [port2],
          ),
        );
      }),
    directory,
  );
  const sidecarFailure = sidecarOutput
    .trim()
    .split("\n")
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .find((record) => record?.event === "sidecar.start.failed");
  expect(sidecarFailure?.error.stack).toMatch(
    /apps\/desktop\/src\/sidecar-host\/binary-resolver\.ts:\d+:\d+/,
  );
  const path = join(directory, "data/logs/desktop.log");
  await expect.poll(async () => readFile(path, "utf8")).toContain('"event":"sync.preview.failed"');
  await application.close();
  application = undefined;
  const records = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const coreFailure = records.find((record) => record.event === "sync.preview.failed");
  const mainFailure = records.find(
    (record) => record.process === "main" && record.action === "sync.preview" && record.error,
  );
  expect(coreFailure.error.stack).toMatch(
    /packages\/media-core\/src\/sources\/sync-rules\.ts:\d+:\d+/,
  );
  expect(mainFailure.error.stack).toMatch(/apps\/desktop\/src\/main\/core-supervisor\.ts:\d+:\d+/);
});
