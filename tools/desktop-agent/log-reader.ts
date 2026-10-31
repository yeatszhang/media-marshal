import { open, readdir, lstat, constants, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { agentFile } from "./paths.ts";
import { readSession, runHome, type Session } from "./session-store.ts";
import { type Input, ToolError } from "./protocol.ts";
import { matchesLog, projectLog } from "./log-record.ts";
import {
  encodeCursor,
  decodeCursor,
  filterIdentity,
  prefixDigest,
  type Cursor,
} from "./log-cursor.ts";
const SCAN_BUDGET = 2 * 1024 * 1024,
  OUTPUT_BUDGET = 192 * 1024;
interface LogFile {
  path: string;
  id: string;
  size: number;
}
interface Scan {
  records: Record<string, unknown>[];
  bytes: number;
  outputBytes: number;
  invalidLines: number;
  reasons: Set<string>;
  more: boolean;
  cursor?: Cursor;
  tail?: boolean;
}
async function logFiles(root: string, session: Session): Promise<LogFile[]> {
  const directory = join(runHome(root, session.profileRunId), "data/logs");
  await agentFile(root, directory);
  const names = (await readdir(directory))
    .filter((name) => /^desktop\.log(?:\.[1-5])?$/.test(name))
    .sort((a, b) => Number(b.split(".")[2] ?? 0) - Number(a.split(".")[2] ?? 0));
  return Promise.all(
    names.map(async (name) => {
      const path = join(directory, name),
        info = await lstat(await agentFile(root, path));
      if (!info.isFile())
        throw new ToolError(
          "LOG_FILE_REJECTED",
          "日志目标不是普通文件",
          "核对自有日志目录",
          "blocked",
        );
      return { path, id: `${info.dev}:${info.ino}`, size: info.size };
    }),
  );
}
async function prefix(file: FileHandle, length: number) {
  const bytes = Buffer.alloc(length),
    read = await file.read(bytes, 0, length, 0);
  return prefixDigest(bytes.subarray(0, read.bytesRead));
}
function appendLine(bytes: Buffer, session: Session, input: Input<"logs">, scan: Scan) {
  if (!bytes.length) return true;
  if (bytes.length > 65536) {
    scan.invalidLines++;
    scan.reasons.add("OVERSIZED_LINE");
    return true;
  }
  try {
    const row = JSON.parse(bytes.toString("utf8"));
    if (!row || typeof row !== "object" || Array.isArray(row)) throw new Error();
    if (row.event === "logging.dropped") scan.reasons.add("REPORTED_DROPS");
    if (!matchesLog(row, session.sessionId, input)) return true;
    const record = projectLog(row),
      size = Buffer.byteLength(JSON.stringify(record));
    if (!scan.tail && scan.outputBytes + size > OUTPUT_BUDGET) {
      scan.more = true;
      return false;
    }
    scan.records.push(record);
    scan.outputBytes += size;
    if (scan.tail)
      while (scan.records.length > input.limit || scan.outputBytes > OUTPUT_BUDGET) {
        scan.outputBytes -= Buffer.byteLength(JSON.stringify(scan.records.shift()));
      }
  } catch {
    scan.invalidLines++;
    scan.reasons.add("INVALID_LINE");
  }
  return true;
}
async function scanFile(
  file: FileHandle,
  entry: LogFile,
  session: Session,
  input: Input<"logs">,
  scan: Scan,
  cursor?: Cursor,
) {
  let position = cursor?.p ?? 0;
  const length = Math.min(SCAN_BUDGET - scan.bytes, Math.max(0, entry.size - position));
  const n = cursor?.n ?? Math.min(256, entry.size),
    a = await prefix(file, n);
  const state: Cursor = { f: entry.id, p: position, h: filterIdentity(input), n, a, d: cursor?.d };
  const buffer = Buffer.alloc(length),
    { bytesRead } = await file.read(buffer, 0, length, position);
  scan.bytes += bytesRead;
  let start = 0;
  while (start < bytesRead) {
    const end = buffer.indexOf(10, start);
    if (end < 0) {
      if (bytesRead - start > 65536) {
        state.p += bytesRead - start;
        state.d = true;
        scan.invalidLines++;
        scan.reasons.add("OVERSIZED_LINE");
      } else scan.reasons.add("PARTIAL_TAIL");
      break;
    }
    if (!state.d && !appendLine(buffer.subarray(start, end), session, input, scan)) break;
    state.d = undefined;
    state.p += end - start + 1;
    start = end + 1;
    if (!scan.tail && scan.records.length >= input.limit) {
      scan.more = state.p < entry.size;
      break;
    }
  }
  scan.cursor = state;
  if (state.p < entry.size && scan.bytes >= SCAN_BUDGET) {
    scan.more = true;
    scan.reasons.add("SCAN_BUDGET");
  }
}
async function continueFrom(files: LogFile[], cursor: Cursor | undefined, scan: Scan) {
  if (!cursor) return 0;
  const index = files.findIndex((file) => file.id === cursor.f);
  if (index < 0 || files[index]!.size < cursor.p) {
    scan.reasons.add("CURSOR_HISTORY_GAP");
    return 0;
  }
  const file = await open(files[index]!.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if ((await prefix(file, cursor.n)) !== cursor.a) {
      scan.reasons.add("CURSOR_HISTORY_GAP");
      return 0;
    }
  } finally {
    await file.close();
  }
  return index;
}
export async function readLogs(root: string, sessionId: string, input: Input<"logs">) {
  const session = await readSession(root, sessionId),
    filter = filterIdentity(input);
  const cursor = input.cursor ? decodeCursor(input.cursor, session.token, filter) : undefined;
  const scan: Scan = {
    records: [],
    bytes: 0,
    outputBytes: 0,
    invalidLines: 0,
    reasons: new Set(),
    more: false,
  };
  let files: LogFile[];
  try {
    files = await logFiles(root, session);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    return {
      records: [],
      hasMore: false,
      integrity: { historyComplete: false, reasons: ["LOG_UNAVAILABLE"] },
    };
  }
  const first = await continueFrom(files, cursor, scan);
  for (let index = first; index < files.length; index++) {
    const entry = files[index]!,
      file = await open(entry.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const info = await file.stat();
      if (`${info.dev}:${info.ino}` !== entry.id) {
        scan.reasons.add("ROTATED_DURING_READ");
        break;
      }
      await scanFile(
        file,
        entry,
        session,
        input,
        scan,
        index === first && !scan.reasons.has("CURSOR_HISTORY_GAP") ? cursor : undefined,
      );
    } finally {
      await file.close();
    }
    if (scan.more || scan.records.length >= input.limit || scan.bytes >= SCAN_BUDGET) {
      scan.more ||= index < files.length - 1;
      break;
    }
  }
  return {
    records: scan.records,
    cursor: scan.cursor ? encodeCursor(scan.cursor, session.token) : undefined,
    hasMore: scan.more,
    integrity: {
      historyComplete: false,
      coverage: "available-files",
      scannedBytes: scan.bytes,
      invalidLines: scan.invalidLines,
      reasons: [...scan.reasons],
    },
  };
}

/** 只读诊断取可用历史尾部，保留窗口和缺口，不把旧的首屏警告称为最近失败。 */
export async function recentLogs(root: string, sessionId: string, input: Input<"logs">) {
  const session = await readSession(root, sessionId);
  const scan: Scan = {
    records: [],
    bytes: 0,
    outputBytes: 0,
    invalidLines: 0,
    reasons: new Set(["BOUNDED_TAIL"]),
    more: false,
    tail: true,
  };
  let files: LogFile[];
  try {
    files = await logFiles(root, session);
  } catch (error) {
    if (error instanceof ToolError) throw error;
    files = [];
    scan.reasons.add("LOG_UNAVAILABLE");
  }
  let remaining = SCAN_BUDGET;
  const windows: { entry: LogFile; position: number }[] = [];
  for (const entry of [...files].reverse()) {
    if (remaining <= 0) break;
    const length = Math.min(remaining, entry.size);
    windows.unshift({ entry, position: entry.size - length });
    remaining -= length;
  }
  for (const { entry, position } of windows) {
    const file = await open(entry.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      if ((await file.stat()).ino.toString() !== entry.id.split(":")[1]) {
        scan.reasons.add("ROTATED_DURING_READ");
        continue;
      }
      await scanFile(file, entry, session, input, scan, {
        f: entry.id,
        p: position,
        n: 0,
        a: prefixDigest(Buffer.alloc(0)),
        h: filterIdentity(input),
        d: position > 0,
      });
    } finally {
      await file.close();
    }
  }
  return {
    records: scan.records,
    integrity: {
      historyComplete: false,
      coverage: "bounded-tail",
      scannedBytes: scan.bytes,
      invalidLines: scan.invalidLines,
      reasons: [...scan.reasons],
    },
  };
}
