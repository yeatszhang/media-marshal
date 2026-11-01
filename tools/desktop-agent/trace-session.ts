import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { mkdtemp, rm, open, constants } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { BrowserContext, Page, Frame } from "@playwright/test";
import { trustedPage } from "./collector.ts";
import { initializeEvidence } from "./evidence-store.ts";
import { recordArtifact, recordFailure } from "./evidence-artifacts.ts";
import type { RunIdentity } from "./evidence-model.ts";
import { writeEvidence } from "./evidence-write.ts";
import { ToolError } from "./protocol.ts";
import { watchSensitive, sensitivePage } from "./sensitive-context.ts";

export type TracePolicy = "sensitive" | "safe-synthetic";
/** 完整 trace 只供版本管理中的无账号合成流程；任一敏感转场使整段作废。 */
export class TraceSession {
  private root: string;
  private run: RunIdentity;
  private context: BrowserContext;
  private producer: "controller" | "test";
  private state:
    "idle" | "starting" | "recording" | "stopping" | "stopped" | "blocked" | "missing" = "idle";
  private recording = false;
  private reason?: string;
  private pending: Promise<unknown> = Promise.resolve();
  private pages = new Map<Page, (frame?: Frame) => void>();
  private guards = new Map<Page, () => void>();
  private onPage: (page: Page) => void;
  constructor(
    root: string,
    run: RunIdentity,
    context: BrowserContext,
    producer: "controller" | "test" = run.producer ?? "controller",
  ) {
    this.root = root;
    const { sessionId, runId, profileRunId, generation, createdAt, buildId, options } = run;
    this.run = {
      sessionId,
      runId,
      profileRunId,
      generation,
      createdAt,
      buildId,
      options: structuredClone(options),
    };
    this.context = context;
    this.producer = producer;
    this.onPage = (page) => this.watch(page);
  }
  summary() {
    return {
      status: this.state,
      ...(this.reason ? { reason: this.reason } : {}),
      historyComplete: false,
    };
  }
  private async settled() {
    let current: Promise<unknown>;
    do {
      current = this.pending;
      await current;
    } while (current !== this.pending);
  }
  private async artifact(
    status: "available" | "blocked" | "missing",
    reason?: string,
    name?: string,
  ) {
    try {
      await initializeEvidence(this.root, this.run, this.producer);
      await recordArtifact(this.root, this.run.runId, {
        kind: "trace",
        source: "dom",
        status,
        reason,
        name,
        ...(status === "available" ? { privacy: "safe-synthetic" } : {}),
      });
    } catch {
      this.state = "missing";
      this.reason = "TRACE_INDEX_FAILED";
    }
    return this.summary();
  }
  private watch(page: Page) {
    if (this.pages.has(page)) return;
    const check = (frame?: Frame) => {
      if (!trustedPage(page) || page.frames().length !== 1 || (frame && frame !== page.mainFrame()))
        void this.discard("SENSITIVE_CONTEXT");
    };
    this.pages.set(page, check);
    page.on("framenavigated", check);
    // 新窗口的来源尚不确定也不能先录制再猜测。
    check();
    this.pending = this.pending.then(async () => {
      if (this.reason) return;
      try {
        const detach = await watchSensitive(page, () => {
          void this.discard("SENSITIVE_CONTEXT");
        });
        if (this.reason) detach();
        else this.guards.set(page, detach);
      } catch {
        void this.discard("SENSITIVE_GUARD_UNAVAILABLE");
      }
    });
  }
  private detach() {
    this.context.off("page", this.onPage);
    for (const [page, listener] of this.pages) page.off("framenavigated", listener);
    this.pages.clear();
    for (const detach of this.guards.values()) detach();
    this.guards.clear();
  }
  async start(policy: TracePolicy = "sensitive") {
    if (this.state !== "idle") return this.summary();
    if (policy !== "safe-synthetic") {
      this.state = "blocked";
      this.reason = "SENSITIVE_CONTEXT";
      return this.artifact("blocked", this.reason);
    }
    this.state = "starting";
    this.context.on("page", this.onPage);
    this.context.pages().forEach(this.onPage);
    this.pending = this.pending.then(async () => {
      if (this.reason) return;
      try {
        await this.context.tracing.start({ snapshots: true, screenshots: true, sources: false });
        this.recording = true;
        this.state = this.reason ? "blocked" : "recording";
      } catch {
        try {
          await this.context.tracing.stop();
        } catch {
          /* 启动不完整时也不保存。 */
        }
        this.state = "missing";
        this.reason = "TRACE_START_FAILED";
        this.detach();
        await this.artifact("missing", this.reason);
      }
    });
    await this.settled();
    return this.summary();
  }
  async discard(reason = "SENSITIVE_INPUT") {
    if (this.reason || !["starting", "recording", "stopping"].includes(this.state)) {
      await this.pending;
      return this.summary();
    }
    this.reason = reason;
    this.state = "blocked";
    this.detach();
    this.pending = this.pending.then(async () => {
      // start 在事件到来时尚未完成，也须等待它结束后丢弃，绝不保存 ZIP。
      if (this.recording) {
        try {
          await this.context.tracing.stop();
        } catch {
          /* 已退出也不保存。 */
        }
        this.recording = false;
      }
      this.state = "blocked";
      await this.artifact("blocked", reason);
    });
    await this.pending;
    return this.summary();
  }
  async stop() {
    this.pending = this.pending.then(async () => {
      for (const [page, check] of this.pages) {
        check();
        if (!this.reason && (await sensitivePage(page).catch(() => true)))
          void this.discard("SENSITIVE_CONTEXT");
      }
      if (this.state !== "recording" || !this.recording) return this.summary();
      this.state = "stopping";
      return this.save();
    });
    await this.settled();
    return this.summary();
  }
  private async save() {
    let temporaryDirectory: string | undefined;
    try {
      temporaryDirectory = await mkdtemp(join(tmpdir(), "marshal-trace-save-"));
      const name = `trace-${randomUUID()}.zip`,
        temporary = join(temporaryDirectory, name);
      await this.context.tracing.stop({ path: temporary });
      this.recording = false;
      if (this.reason) {
        return this.artifact("blocked", this.reason);
      }
      const file = await open(temporary, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        if ((await file.stat()).size > 16 * 1024 * 1024)
          throw new ToolError(
            "TRACE_CAPACITY_LIMIT",
            "trace 超过单文件预算",
            "缩小录制范围",
            "blocked",
          );
        await writeEvidence(this.root, this.run.runId, name, await file.readFile());
      } finally {
        await file.close();
      }
      this.state = "stopped";
      this.detach();
      return this.artifact("available", undefined, name);
    } catch (error) {
      try {
        await this.context.tracing.stop();
      } catch {
        /* 收集失败后尽力停止，保留原失败。 */
      }
      this.recording = false;
      this.state = "missing";
      this.reason = error instanceof ToolError ? error.code : "TRACE_STOP_FAILED";
      this.detach();
      try {
        await recordFailure(this.root, this.run.runId, { kind: "collection", code: this.reason });
      } catch {
        /* 原失败不覆盖。 */
      }
      return this.artifact("missing", this.reason);
    } finally {
      if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
    }
  }
}
