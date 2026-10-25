import { z } from "zod";
import { cloudAuthorizationSchema, cloudFailureSchema, driveCapabilitiesSchema } from "../cloud/index.js";
import { bindingRefSchema, implementationIdSchema, managedRootGrantSchema, remoteLocatorSchema } from "./index.js";
import { sourceRuleApplySchema, sourceRuleSchema } from "../source-rules.js";
import { rpcErrorSchema } from "../index.js";

export const CORE_DATA_SCHEMA_VERSION = 17;
const id = z.uuid(), empty = z.strictObject({});
const configuredBinding = z.strictObject({ binding: bindingRefSchema.extend({ implementationId: implementationIdSchema }), credentialRef: id });
export const privateCoreActions = {
  "media.observations.reset": { input: empty, output: empty },
  "desktop.state.reconcile-restored": { input: empty, output: empty },
  "source-rules.apply": { input: sourceRuleApplySchema.extend({ grants: z.strictObject({ source: managedRootGrantSchema, target: managedRootGrantSchema }).optional() }), output: sourceRuleSchema },
  "media.targets.find": { input: z.strictObject({ path: z.string().min(1).max(4096) }), output: managedRootGrantSchema.nullable() },
  "media.targets.bootstrap": { input: empty, output: z.array(managedRootGrantSchema).max(10000) },
  "media.targets.authorize": { input: managedRootGrantSchema, output: empty },
  "media.sources.authorize-managed": { input: z.strictObject({ sourceId: id, sourceVersion: z.number().int().positive(), source: managedRootGrantSchema }), output: empty },
  "media.credentials.install": { input: z.strictObject({ tmdb: z.string().max(1024).regex(/^[^\r\n\0]*$/).nullable(), emby: z.string().max(1024).regex(/^[^\r\n\0]*$/).nullable() }), output: empty },
  "media.sources.bootstrap": { input: empty, output: z.array(z.strictObject({ sourceId: id, sourceVersion: z.number().int().positive(), mode: z.enum(["local", "managed"]), downloadRootId: id.nullable(), source: managedRootGrantSchema, target: managedRootGrantSchema })).max(1000) },
  "media.sources.authorize": { input: z.strictObject({ sourceId: id, sourceVersion: z.number().int().positive(), mode: z.enum(["local", "managed"]), downloadRootId: id.nullable(), source: managedRootGrantSchema, target: managedRootGrantSchema }), output: empty },
  "media.sources.configure-managed": { input: z.strictObject({ downloadRootId: id, name: z.string().trim().min(1).max(100), mediaType: z.enum(["AUTO", "MOVIE", "TV_SHOW"]), source: managedRootGrantSchema, target: managedRootGrantSchema }), output: id },
  "media.library.bootstrap": { input: empty, output: z.array(z.strictObject({ mediaType: z.enum(["MOVIE", "TV_SHOW"]), target: managedRootGrantSchema })).max(2) },
  "media.library.authorize": { input: z.strictObject({ mediaType: z.enum(["MOVIE", "TV_SHOW"]), target: managedRootGrantSchema }), output: empty },
  "media.emby.open-url": { input: z.strictObject({ taskId: id }), output: z.url().max(4096) },
  "cloud.downloads.reconcile-restored": { input: empty, output: empty },
  "cloud.downloads.quiesce": { input: empty, output: empty },
  "cloud.runtime.wake": { input: z.strictObject({ hostGeneration: id }), output: empty },
  "cloud.account.suspending": { input: z.strictObject({ accountId: id }), output: empty },
  "cloud.account.writers-stopped": { input: z.strictObject({ accountId: id }), output: empty },
  "cloud.downloads.completed-root": { input: z.strictObject({ jobId: id }), output: z.string().min(1).max(4096) },
  "cloud.roots.bootstrap": { input: empty, output: z.array(managedRootGrantSchema).max(100) },
  "cloud.roots.authorize": { input: managedRootGrantSchema, output: managedRootGrantSchema },
  "cloud.roots.unavailable": { input: z.strictObject({ id }), output: empty },
  "cloud.bootstrap": { input: empty, output: z.array(configuredBinding).max(100) },
  "cloud.authorization.begin": {
    input: z.strictObject({ accountId: id.optional(), name: z.string().trim().min(1).max(100), requestKey: id, implementationId: implementationIdSchema }),
    output: z.strictObject({ job: cloudAuthorizationSchema, candidate: configuredBinding, previous: configuredBinding.nullable() }),
  },
  "cloud.authorization.finish": {
    input: z.strictObject({ jobId: id, failure: cloudFailureSchema.nullable(), capabilities: driveCapabilitiesSchema.nullable(), identityKey: z.string().regex(/^[a-f0-9]{64}$/).nullable(), objectNamespace: z.string().regex(/^[a-z][a-z0-9.-]{0,79}$/).nullable().optional(), rootLocator: remoteLocatorSchema.optional() }),
    output: cloudAuthorizationSchema,
  },
  "cloud.account.restored": { input: z.strictObject({ accountId: id, generation: id, failure: cloudFailureSchema.nullable() }), output: empty },
  "cloud.account.credentials": { input: z.strictObject({ accountId: id }), output: z.array(id).max(1000) },
  "cloud.account.disconnected": { input: z.strictObject({ accountId: id }), output: empty },
} as const;
export type PrivateCoreAction = keyof typeof privateCoreActions;
export type PrivateCoreInput<K extends PrivateCoreAction> = z.input<(typeof privateCoreActions)[K]["input"]>;
export type PrivateCoreOutput<K extends PrivateCoreAction> = z.output<(typeof privateCoreActions)[K]["output"]>;
export const privateCoreRequestSchema = z.strictObject({
  kind: z.literal("core.private.request"), requestId: id,
  action: z.enum(Object.keys(privateCoreActions) as [PrivateCoreAction, ...PrivateCoreAction[]]), payload: z.unknown(),
});
export const privateCoreResponseSchema = z.discriminatedUnion("ok", [
  z.strictObject({ kind: z.literal("core.private.response"), requestId: id, ok: z.literal(true), result: z.unknown() }),
  z.strictObject({ kind: z.literal("core.private.response"), requestId: id, ok: z.literal(false), error: rpcErrorSchema }),
]);
