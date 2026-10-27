import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, lstat, realpath, readdir, writeFile, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { CloudError } from "@media-marshal/contracts";
import { ExecutionUncertainError, executionContextSchema, executionHandleSchema, transferPlanSchema, transferSourceLeaseSchema, type ExecutionHandle, type PrivateTransferPlan, type TransferEngine, type TransferEvent } from "@media-marshal/contracts/internal";
import { ensurePrivateDirectory, ensurePrivateFile } from "../../main/cloud/private-files";
import type { ManagedGuardian, NativeExecution } from "../guardian";
import type { SourceCredentialBroker } from "../source-credentials";
import { RcloneLogParser, rcloneExitFailure } from "./logs";

// 与锁定 Rclone fs/config/obscure 格式兼容；这是可逆混淆，私有目录权限才是保存边界。
const obscureKey = Buffer.from("9c935b48730a554d6bfd7c63c886a92bd390198eb8128afbf4de162b8b95f638", "hex");
function obscure(value: string) { const iv = randomBytes(16), cipher = createCipheriv("aes-256-ctr", obscureKey, iv); return Buffer.concat([iv, cipher.update(value, "utf8"), cipher.final()]).toString("base64url"); }
class Events {
  private values: TransferEvent[] = [];
  private wake?: () => void;
  private closed = false;
  private observed = false;
  push(value: TransferEvent) {
    if (this.closed) return;
    if (value.type === "progress") this.values = this.values.filter((item) => item.type !== "progress");
    this.values.push(value); this.wake?.(); this.wake = undefined;
  }
  finish() { this.closed = true; this.wake?.(); this.wake = undefined; }
  async *read() {
    if (this.observed) throw new CloudError("CONFLICT"); this.observed = true;
    while (!this.closed || this.values.length) {
      if (this.values.length) yield this.values.shift()!;
      else await new Promise<void>((resolve) => { this.wake = resolve; });
    }
  }
}
interface Execution {
  handle: ExecutionHandle; accountId: string; signature: string; events: Events; native?: NativeExecution;
  done?: Promise<void>; state: "STARTING" | "RUNNING" | "EXITED" | "STOPPED" | "UNCERTAIN"; code: number | null;
}
type Transport = Pick<ManagedGuardian, "start" | "stop" | "shutdown" | "subscribe">;
export class RcloneCliEngine implements TransferEngine {
  readonly implementationId = "rclone.cli";
  readonly supportedSourceKinds = ["webdav"] as const;
  private attempts = new Map<string, Execution>();
  private active = new Set<string>();
  private retiring = false;
  constructor(private readonly guardian: Transport, private readonly credentials: SourceCredentialBroker, private readonly privateRoot: string) {}
  private checked(input: PrivateTransferPlan) {
    const plan = transferPlanSchema.parse(input.plan), context = executionContextSchema.parse(input.context);
    if (context.attemptId !== plan.attemptId || !isAbsolute(input.stagingDirectory) || input.stagingDirectory.includes("\0")) throw new CloudError("INVALID_REQUEST");
    const first = plan.items[0]!.source.binding;
    if (plan.items.some((item) => item.source.binding.generation !== context.bindingGeneration || item.source.binding.accountId !== first.accountId || item.source.binding.bindingId !== first.bindingId) || input.sources.length !== plan.items.length) throw new CloudError("INVALID_REQUEST");
    const sources = plan.items.map((item) => {
      const matches = input.sources.filter((source) => source.itemId === item.itemId);
      if (matches.length !== 1) throw new CloudError("INVALID_REQUEST");
      const lease = transferSourceLeaseSchema.parse(matches[0]!.lease);
      if (lease.file.remoteRef !== item.source.remoteRef || lease.generation !== context.bindingGeneration || (lease.expiresAt && Date.parse(lease.expiresAt) <= Date.now())) throw new CloudError("INTERRUPTED");
      const credential = this.credentials.read(lease.credentialHandle, context.bindingGeneration);
      if (/[\r\n\0]/.test(credential.username) || credential.username.trim() !== credential.username) throw new CloudError("UNSUPPORTED_CAPABILITY");
      return { item, lease, credential };
    });
    const initial = sources[0]!;
    if (sources.some((source) => source.lease.endpoint !== initial.lease.endpoint || source.lease.root !== initial.lease.root || source.credential.username !== initial.credential.username || source.credential.password !== initial.credential.password)) throw new CloudError("UNSUPPORTED_CAPABILITY");
    const prefix = initial.lease.file.segments.slice(0, initial.lease.file.segments.length - initial.item.targetSegments.length);
    if (sources.length > 1 && sources.some(({ lease, item }) => lease.file.segments.length !== prefix.length + item.targetSegments.length || prefix.some((part, index) => lease.file.segments[index] !== part) || item.targetSegments.some((part, index) => part !== lease.file.segments[prefix.length + index] || /[\r\n]/.test(part)))) throw new CloudError("UNSUPPORTED_CAPABILITY");
    if (new Set(plan.items.map((item) => JSON.stringify(item.targetSegments))).size !== plan.items.length) throw new CloudError("CONFLICT");
    return { plan, context, sources, prefix, staging: resolve(input.stagingDirectory) };
  }
  async start(input: PrivateTransferPlan): Promise<ExecutionHandle> {
    if (this.retiring) throw new CloudError("INTERRUPTED");
    const checked = this.checked(input), { plan, context, sources, staging } = checked;
    const signature = createHash("sha256").update(JSON.stringify({ plan, context, staging })).digest("hex"), previous = this.attempts.get(plan.attemptId);
    if (previous) { if (previous.signature !== signature) throw new CloudError("CONFLICT"); return { ...previous.handle }; }
    const accountId = plan.items[0]!.source.binding.accountId;
    if (this.active.has(accountId) || this.attempts.size >= 4096) throw new CloudError("CONFLICT");
    const handle = executionHandleSchema.parse({ executionId: input.executionId ?? randomUUID(), attemptId: plan.attemptId, hostGeneration: context.hostGeneration }), execution: Execution = { handle, accountId, signature, events: new Events(), state: "STARTING", code: null };
    this.active.add(accountId); this.attempts.set(plan.attemptId, execution);
    const configDirectory = join(this.privateRoot, handle.executionId), config = join(configDirectory, "rclone.conf");
    let started = false, unsubscribe: (() => void) | undefined;
    const parser = new RcloneLogParser((event) => execution.events.push(event));
    try {
      const info = await lstat(staging);
      if (!info.isDirectory() || info.isSymbolicLink() || await realpath(staging) !== staging || (await readdir(staging)).length) throw new CloudError("LOCAL_UNAVAILABLE");
      await ensurePrivateDirectory(this.privateRoot); await mkdir(configDirectory, { mode: 0o700 }); await ensurePrivateDirectory(configDirectory);
      const initial = sources[0]!, root = initial.lease.root.split("/").filter(Boolean), prefix = sources.length > 1 ? checked.prefix : [];
      const url = new URL(initial.lease.endpoint); url.pathname = url.pathname.replace(/\/$/, "") + "/" + [...root, ...prefix].map(encodeURIComponent).join("/") + (root.length + prefix.length ? "/" : "");
      await writeFile(config, `[source]\ntype = webdav\nurl = ${url.toString()}\nvendor = other\nuser = ${initial.credential.username}\npass = ${obscure(initial.credential.password)}\n`, { mode: 0o600, flag: "wx" }); await ensurePrivateFile(config);
      const args = [sources.length === 1 ? "copyto" : "copy", "--config", config, "--use-json-log", "--stats", "1s", "--stats-log-level", "INFO", "--log-level", "INFO", "--retries", "1", "--low-level-retries", "1", "--transfers", "2", "--checkers", "2", "--multi-thread-streams", "1"];
      if (sources.length > 1) {
        const fileList = join(configDirectory, "files.txt"); await writeFile(fileList, sources.map(({ item }) => item.targetSegments.join("/")).join("\n") + "\n", { mode: 0o600, flag: "wx" }); await ensurePrivateFile(fileList);
        args.push("--files-from-raw", fileList, "--", "source:", staging);
      } else {
        const item = sources[0]!.item; const target = join(staging, ...item.targetSegments);
        if (process.platform === "win32" && item.targetSegments.some((part) => /[\\:]/.test(part))) throw new CloudError("LOCAL_UNAVAILABLE");
        args.push("--", "source:" + sources[0]!.lease.file.segments.join("/"), target);
      }
      if (args.some((argument) => argument.includes("\0") || Buffer.byteLength(argument) > 4096)) throw new CloudError("UNSUPPORTED_CAPABILITY");
      unsubscribe = this.guardian.subscribe((event) => { if (event.type === "stderr" && event.executionId === handle.executionId) parser.feed(event.data); });
      if (this.retiring) throw new CloudError("INTERRUPTED");
      started = true;
      const native = await this.guardian.start("rclone", handle.executionId, args);
      execution.native = native; execution.state = "RUNNING";
      execution.done = native.exited.then(async (result) => {
        parser.finish(); unsubscribe?.();
        execution.state = result.stopped ? "STOPPED" : "EXITED"; execution.code = result.code;
        const failure = rcloneExitFailure(result.code, result.stopped); if (failure) execution.events.push({ type: "failure", failure });
        try { await rm(configDirectory, { recursive: true, force: true }); }
        catch { execution.events.push({ type: "failure", failure: rcloneExitFailure(1, false)! }); }
        finally { this.active.delete(accountId); execution.events.push({ type: "exited", exitCode: result.code, stopped: result.stopped }); execution.events.finish(); }
      });
      return { ...handle };
    } catch (error) {
      unsubscribe?.();
      if (started) {
        execution.state = "UNCERTAIN";
        try { await this.guardian.shutdown(); execution.state = "STOPPED"; execution.code = -1; execution.done = Promise.resolve(); }
        catch { this.retiring = true; throw new ExecutionUncertainError(); }
      }
      await rm(configDirectory, { recursive: true, force: true }); this.active.delete(accountId);
      execution.events.finish();
      if (!started) this.attempts.delete(plan.attemptId);
      throw error;
    }
  }
  private execution(handle: ExecutionHandle) {
    const parsed = executionHandleSchema.parse(handle), value = this.attempts.get(parsed.attemptId);
    if (!value || value.handle.executionId !== parsed.executionId || value.handle.hostGeneration !== parsed.hostGeneration) throw new CloudError("INTERRUPTED");
    return value;
  }
  async stop(handle: ExecutionHandle): Promise<{ stopped: true }> {
    const value = this.execution(handle);
    if (value.state === "UNCERTAIN") throw new ExecutionUncertainError();
    if (value.state === "STOPPED") { await value.done; return { stopped: true }; }
    if (!value.native) throw new CloudError("CONFLICT");
    if (value.state === "RUNNING") {
      try { await this.guardian.stop(value.handle.executionId); }
      catch { value.state = "UNCERTAIN"; this.retiring = true; throw new ExecutionUncertainError(); }
    }
    await value.done; return { stopped: true };
  }
  events(handle: ExecutionHandle): AsyncIterable<TransferEvent> { return this.execution(handle).events.read(); }
  status(attemptId: string) { const value = this.attempts.get(attemptId); return value ? { handle: { ...value.handle }, state: value.state, exitCode: value.code } : null; }
  async stopAccount(accountId: string) { for (const value of this.attempts.values()) if (value.accountId === accountId && ["STARTING", "RUNNING", "UNCERTAIN"].includes(value.state)) await this.stop(value.handle); }
  async dispose() { this.retiring = true; for (const value of this.attempts.values()) if (value.state === "RUNNING") await this.stop(value.handle); }
}
