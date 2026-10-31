import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { ToolError, type Input } from "./protocol.ts";
const schema = z.strictObject({
  f: z.string().max(60),
  p: z.number().int().nonnegative(),
  h: z.string().length(16),
  a: z.string().length(12),
  n: z.number().int().min(0).max(256),
  d: z.boolean().optional(),
});
export type Cursor = z.infer<typeof schema>;
export function filterIdentity(input: Input<"logs">) {
  const { cursor: _cursor, limit: _limit, ...filters } = input;
  return createHash("sha256").update(JSON.stringify(filters)).digest("hex").slice(0, 16);
}
const sign = (value: string, key: string) =>
  createHmac("sha256", key).update(value).digest("base64url").slice(0, 22);
export function encodeCursor(cursor: Cursor, key: string) {
  const value = Buffer.from(JSON.stringify(cursor)).toString("base64url");
  return value + "." + sign(value, key);
}
export function decodeCursor(cursor: string, key: string, filter: string): Cursor {
  try {
    const [value, signature, extra] = cursor.split(".");
    if (!value || !signature || extra) throw new Error();
    const expected = sign(value, key),
      a = Buffer.from(signature),
      b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error();
    const result = schema.parse(JSON.parse(Buffer.from(value, "base64url").toString("utf8")));
    if (result.h !== filter) throw new Error();
    return result;
  } catch {
    throw new ToolError(
      "INVALID_LOG_CURSOR",
      "日志游标已失效、被修改或过滤条件变化",
      "原会话使用相同过滤条件；重新查询时显式省略游标",
    );
  }
}
export const prefixDigest = (value: Buffer) =>
  createHash("sha256").update(value).digest("hex").slice(0, 12);
