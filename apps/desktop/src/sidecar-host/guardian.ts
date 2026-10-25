import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { CloudError } from "@media-marshal/contracts";
import type { BinaryName } from "./binary-resolver";

const uuid = z.uuid();
const eventSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ready") }),
  z.strictObject({ kind: z.literal("started"), requestId: uuid, executionId: uuid, program: z.enum(["openlist", "rclone"]), pid: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("exited"), executionId: uuid, code: z.number().int() }),
  z.strictObject({ kind: z.literal("stderr"), executionId: uuid, encoding: z.literal("base64"), data: z.string().max(24 * 1024) }),
  z.strictObject({ kind: z.literal("stopped"), requestId: uuid, executionId: uuid }),
  z.strictObject({ kind: z.literal("stopped-all"), requestId: uuid }),
  z.strictObject({ kind: z.literal("error"), requestId: uuid, code: z.literal("INVALID_EXECUTION") }),
]);
export interface NativeExit { code: number; stopped: boolean }
export interface NativeExecution {
  id: string; program: "openlist" | "rclone"; pid?: number; running: boolean;
  exited: Promise<NativeExit>;
}
interface Entry extends NativeExecution { resolve: (exit: NativeExit) => void; stopRequested: boolean }
interface Pending { resolve: (event: z.infer<typeof eventSchema>) => void; reject: (error: unknown) => void; deadline: ReturnType<typeof setTimeout> }
export type NativeObservation = { type: "started"; program: BinaryName; executionId: string; pid: number } | { type: "exited"; executionId: string; code: number } | { type: "stderr"; executionId: string; data: Buffer } | { type: "lost" };

export class ManagedGuardian {
  private listeners = new Set<(event: NativeObservation) => void>();
  subscribe(listener: (event: NativeObservation) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private publish(event: NativeObservation) { this.observe(event); for (const listener of this.listeners) listener(event); }
  private child?: ChildProcessWithoutNullStreams;
  private entries = new Map<string, Entry>();
  private pending = new Map<string, Pending>();
  private heartbeat?: ReturnType<typeof setInterval>;
  private exited?: Promise<void>;
  private closing = false;
  private healthy = false;
  private launching?: Promise<void>;
  private guardianId = randomUUID();
  constructor(readonly root: string, private readonly binaries: Readonly<Record<BinaryName, string>>, private readonly observe: (event: NativeObservation) => void = () => {}) {}
  launch(): Promise<void> {
    if (this.launching) return this.launching;
    this.launching = this.spawn(); return this.launching;
  }
  private async spawn() {
    const allowed = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SYSTEMROOT", "WINDIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"];
    const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.includes(key.toUpperCase())));
    environment.NO_PROXY = "127.0.0.1,localhost";
    const child = spawn(this.binaries.guardian, [`--runtime-root=${this.root}`], { cwd: this.root, env: environment, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stderr.on("data", () => {});
    let readyResolve!: () => void, readyReject!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const deadline = setTimeout(() => { readyReject(new CloudError("TIMEOUT")); child.stdin.end(); }, 8000);
    let buffer = "";
    const badProtocol = () => { this.healthy = false; readyReject(new CloudError("COMPONENT_UNAVAILABLE")); child.stdin.end(); };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      buffer += data;
      if (Buffer.byteLength(buffer) > 256 * 1024) { buffer = ""; badProtocol(); return; }
      while (buffer.includes("\n")) {
        const end = buffer.indexOf("\n"), line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const event = eventSchema.parse(JSON.parse(line));
          if (event.kind === "ready") { this.healthy = true; clearTimeout(deadline); readyResolve(); }
          else if (event.kind === "started") {
            const entry = this.entries.get(event.executionId);
            if (!entry || entry.program !== event.program) { badProtocol(); return; }
            entry.pid = event.pid; entry.running = true;
            this.publish({ type: "started", executionId: event.executionId, pid: event.pid, program: event.program });
          } else if (event.kind === "exited") {
            const entry = this.entries.get(event.executionId);
            if (entry) { entry.running = false; entry.resolve({ code: event.code, stopped: entry.stopRequested }); }
            this.publish({ type: "exited", executionId: event.executionId, code: event.code });
          } else if (event.kind === "stderr") this.publish({ type: "stderr", executionId: event.executionId, data: Buffer.from(event.data, "base64") });
          if ("requestId" in event) {
            const pending = this.pending.get(event.requestId);
            if (pending) { clearTimeout(pending.deadline); this.pending.delete(event.requestId); if (event.kind === "error") pending.reject(new CloudError("COMPONENT_UNAVAILABLE")); else pending.resolve(event); }
          }
        } catch { badProtocol(); return; }
      }
    });
    child.stdin.on("error", () => { this.healthy = false; });
    child.once("error", () => { clearTimeout(deadline); readyReject(new CloudError("COMPONENT_UNAVAILABLE")); });
    this.exited = new Promise<void>((resolve) => child.once("close", (code) => {
      clearTimeout(deadline); clearInterval(this.heartbeat); this.healthy = false;
      readyReject(new CloudError("COMPONENT_UNAVAILABLE"));
      for (const pending of this.pending.values()) { clearTimeout(pending.deadline); pending.reject(new CloudError("COMPONENT_UNAVAILABLE")); }
      this.pending.clear();
      this.publish({ type: "exited", executionId: this.guardianId, code: code ?? -1 });
      if (!this.closing) this.publish({ type: "lost" }); resolve();
    }));
    child.once("spawn", () => {
      this.publish({ type: "started", executionId: this.guardianId, pid: child.pid!, program: "guardian" });
      child.stdin.write(JSON.stringify({ root: this.root, native: { openlist: this.binaries.openlist, rclone: this.binaries.rclone } }) + "\n");
      this.heartbeat = setInterval(() => { if (!child.stdin.destroyed) child.stdin.write('{"type":"heartbeat"}\n'); }, 250);
    });
    await ready;
  }
  private request(type: string, payload: object = {}) {
    if (!this.child || !this.healthy || this.pending.size >= 64) return Promise.reject(new CloudError("COMPONENT_UNAVAILABLE"));
    const requestId = randomUUID();
    return new Promise<z.infer<typeof eventSchema>>((resolve, reject) => {
      const deadline = setTimeout(() => { this.pending.delete(requestId); this.healthy = false; reject(new CloudError("TIMEOUT")); this.child?.stdin.end(); }, 8000);
      this.pending.set(requestId, { resolve, reject, deadline });
      this.child!.stdin.write(JSON.stringify({ type, requestId, ...payload }) + "\n");
    });
  }
  async start(program: "openlist" | "rclone", id: string, args: readonly string[], environment: Record<string, string> = {}): Promise<NativeExecution> {
    if (this.closing || this.entries.has(id) || !uuid.safeParse(id).success) throw new CloudError("CONFLICT");
    await this.launch();
    if (this.closing || this.entries.has(id)) throw new CloudError("CONFLICT");
    let resolve!: (value: NativeExit) => void;
    const exited = new Promise<NativeExit>((done) => { resolve = done; });
    const entry: Entry = { id, program, running: false, exited, resolve, stopRequested: false };
    this.entries.set(id, entry);
    try {
      const event = await this.request("start", { executionId: id, program, args, environment });
      if (event.kind !== "started") throw new CloudError("COMPONENT_UNAVAILABLE");
      return entry;
    } catch (error) {
      if (this.healthy) { this.entries.delete(id); resolve({ code: -1, stopped: true }); }
      throw error;
    }
  }
  async stop(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new CloudError("CONFLICT");
    entry.stopRequested = true;
    const event = await this.request("stop", { executionId: id });
    if (event.kind !== "stopped") throw new CloudError("COMPONENT_UNAVAILABLE");
    entry.running = false; entry.resolve({ code: -1, stopped: true });
  }
  async shutdown(): Promise<void> {
    this.closing = true;
    if (!this.child) return;
    for (const entry of this.entries.values()) entry.stopRequested = true;
    let confirmed = false;
    try {
      if (this.healthy) confirmed = (await this.request("stop-all")).kind === "stopped-all";
    } finally { clearInterval(this.heartbeat); this.child.stdin.end(); }
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([this.exited, new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new CloudError("TIMEOUT")), 5000); })]);
    } finally { clearTimeout(deadline); }
    if (!confirmed && this.entries.size) throw new CloudError("COMPONENT_UNAVAILABLE");
    for (const entry of this.entries.values()) { entry.running = false; entry.resolve({ code: -1, stopped: true }); }
  }
}
