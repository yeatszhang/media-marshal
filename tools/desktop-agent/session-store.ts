import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { z } from "zod";
import { atomicJson } from "./build.ts";
import { ToolError, type Input } from "./protocol.ts";
import { sameProcess } from "./process.ts";

const identity = z.strictObject({
  pid: z.number().int().positive(),
  parent: z.number(),
  created: z.string(),
  command: z.string(),
});
export const sessionSchema = z.strictObject({
  sessionId: z.uuid(),
  runId: z.uuid(),
  profileRunId: z.uuid(),
  generation: z.number().int().positive(),
  status: z.enum([
    "starting",
    "running",
    "restarting",
    "stopping",
    "stopped",
    "failed",
    "crashed",
    "unknown",
  ]),
  options: z.strictObject({
    mode: z.enum(["background", "foreground"]),
    target: z.enum(["development", "packaged"]),
    scenario: z.literal("empty"),
    seed: z.string(),
  }),
  socket: z.string(),
  token: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  owner: identity.optional(),
  application: identity.optional(),
  buildId: z.string().optional(),
  error: z.unknown().optional(),
});
export type Session = z.infer<typeof sessionSchema>;
export const sessionsHome = (root: string) => join(root, "test-results/agent/sessions");
export const sessionPath = (root: string, id: string) =>
  join(sessionsHome(root), z.uuid().parse(id) + ".json");
export const runHome = (root: string, runId: string) =>
  join(root, "test-results/agent", z.uuid().parse(runId));
export async function saveSession(root: string, session: Session) {
  session.updatedAt = new Date().toISOString();
  await atomicJson(sessionPath(root, session.sessionId), session);
}
export async function readSession(root: string, id: string) {
  try {
    return sessionSchema.parse(JSON.parse(await readFile(sessionPath(root, id), "utf8")));
  } catch {
    throw new ToolError(
      "SESSION_UNKNOWN",
      "会话记录不存在或身份无效",
      "确认会话 ID；不要连接个人实例",
      "unknown",
    );
  }
}
export function publicSession(session: Session) {
  const { token: _token, socket: _socket, ...publicValue } = session;
  return publicValue;
}
export function inspectSession(session: Session, probe = sameProcess): Session {
  if (["stopped", "failed", "crashed"].includes(session.status)) return session;
  if (!session.owner) {
    if (Date.now() - Date.parse(session.createdAt) < 20000) return session;
    return {
      ...session,
      status: "unknown",
      error: { code: "CONTROLLER_UNKNOWN", message: "无法核实会话控制进程" },
    };
  }
  if (!probe(session.owner))
    return {
      ...session,
      status: "unknown",
      error: {
        code: "CONTROLLER_LOST",
        message: "原控制进程已退出或身份变化；保留证据，不能接管同 PID 进程",
      },
    };
  if (session.status === "running" && (!session.application || !probe(session.application)))
    return {
      ...session,
      status: "crashed",
      error: { code: "APPLICATION_LOST", message: "原应用进程已退出或身份变化" },
    };
  return session;
}
export async function newSession(root: string, options: Input<"start">): Promise<Session> {
  if (options.scenario !== "empty")
    throw new ToolError(
      "SCENARIO_UNAVAILABLE",
      "场景尚未接入",
      "当前仅可使用 empty；场景按任务 2.7 实施",
      "blocked",
    );
  const sessionId = randomUUID(),
    stamp = new Date().toISOString();
  const socketName =
    "mm-agent-" +
    createHash("sha256")
      .update(root + sessionId)
      .digest("hex")
      .slice(0, 24);
  await mkdir(sessionsHome(root), { recursive: true, mode: 0o700 });
  const session: Session = {
    sessionId,
    runId: randomUUID(),
    profileRunId: randomUUID(),
    generation: 1,
    status: "starting",
    options: { ...options, scenario: "empty" },
    socket:
      process.platform === "win32"
        ? `\\\\.\\pipe\\${socketName}`
        : join(process.platform === "darwin" ? "/tmp" : tmpdir(), socketName + ".sock"),
    token: randomBytes(32).toString("hex"),
    createdAt: stamp,
    updatedAt: stamp,
  };
  session.profileRunId = session.runId;
  await mkdir(runHome(root, session.runId), { recursive: true, mode: 0o700 });
  await saveSession(root, session);
  return session;
}
