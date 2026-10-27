import { z } from "zod";
import { HOST_PROTOCOL_VERSION, bindingRefSchema, implementationIdSchema, managedRootGrantSchema, remoteLocatorSchema } from "@media-marshal/contracts/internal";
import { driveCapabilitiesSchema } from "@media-marshal/contracts";
export const credentialValidationSchema = z.strictObject({ stableKey: z.string().min(1).max(1024).nullable(), capabilities: driveCapabilitiesSchema.nullable(), objectNamespace: z.string().regex(/^[a-z][a-z0-9.-]{0,79}$/).nullable().optional(), rootLocator: remoteLocatorSchema.optional() });
export type CredentialValidation = z.infer<typeof credentialValidationSchema>;

export const guardianManifestSchema = z.strictObject({
  schemaVersion: z.literal(1), target: z.enum(["darwin-arm64", "darwin-x64", "win32-x64"]), goVersion: z.literal("go1.26.0"),
  binary: z.strictObject({ path: z.enum(["bin/guardian", "bin/guardian.exe"]), sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().positive().max(512 * 1024 * 1024) }),
});
export const hostBindingSchema = bindingRefSchema.extend({ implementationId: implementationIdSchema });
export const credentialInstallSchema = z.strictObject({ kind: z.literal("sidecar.credential.install"), requestId: z.uuid(), binding: hostBindingSchema, secret: z.string().min(1).max(32768) });
export const credentialDropSchema = z.strictObject({ kind: z.literal("sidecar.credential.drop"), requestId: z.uuid(), accountId: z.uuid() });
export const credentialQuiesceSchema = z.strictObject({ kind: z.literal("sidecar.account.quiesce"), requestId: z.uuid(), accountId: z.uuid() });
export const rootInstallSchema = z.strictObject({ kind: z.literal("sidecar.root.install"), requestId: z.uuid(), grant: managedRootGrantSchema });
export const credentialRefreshSchema = z.strictObject({ kind: z.literal("sidecar.credential.refresh"), requestId: z.uuid(), binding: bindingRefSchema, secret: z.string().min(1).max(32768).refine((value) => !/[\r\n\0]/.test(value)) });
export const sidecarInitializeSchema = z.strictObject({
  kind: z.literal("sidecar.initialize"), protocolVersion: z.literal(HOST_PROTOCOL_VERSION),
  hostGeneration: z.uuid(), coreGeneration: z.uuid(),
  resourceRoot: z.string().min(1).max(4096), privateRoot: z.string().min(1).max(4096),
  guardian: guardianManifestSchema, bindings: z.array(hostBindingSchema).min(1).max(100), roots: z.array(managedRootGrantSchema).max(100).default([]),
});
