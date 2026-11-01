import { mkdir, open, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CoreDatabase, SCHEMA_VERSION } from "@media-marshal/media-core";
import { readSession, runHome } from "./session-store.ts";
import { sameProcess } from "./process.ts";
import { agentFile } from "./paths.ts";
import { seedContext } from "./seed-context.ts";
import { seedSync, seedReview, seedCloud } from "./seed-business.ts";
import { ToolError, failure } from "./protocol.ts";
import { atomicJson } from "./build.ts";
import { sanitizeLogValue } from "../../apps/desktop/src/logging/shared.ts";
import { SCENARIO_VERSION, scenarios } from "./scenarios.ts";
const root = resolve(import.meta.dirname, "../..");
async function seed() {
  const session = await readSession(root, process.argv[2]!);
  if (session.status !== "starting" || (session.application && sameProcess(session.application)))
    throw new ToolError(
      "SCENARIO_LIVE_WRITER",
      "运行中或已使用的会话不能直接准备业务库",
      "使用 scenario run 创建新的隔离会话",
      "blocked",
    );
  if (!process.versions.electron)
    throw new ToolError(
      "SCENARIO_RUNTIME_REQUIRED",
      "场景需要匹配 SQLite ABI 的 Electron Node",
      "通过统一 scenario／start 命令调用",
      "blocked",
    );
  const name = session.options.scenario,
    directory = await agentFile(root, runHome(root, session.profileRunId));
  if (name === "empty")
    throw new ToolError("SCENARIO_INPUT", "空场景由应用自行初始化", "通过 start 启动空场景");
  if (process.platform !== "darwin")
    throw new ToolError(
      "SCENARIO_UNSUPPORTED",
      "该场景需要已验证的 macOS 卷探测",
      "在 macOS 执行；其他平台保持未验证",
      "blocked",
    );
  const data = join(directory, "data");
  await mkdir(data, { mode: 0o700 });
  const databasePath = join(data, "desktop.sqlite3");
  try {
    await access(databasePath);
    throw new ToolError(
      "SCENARIO_DATA_EXISTS",
      "场景目录已有业务数据，不覆盖或重置",
      "创建新的隔离会话",
      "blocked",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const reservation = await open(join(directory, "scenario-preparing.json"), "wx", 0o600);
  await reservation.writeFile(
    JSON.stringify({ name, seed: session.options.seed, version: SCENARIO_VERSION }),
  );
  await reservation.close();
  const database = await CoreDatabase.open(databasePath, undefined, { exclusiveOwner: true });
  try {
    const context = await seedContext(database, directory, name, session.options.seed);
    try {
      const result =
        name === "local-sync-ready"
          ? await seedSync(context, name, session.options.seed)
          : name === "recognition-review"
            ? await seedReview(context, name, session.options.seed)
            : await seedCloud(context, name);
      const manifest = {
        version: SCENARIO_VERSION,
        name,
        seed: session.options.seed,
        schemaVersion: SCHEMA_VERSION,
        buildId: session.buildId,
        runId: session.runId,
        paths: {
          input: context.input.path,
          downloads: context.target.path,
          media: context.media.path,
          data,
        },
        substitutes: scenarios[name].substitutes,
        result,
        preparedAt: new Date().toISOString(),
      };
      await atomicJson(join(directory, "scenario.json"), manifest);
      return manifest;
    } finally {
      await context.close();
    }
  } finally {
    database.close();
  }
}
try {
  process.stdout.write(JSON.stringify({ status: "completed", result: await seed() }) + "\n");
} catch (error) {
  process.stderr.write(JSON.stringify({ error: sanitizeLogValue(error) }) + "\n");
  const value = failure(error);
  process.stdout.write(JSON.stringify(value) + "\n");
  process.exitCode = value.status === "failed" ? 1 : 2;
}
