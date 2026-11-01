import { ToolError, failure, type Request, type Input } from "./protocol.ts";
import type { Session } from "./session-store.ts";
import { assertBuild } from "./build.ts";
import type { GuiObserver } from "./gui-observe.ts";
import {
  actionPath,
  actionSignature,
  previousAction,
  reserveAction,
  saveAction,
  type ActionReceipt,
} from "./action-store.ts";
import { validateInput, sendInput } from "./gui-input.ts";
import { validateCondition, waitCondition } from "./gui-condition.ts";
import { uniqueTarget } from "./gui-target.ts";
import { executeCoordinate } from "./gui-coordinates.ts";
import { observeAfter } from "./gui-after.ts";
import { captureJson } from "./evidence-capture.ts";
import { recordActionReceipt } from "./evidence-actions.ts";
export class GuiActions {
  busy = false;
  private root: string;
  private session: Session;
  private observer: GuiObserver;
  constructor(root: string, session: Session, observer: GuiObserver) {
    this.root = root;
    this.session = session;
    this.observer = observer;
  }
  async start(request: Request) {
    const path = await actionPath(this.root, this.session, request.requestId);
    const signature = actionSignature(this.session, request);
    const previous = await previousAction(path, signature);
    if (previous) return previous;
    if (this.busy)
      throw new ToolError(
        "GUI_ACTION_BUSY",
        "原动作尚未结束",
        "查询原 jobId；不并发确认",
        "blocked",
      );
    const input = request.payload as Input<"act">;
    validateInput(input);
    if (input.after) validateCondition(input.after);
    const receipt: ActionReceipt = {
      jobId: request.requestId,
      requestId: request.requestId,
      sessionId: this.session.sessionId,
      runId: this.session.runId,
      buildId: this.session.buildId,
      snapshotId: input.snapshotId,
      ...(input.imageId ? { imageId: input.imageId } : {}),
      action: input.action,
      status: "unknown",
      inputStatus: "not-sent",
      inputValueRecorded: false,
    };
    await reserveAction(path, signature, receipt);
    this.busy = true;
    receipt.status = "running";
    try {
      await saveAction(path, signature, receipt);
    } catch {
      this.busy = false;
      throw new ToolError(
        "ACTION_RESULT_UNKNOWN",
        "动作受理记录未确认写入",
        "查询原请求，不自动重放",
        "unknown",
      );
    }
    const persist = () => saveAction(path, signature, receipt);
    await this.evidence(receipt);
    void this.execute(input, receipt, persist)
      .catch((error) => {
        receipt.status =
          receipt.inputStatus === "not-sent"
            ? error instanceof ToolError
              ? error.state
              : "failed"
            : "unknown";
        receipt.error = failure(error).error;
        if (receipt.inputStatus === "sending") receipt.inputStatus = "unknown";
      })
      .then(async () => {
        if (input.position)
          receipt.result = {
            ...(receipt.result && typeof receipt.result === "object" ? receipt.result : {}),
            afterObservation: await observeAfter(this.observer, input.windowId),
          };
        await this.evidence(receipt);
        await saveAction(path, signature, receipt);
      })
      .catch(() => {
        /* 持久化失败保留原 running／unknown，不能重新执行。 */
      })
      .finally(() => {
        this.busy = false;
      });
    return { ...receipt };
  }
  private async evidence(receipt: ActionReceipt) {
    receipt.evidence = await captureJson(
      this.root,
      this.session,
      {
        kind: "action",
        source: "dom",
        requestId: receipt.requestId,
        snapshotId: receipt.snapshotId,
      },
      receipt,
    );
    const actions = await recordActionReceipt(this.root, receipt);
    if (actions.status === "missing") receipt.evidence = actions;
  }
  private async execute(input: Input<"act">, receipt: ActionReceipt, persist: () => Promise<void>) {
    const build = await assertBuild(this.root, this.session.options.target);
    if (build.buildId !== this.session.buildId)
      throw new ToolError(
        "SESSION_BUILD_STALE",
        "运行实例仍属于旧构建",
        "先安全重启，再重新观察；不能用新构建清单为旧实例验收",
        "blocked",
      );
    const handle = await this.observer.current(input.snapshotId, input.windowId);
    if (input.position) {
      await executeCoordinate(
        { root: this.root, session: this.session, observer: this.observer, handle, input },
        receipt,
        persist,
      );
      return;
    }
    const target = await uniqueTarget(handle, input, input.action !== "scroll");
    if (
      input.action === "scroll" &&
      input.targetRef &&
      !handle.snapshot.nodes.find((n) => n.ref === input.targetRef)?.name?.trim()
    )
      throw new ToolError(
        "GUI_TARGET_NOT_ACTIONABLE",
        "滚动目标没有可核验名称",
        "选择已命名区域",
        "blocked",
      );
    if (input.action === "click") await target.click({ trial: true, timeout: input.timeoutMs });
    await this.observer.current(input.snapshotId, input.windowId);
    receipt.inputStatus = "sending";
    await persist();
    await this.observer.current(input.snapshotId, input.windowId);
    await sendInput(target, input);
    receipt.inputStatus = "sent";
    await persist();
    const condition = input.after
      ? await waitCondition(this.observer, handle, input.after, input.timeoutMs)
      : { status: "not-requested" };
    let afterObservation: unknown;
    try {
      afterObservation = {
        status: "available",
        snapshotId: (await this.observer.capture(handle.snapshot.window.windowId)).snapshot
          .snapshotId,
      };
    } catch {
      afterObservation = { status: "missing" };
    }
    receipt.status = "completed";
    receipt.result = { input: "sent", condition, businessAssertion: "not-run", afterObservation };
  }
  async wait(input: Input<"wait">) {
    if (this.busy)
      throw new ToolError("GUI_ACTION_BUSY", "原动作尚未结束", "先查询原动作收据", "blocked");
    const handle = await this.observer.current(input.snapshotId, input.windowId);
    return waitCondition(this.observer, handle, input, input.timeoutMs);
  }
}
