import assert from "node:assert/strict";
import { captureJson } from "./evidence-capture.ts";
import { recordFailure } from "./evidence-artifacts.ts";
import { updateEvidence } from "./evidence-store.ts";
import { nativeTarget, invokeNative, type NativeRequest } from "./native-runtime.ts";
import { observeNative, type NativeSnapshot } from "./native-snapshot.ts";
import { guiRoot, type setupGui } from "./gui-test-support.ts";
type Context = Awaited<ReturnType<typeof setupGui>>;
type Node = NativeSnapshot["nodes"][number];
export async function untilNative<T>(read: () => Promise<T>, accepted: (value: T) => boolean) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await read();
    if (accepted(value)) return value;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("原生动作后置条件没有成立");
}
/** 受版本管理的原生测试驱动，不暴露为 Renderer 或任意 CLI 操作入口。 */
export class NativeProbe {
  readonly context: Context;
  readonly identity: NativeRequest;
  constructor(context: Context, identity: NativeRequest) {
    this.context = context;
    this.identity = identity;
  }
  static async create(context: Context) {
    const identity = await nativeTarget(guiRoot, context.session, context.gui.windows);
    return new NativeProbe(context, { ...identity, command: "observe" });
  }
  async record(kind: "aria" | "action" | "assertion", value: unknown) {
    const result = await captureJson(
      guiRoot,
      this.context.session,
      { kind, source: "native" },
      value,
    );
    assert.equal(result.status, "indexed", JSON.stringify(result));
  }
  async observe() {
    const value = await observeNative(guiRoot, this.identity);
    await this.record("aria", { source: "native", ...value });
    return value;
  }
  async send(
    command: NativeRequest["command"],
    selector?: (node: Node) => boolean,
    input: Partial<NativeRequest> = {},
  ) {
    const before = await this.observe();
    let selected = selector ? before.nodes.filter(selector) : [];
    const sheets = before.nodes.filter((node) => node.role === "AXSheet");
    if (selector && sheets.length)
      selected = selected.filter((node) =>
        sheets.some(
          (sheet) =>
            sheet.path.length < node.path.length &&
            sheet.path.every((value, index) => value === node.path[index]),
        ),
      );
    if (selector) assert.equal(selected.length, 1, JSON.stringify(selected));
    const request = {
      ...this.identity,
      ...input,
      command,
      fingerprint: before.fingerprint,
      ...(selector ? { path: selected[0]!.path } : {}),
    };
    try {
      const result = await invokeNative(guiRoot, request);
      assert.equal(result.status, "sent");
      await this.record("action", {
        source: "native",
        command,
        fingerprint: before.fingerprint,
        path: request.path,
        status: "sent",
        requiresPostcondition: true,
      });
    } catch (error) {
      await this.record("action", {
        source: "native",
        command,
        fingerprint: before.fingerprint,
        status: "rejected-or-unknown",
        reason: (error as { code?: string }).code ?? "NATIVE_RESULT_UNKNOWN",
      });
      throw error;
    }
  }
  async frontmost() {
    return untilNative(
      () => invokeNative(guiRoot, { ...this.identity, command: "window-state" }),
      (value) => value.frontmost === true && value.sessionLocked === false,
    );
  }
  async finish(error?: unknown) {
    if (error)
      await recordFailure(guiRoot, this.context.session.runId, {
        kind: "assertion",
        code: "NATIVE_ASSERTION_FAILED",
      });
    await this.record("assertion", {
      source: "native",
      status: error ? "failed" : "passed",
      screenshots: "not-requested",
      realAccounts: false,
    });
    await updateEvidence(guiRoot, this.context.session.runId, (value) => {
      value.assertions = error ? "failed" : "passed";
    });
    console.log(
      JSON.stringify({
        source: "native",
        runId: this.context.session.runId,
        status: error ? "failed" : "passed",
      }),
    );
  }
}
