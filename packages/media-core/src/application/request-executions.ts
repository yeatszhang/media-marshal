import { withCoreRequest, businessReferences } from "./diagnostic-context.js";
import { scopedLogger, type CoreLogger } from "./logger.js";
import { DesktopError } from "@media-marshal/contracts";

interface Execution {
  task: Promise<unknown>;
  endWait: (code: "TIMEOUT" | "INTERRUPTED") => void;
}
/** 请求等待和业务执行分别持有；取消收据不能释放仍在执行的操作名额。 */
export class RequestExecutions {
  private readonly executions = new Map<string, Execution>();
  private accepting = true;
  constructor(
    private readonly timeoutMs = 15000,
    private readonly limit = 64,
    private readonly logger?: CoreLogger,
  ) {}
  run<T>(id: string, execute: () => Promise<T> | T): Promise<T> {
    if (!this.accepting)
      return Promise.reject(new DesktopError("INTERRUPTED", "核心正在停止", true));
    if (this.executions.has(id))
      return Promise.reject(new DesktopError("CONFLICT", "请求标识仍在执行，请查询原作业", true));
    if (this.executions.size >= this.limit)
      return Promise.reject(
        new DesktopError("CONFLICT", "核心执行请求过多，请等待原请求完成后重试", true),
      );
    let resolve!: (result: T) => void,
      reject!: (error: unknown) => void,
      waiting = true;
    const response = new Promise<T>((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const finish = (outcome: { ok: true; result: T } | { ok: false; error: unknown }) => {
      if (!waiting) return;
      waiting = false;
      clearTimeout(timer);
      if (outcome.ok) resolve(outcome.result);
      else reject(outcome.error);
    };
    const endWait = (code: "TIMEOUT" | "INTERRUPTED") =>
      finish({
        ok: false,
        error: new DesktopError(
          code,
          code === "TIMEOUT"
            ? "请求执行等待超时；已接收的作业可能继续，请查询原状态，不要重复提交"
            : "已停止等待请求结果；已接收的作业可能继续，请查询原状态",
          true,
        ),
      });
    const timer = setTimeout(() => endWait("TIMEOUT"), this.timeoutMs);
    const task = Promise.resolve().then(() =>
      withCoreRequest(id, async () => {
        const log = scopedLogger(this.logger, "requests"),
          started = performance.now();
        log.debug({ event: "core.command.started" }, "业务请求开始执行");
        try {
          const result = await execute();
          log.debug(
            {
              event: "core.command.returned",
              ...businessReferences(result),
              durationMs: Math.round(performance.now() - started),
            },
            "业务请求已返回，后台完成须核对作业",
          );
          return result;
        } catch (error) {
          log.warn(
            {
              event: "core.command.failed",
              error,
              durationMs: Math.round(performance.now() - started),
            },
            "业务请求执行失败",
          );
          throw error;
        }
      }),
    );
    const entry = { task, endWait };
    this.executions.set(id, entry);
    void task
      .then(
        (result) => finish({ ok: true, result }),
        (error) => finish({ ok: false, error }),
      )
      .finally(() => {
        clearTimeout(timer);
        if (this.executions.get(id) === entry) this.executions.delete(id);
      });
    return response;
  }
  cancel(id: string, reason: "TIMEOUT" | "INTERRUPTED") {
    this.executions.get(id)?.endWait(reason);
  }
  quiesce() {
    this.accepting = false;
    for (const execution of this.executions.values()) execution.endWait("INTERRUPTED");
  }
  async drain() {
    await Promise.allSettled([...this.executions.values()].map((execution) => execution.task));
  }
}
