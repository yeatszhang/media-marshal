import { z } from "zod";
import { invokeNative, type NativeRequest } from "./native-runtime.ts";
import { ToolError } from "./protocol.ts";

const bounds = z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() });
const snapshot = z.object({
  coverage: z.literal("native-controls-content-boundaries").optional(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  truncated: z.boolean(),
  omissions: z
    .array(
      z.object({
        path: z.array(z.number().int().nonnegative()),
        reason: z.enum(["unknown-owner", "node-limit", "depth-limit"]),
      }),
    )
    .optional(),
  nodes: z
    .array(
      z.object({
        path: z.array(z.number().int().nonnegative()),
        role: z.string(),
        subrole: z.string().optional(),
        name: z.string(),
        enabled: z.boolean(),
        focused: z.boolean(),
        bounds,
        secure: z.boolean(),
      }),
    )
    .max(500),
  windows: z.array(
    z.object({
      id: z.number().int(),
      bounds: z.object({ X: z.number(), Y: z.number(), Width: z.number(), Height: z.number() }),
    }),
  ),
});
export type NativeSnapshot = z.output<typeof snapshot>;

/** 只重复只读观察；动作仍须携带返回指纹，拒绝时不刷新或重放。 */
export async function settledNativeObservation(
  observe: () => Promise<unknown>,
  options = { timeoutMs: 7000, intervalMs: 100 },
): Promise<NativeSnapshot> {
  const deadline = Date.now() + options.timeoutMs;
  let previous: string | undefined;
  while (Date.now() < deadline) {
    const current = snapshot.parse(await observe());
    if (
      current.truncated &&
      (!current.omissions?.length ||
        current.omissions.some((item) => item.reason !== "unknown-owner"))
    )
      throw new ToolError(
        "NATIVE_SNAPSHOT_TRUNCATED",
        "原生语义树不完整",
        "缩小场景后重新观察",
        "blocked",
      );
    if (current.nodes.length > 0 && current.fingerprint === previous) return current;
    previous = current.fingerprint;
    await new Promise((done) => setTimeout(done, options.intervalMs));
  }
  throw new ToolError(
    "NATIVE_SNAPSHOT_UNSTABLE",
    "原生界面尚未稳定",
    "核对窗口状态后重新观察，不重放动作",
    "blocked",
  );
}
export function observeNative(root: string, identity: NativeRequest) {
  return settledNativeObservation(() => invokeNative(root, { ...identity, command: "observe" }));
}
