import { z } from "zod";
import { createHash } from "node:crypto";
import type { Input } from "./protocol.ts";
const uuid = z.uuid(),
  time = z.iso.datetime();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const artifactKinds = [
  "build",
  "scenario",
  "action",
  "log",
  "health",
  "aria",
  "image",
  "trace",
  "assertion",
  "observation",
  "reproduction",
] as const;
export const sourceSchema = z.enum(["dom", "native", "stub", "tool", "test"]);
export const reasonSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/);
export const artifactSchema = z
  .strictObject({
    id: uuid,
    kind: z.enum(artifactKinds),
    source: sourceSchema,
    time,
    status: z.enum(["available", "missing", "blocked", "not-run", "pending"]),
    name: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,239}$/)
      .optional(),
    sha256: digest.optional(),
    bytes: z.number().int().nonnegative().optional(),
    reason: reasonSchema.optional(),
    historyComplete: z.boolean().default(false),
    requestId: uuid.optional(),
    snapshotId: uuid.optional(),
    windowId: z.string().max(120).optional(),
    operationId: z.string().max(120).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.status === "available" && (!value.name || !value.sha256 || value.bytes === undefined))
      ctx.addIssue({ code: "custom", message: "可用证据必须包含文件、摘要与大小" });
    if (["missing", "blocked", "not-run"].includes(value.status) && !value.reason)
      ctx.addIssue({ code: "custom", message: "未取得的证据必须说明原因" });
  });
const failureSchema = z.strictObject({
  id: uuid,
  time,
  kind: z.enum(["assertion", "startup", "crash", "collection"]),
  code: reasonSchema,
  file: z.string().max(500).optional(),
  line: z.number().int().positive().optional(),
});
export const manifestContent = z.strictObject({
  format: z.literal(1),
  sessionId: uuid,
  runId: uuid,
  profileRunId: uuid,
  generation: z.number().int().positive(),
  producer: z.enum(["controller", "test"]),
  createdAt: time,
  updatedAt: time,
  buildId: digest.optional(),
  scenario: z.strictObject({ name: z.string().max(100), seed: z.string().max(100) }),
  mode: z.enum(["background", "foreground"]),
  target: z.enum(["development", "packaged"]),
  lifecycle: z.enum(["starting", "running", "closed", "failed", "crashed", "blocked", "unknown"]),
  artifacts: z.array(artifactSchema).max(2048),
  failures: z.array(failureSchema).max(256),
  primaryFailureId: uuid.optional(),
  historyComplete: z.literal(false),
  assertions: z.enum(["not-run", "passed", "failed", "blocked", "unknown"]),
});
export const manifestSchema = manifestContent.extend({ checksum: digest });
export type EvidenceManifest = z.output<typeof manifestContent>;
export type Artifact = z.output<typeof artifactSchema>;
export type Failure = z.output<typeof failureSchema>;
export interface RunIdentity {
  producer?: "controller" | "test";
  sessionId: string;
  runId: string;
  profileRunId: string;
  generation: number;
  createdAt: string;
  buildId?: string;
  options: Omit<Input<"start">, "scenario"> & { scenario: string };
}
export const evidenceChecksum = (value: EvidenceManifest) =>
  createHash("sha256")
    .update(JSON.stringify(manifestContent.parse(value)))
    .digest("hex");
