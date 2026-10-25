import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import { CloudError, cloudFailure, type CloudFailure } from "@media-marshal/contracts";
import type { TransferEvent } from "@media-marshal/contracts/internal";

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const statistics = z.object({ bytes: count, totalBytes: count.nullable().optional(), speed: z.number().finite().nonnegative() });
type Progress = Extract<TransferEvent, { type: "progress" }>;
/** 只提取固定版本的统计字段，原始消息、文件路径及错误文本不出宿主。 */
export class RcloneLogParser {
  private decoder = new StringDecoder("utf8");
  private line = "";
  private discarding = false;
  private emittedAt = -Infinity;
  private bytes = 0;
  private pending?: Progress;
  droppedLines = 0;
  constructor(private readonly emit: (value: Progress) => void, private readonly now = Date.now, private readonly maximumLine = 64 * 1024) {}
  feed(chunk: Buffer) { this.consume(this.decoder.write(chunk)); }
  private consume(text: string) {
    let start = 0;
    for (;;) {
      const end = text.indexOf("\n", start), part = end < 0 ? text.slice(start) : text.slice(start, end);
      if (!this.discarding) {
        if (Buffer.byteLength(this.line) + Buffer.byteLength(part) > this.maximumLine) { this.line = ""; this.discarding = true; this.droppedLines++; }
        else this.line += part;
      }
      if (end < 0) return;
      if (!this.discarding) this.parse(this.line);
      this.line = ""; this.discarding = false; start = end + 1;
    }
  }
  private parse(line: string) {
    let value: unknown;
    try { value = JSON.parse(line); } catch { if (line.trim()) this.droppedLines++; return; }
    const parsed = statistics.safeParse((value as { stats?: unknown } | null)?.stats);
    if (!parsed.success) return;
    const stats = parsed.data;
    this.bytes = Math.max(this.bytes, stats.bytes);
    const total = stats.totalBytes ?? null;
    this.pending = { type: "progress", bytes: this.bytes, totalBytes: total !== null && total >= this.bytes ? total : null, bytesPerSecond: stats.speed };
    if (this.now() - this.emittedAt >= 1000) { this.emit(this.pending); this.pending = undefined; this.emittedAt = this.now(); }
  }
  finish() {
    this.consume(this.decoder.end());
    if (!this.discarding && this.line) this.parse(this.line);
    this.line = "";
    // 退出事件紧随其后；最后一次观测不伪造文件校验或完成量。
    if (this.pending && this.now() - this.emittedAt >= 1000) this.emit(this.pending);
    this.pending = undefined;
  }
}
export function rcloneExitFailure(code: number, stopped: boolean): CloudFailure | null {
  if (stopped || code === 0) return null;
  return cloudFailure(new CloudError(code === 5 ? "NETWORK_UNAVAILABLE" : "COMPONENT_UNAVAILABLE"));
}
