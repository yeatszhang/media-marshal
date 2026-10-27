import { z } from "zod";
import { defaultDownloadDirectorySchema, defaultDownloadDirectoryWriteSchema, directoryBindingSchema } from "./sync-recognition.js";
export const configurationDirectorySchema = directoryBindingSchema.extend({ kind: z.enum(["ordinary", "managed", "media"]), available: z.boolean() });
export const configurationActions = {
  "configuration.directories": { input: z.strictObject({}), output: z.array(configurationDirectorySchema).max(1000) },
  "configuration.default": { input: z.strictObject({}), output: defaultDownloadDirectorySchema },
  "configuration.set-default": { input: defaultDownloadDirectoryWriteSchema, output: defaultDownloadDirectorySchema },
} as const;
