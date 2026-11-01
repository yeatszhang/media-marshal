import { mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ElectronApplication } from "@playwright/test";
import { prepareScenario } from "./scenario-prepare.ts";
import { checkScenario } from "./scenario-check.ts";
import { GuiObserver } from "./gui-observe.ts";
import { GuiActions } from "./gui-actions.ts";
import { assertController } from "./controller-identity.ts";
import { EventCollector } from "./collector.ts";
import { readHealth } from "./health.ts";
import type { Server } from "node:net";
import { assertBuild, atomicJson } from "./build.ts";
import { sanitizeLogValue } from "../../apps/desktop/src/logging/shared.ts";
import { launchDesktop } from "../../apps/desktop/tests/support/electron.ts";
import { identify, sameProcess } from "./process.ts";
import { serveController } from "./transport.ts";
import {
  readSession,
  saveSession,
  publicSession,
  runHome,
  sessionsHome,
  type Session,
} from "./session-store.ts";
import { ToolError, failure, type Request, type Input } from "./protocol.ts";

interface Runtime {
  root: string;
  session: Session;
  app?: ElectronApplication;
  server?: Server;
  busy: boolean;
  collector?: EventCollector;
  gui?: GuiObserver;
  actions?: GuiActions;
  toolIdentity?: string;
}
async function openApplication(runtime: Runtime) {
  const { root, session } = runtime;
  const build = await assertBuild(root, session.options.target);
  runtime.toolIdentity = await assertController(build.manifest, runtime.toolIdentity);
  const directory = runHome(root, session.runId);
  const dataDir = join(runHome(root, session.profileRunId), "data");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  session.buildId = build.buildId;
  const fixture = await prepareScenario(root, session);
  runtime.collector = await EventCollector.create(root, session);
  const app = await launchDesktop(root, {
    ...session.options,
    dataDir,
    diagnostics: { sessionId: session.sessionId, runId: session.runId, buildId: build.buildId },
  });
  runtime.app = app;
  runtime.collector.attach(app);
  session.application = identify(app.process().pid!);
  if (!session.application || !session.application.command.includes(`--user-data-dir=${dataDir}`))
    throw new ToolError(
      "APPLICATION_IDENTITY_UNKNOWN",
      "无法核实刚启动应用的身份",
      "保留本次运行记录，核对启动进程",
      "unknown",
    );
  session.buildId = build.buildId;
  await saveSession(root, session);
  app.on("close", () => {
    if (session.status === "running") {
      session.status = "crashed";
      session.error = { code: "APPLICATION_EXITED", message: "应用异常退出，现有证据已保留" };
      void saveSession(root, session);
    }
  });
  const page = await app.firstWindow({ timeout: 20000 });
  await page.getByText("核心已连接", { exact: true }).waitFor({ timeout: 20000 });
  await assertBuild(root, session.options.target);
  if (session.generation === 1) await checkScenario(root, app, session, fixture);
  else
    await atomicJson(join(runHome(root, session.runId), "scenario-check.json"), {
      status: "not-run",
      reason: "重启保留开发操作，初始场景断言不重放",
      fixture,
      buildId: session.buildId,
    });
  session.status = "running";
  runtime.gui = new GuiObserver(root, app, session);
  runtime.actions = new GuiActions(root, session, runtime.gui);
  delete session.error;
  await saveSession(root, session);
}
async function closeApplication(runtime: Runtime) {
  const { app, session } = runtime;
  if (!app) return;
  if (session.application && !identify(session.application.pid)) {
    runtime.app = undefined;
    delete session.application;
    return;
  }
  if (!session.application || !sameProcess(session.application))
    throw new ToolError(
      "APPLICATION_IDENTITY_CHANGED",
      "原应用已退出或身份变化",
      "不能向替代进程发送停止指令；保留证据并核对",
      "unknown",
    );
  await Promise.race([
    app.close().catch((error) => {
      if (!session.application || identify(session.application.pid)) throw error;
      // OS 确认原进程已退出时，关闭过期调试连接失败不代表应用仍在写入。
    }),
    new Promise<never>((_, reject) => {
      const timer = setTimeout(
        () =>
          reject(
            new ToolError(
              "STOP_TIMEOUT",
              "应用尚未确认安全停止",
              "查询原会话，不发送强制结束或重复停止",
              "unknown",
            ),
          ),
        20000,
      );
      timer.unref();
    }),
  ]);
  if (sameProcess(session.application))
    throw new ToolError(
      "STOP_RESULT_UNKNOWN",
      "原应用仍然存活",
      "等待应用安全点并核对状态",
      "unknown",
    );
  runtime.app = undefined;
  runtime.gui = undefined;
  runtime.actions = undefined;
  delete session.application;
}
async function transition(runtime: Runtime, restart: boolean) {
  const { session, root } = runtime;
  await closeApplication(runtime);
  await runtime.collector?.close();
  if (restart) {
    session.runId = randomUUID();
    session.generation++;
    await saveSession(root, session);
    await openApplication(runtime);
  } else {
    session.status = "stopped";
    await saveSession(root, session);
  }
}
async function receiptPath(runtime: Runtime, request: Request) {
  const path = join(sessionsHome(runtime.root), runtime.session.sessionId, "requests");
  await mkdir(path, { recursive: true, mode: 0o700 });
  return join(path, request.requestId + ".json");
}
async function lifecycle(runtime: Runtime, request: Request) {
  const path = await receiptPath(runtime, request);
  const signature = JSON.stringify({ command: request.command, payload: request.payload });
  try {
    const previous = JSON.parse(await readFile(path, "utf8"));
    if (previous.signature !== signature)
      throw new ToolError(
        "REQUEST_CONFLICT",
        "原请求已用于不同操作",
        "查询原请求，新操作使用新 ID",
      );
    return previous.result;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (runtime.busy || runtime.actions?.busy)
    throw new ToolError(
      "SESSION_BUSY",
      "会话正在启动或停止",
      "查询原操作，等待状态明确",
      "blocked",
    );
  const restart = request.command === "restart";
  if (restart) {
    const build = await assertBuild(runtime.root, runtime.session.options.target);
    await assertController(build.manifest, runtime.toolIdentity);
  }
  // 先持久化受理状态，再进行关闭或启动；控制客户端断开不取消操作。
  const intent = {
    signature,
    result: {
      requestId: request.requestId,
      status: "unknown",
      session: publicSession(runtime.session),
    },
  };
  const reservation = await open(path, "wx", 0o600);
  try {
    await reservation.writeFile(JSON.stringify(intent));
    await reservation.sync();
  } finally {
    await reservation.close();
  }
  runtime.busy = true;
  runtime.session.status = restart ? "restarting" : "stopping";
  await saveSession(runtime.root, runtime.session);
  const result = {
    requestId: request.requestId,
    status: "running",
    session: publicSession(runtime.session),
  };
  await atomicJson(path, { signature, result });
  void transition(runtime, restart)
    .then(async () => {
      await atomicJson(path, {
        signature,
        result: {
          requestId: request.requestId,
          status: "completed",
          session: publicSession(runtime.session),
        },
      });
    })
    .catch(async (error) => {
      console.error(
        JSON.stringify({ event: "controller.lifecycle.failed", error: sanitizeLogValue(error) }),
      );
      runtime.session.status = "unknown";
      runtime.session.error = failure(error).error;
      await saveSession(runtime.root, runtime.session);
      await atomicJson(path, {
        signature,
        result: { ...failure(error), session: publicSession(runtime.session) },
      });
    })
    .finally(() => {
      runtime.busy = false;
      if (runtime.session.status === "stopped") runtime.server?.close();
    });
  return result;
}
function dispatcher(runtime: Runtime) {
  let queue = Promise.resolve<unknown>(undefined);
  return (request: Request) => {
    if (request.command === "status") return Promise.resolve(publicSession(runtime.session));
    if (["observe", "act", "wait"].includes(request.command)) {
      const result = queue.then<unknown>(() => {
        if (!runtime.gui || runtime.busy || runtime.session.status !== "running")
          throw new ToolError("GUI_UNAVAILABLE", "会话界面尚不可观察", "先查询会话状态", "blocked");
        if (request.command === "act") return runtime.actions!.start(request);
        if (runtime.actions?.busy)
          throw new ToolError(
            "GUI_ACTION_BUSY",
            "动作执行中，观察请先查询收据",
            "等待原动作收敛",
            "blocked",
          );
        if (request.command === "wait")
          return runtime.actions!.wait(request.payload as Input<"wait">);
        return runtime.gui.observe(request.payload as Input<"observe">);
      });
      queue = result.catch(() => undefined);
      return result;
    }
    if (request.command === "diagnose" && runtime.app && !runtime.busy)
      return readHealth(runtime.app).then((health) => ({
        health,
        collection: runtime.collector?.snapshot(),
      }));
    if (!["stop", "restart"].includes(request.command))
      return Promise.reject(
        new ToolError(
          "CAPABILITY_UNAVAILABLE",
          "该会话命令尚未接入",
          "使用 help 查看当前能力",
          "blocked",
        ),
      );
    const result = queue.then(() => lifecycle(runtime, request));
    queue = result.catch(() => undefined);
    return result;
  };
}
export async function supervise(root: string, id: string) {
  const session = await readSession(root, id);
  const runtime: Runtime = { root, session, busy: true };
  session.owner = identify(process.pid);
  if (!session.owner)
    throw new ToolError(
      "CONTROLLER_IDENTITY_UNKNOWN",
      "无法核实控制进程",
      "检查进程查询能力",
      "unknown",
    );
  await saveSession(root, session);
  runtime.server = await serveController(session, dispatcher(runtime));
  try {
    await openApplication(runtime);
  } catch (error) {
    session.status = "stopping";
    await closeApplication(runtime).catch(() => {});
    await runtime.collector?.close().catch(() => {});
    session.status =
      runtime.app || (error instanceof ToolError && error.state === "unknown")
        ? "unknown"
        : error instanceof ToolError && error.state === "blocked"
          ? "blocked"
          : "failed";
    session.error = failure(error).error;
    await saveSession(root, session);
    if (!runtime.app) runtime.server.close();
  } finally {
    runtime.busy = false;
  }
}
