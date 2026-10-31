import { connect, createServer, type Socket, type Server } from "node:net";
import { chmod } from "node:fs/promises";
import { timingSafeEqual } from "node:crypto";
import { failure, parseRequest, ToolError, type Request } from "./protocol.ts";
import type { Session } from "./session-store.ts";

function readLine(socket: Socket, limit: number, consume: (line: string) => void) {
  let bytes = Buffer.alloc(0),
    finished = false;
  socket.on("data", (part: Buffer) => {
    if (finished) return;
    bytes = Buffer.concat([bytes, part]);
    if (bytes.length > limit) {
      finished = true;
      socket.destroy();
      return;
    }
    const end = bytes.indexOf(10);
    if (end >= 0) {
      finished = true;
      consume(bytes.subarray(0, end).toString("utf8"));
    }
  });
}
const unavailable = () =>
  new ToolError(
    "CONTROLLER_UNREACHABLE",
    "控制连接中断，操作结果未知",
    "查询原会话和请求记录，不自动重发写操作",
    "unknown",
  );
export async function callController(session: Session, request: Request): Promise<unknown> {
  return new Promise((done, reject) => {
    const socket = connect(session.socket);
    let answered = false;
    const finish = (error?: unknown, value?: unknown) => {
      if (answered) return;
      answered = true;
      socket.destroy();
      error ? reject(error) : done(value);
    };
    socket.setTimeout(12000, () => finish(unavailable()));
    socket.on("error", () => finish(unavailable()));
    socket.on("close", () => {
      if (!answered) finish(unavailable());
    });
    socket.on("connect", () =>
      socket.write(JSON.stringify({ token: session.token, request }) + "\n"),
    );
    readLine(socket, 1024 * 1024, (line) => {
      try {
        const value = JSON.parse(line);
        if (value.error)
          return finish(
            new ToolError(value.error.code, value.error.message, value.error.repair, value.status),
          );
        finish(undefined, value.result);
      } catch {
        finish(unavailable());
      }
    });
  });
}
function authorized(actual: unknown, expected: string) {
  if (typeof actual !== "string") return false;
  const a = Buffer.from(actual),
    b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export async function serveController(
  session: Session,
  dispatch: (request: Request) => Promise<unknown>,
): Promise<Server> {
  const server = createServer((socket) => {
    socket.setTimeout(15000, () => socket.destroy());
    socket.on("error", () => {});
    readLine(socket, 65536, (line) => {
      void (async () => {
        const envelope = JSON.parse(line);
        if (!authorized(envelope.token, session.token))
          throw new ToolError("UNAUTHORIZED", "控制连接身份不符", "通过本会话记录连接");
        const request = parseRequest(envelope.request);
        if (request.sessionId !== session.sessionId)
          throw new ToolError("SESSION_MISMATCH", "请求不属于本控制会话", "核对会话身份");
        return { result: await dispatch(request) };
      })()
        .catch((error) => failure(error))
        .then((value) => {
          if (!socket.destroyed) socket.end(JSON.stringify(value) + "\n");
        });
    });
  });
  await new Promise<void>((done, reject) => {
    server.once("error", reject);
    server.listen(session.socket, done);
  });
  if (process.platform !== "win32") await chmod(session.socket, 0o600);
  return server;
}
