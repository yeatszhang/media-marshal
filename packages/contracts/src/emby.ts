import { z } from "zod";
const empty = z.strictObject({}), serverId = z.string().regex(/^[a-zA-Z0-9-]{1,128}$/);
export const embyPathConversionSchema = z.strictObject({ localRoot: z.string().min(1).max(4096).regex(/^[^\0\r\n]*$/), serverRoot: z.string().min(1).max(4096).regex(/^[^\0\r\n]*$/), serverPathStyle: z.enum(["posix", "win32"]) });
const libraryMapping = z.strictObject({ targetId: z.uuid(), libraryId: serverId, libraryPath: z.string().min(1).max(4096), conversion: embyPathConversionSchema.nullable().optional() });
const match = z.strictObject({ libraryId: serverId, libraryPath: z.string().max(4096), serverPath: z.string().max(4096) });
export const mediaLibrarySchema = z.strictObject({ mediaType: z.enum(["AUTO", "MOVIE", "TV_SHOW"]), targetId: z.uuid(), path: z.string().min(1).max(4096), available: z.boolean() });
export const embyConfigurationSchema = z.strictObject({ serverId, version: z.number().int().positive(), address: z.url().max(2048), verified: z.boolean(), libraries: z.array(libraryMapping.extend({ bindingId: z.uuid().optional(), bindingVersion: z.number().int().positive().optional() })).max(2000) });
export const embyActions = {
  "media.libraries": { input: empty, output: z.array(mediaLibrarySchema).max(2000) },
  "emby.configuration": { input: empty, output: embyConfigurationSchema.nullable() },
  "emby.libraries": { input: empty, output: z.strictObject({ serverId, version: z.string().max(100), libraries: z.array(z.strictObject({ id: serverId, name: z.string().max(500), paths: z.array(z.string().max(4096)).max(100), type: z.string().max(100).nullable() })).max(1000) }) },
  "emby.discover": { input: z.strictObject({ conversions: z.array(z.strictObject({ targetId: z.uuid(), conversion: embyPathConversionSchema.nullable() })).max(2000).optional() }), output: z.strictObject({ serverId, targets: z.array(z.strictObject({ targetId: z.uuid(), state: z.enum(["MATCHED", "UNMATCHED", "AMBIGUOUS", "TYPE_CONFLICT", "UNAVAILABLE"]), matches: z.array(match).max(1000), incompatible: z.array(match).max(1000), reason: z.string().max(500).nullable() })).max(2000) }) },
  "emby.connect": { input: z.strictObject({ serverId, libraries: z.array(libraryMapping).min(1).max(2000), requestKey: z.uuid().optional(), expectedVersion: z.number().int().nonnegative().optional() }), output: embyConfigurationSchema },
  "emby.retry": { input: z.strictObject({ taskId: z.uuid() }), output: empty },
} as const;
