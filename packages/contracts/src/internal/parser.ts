import { z } from "zod";
const relative = z.string().min(1).max(4096).refine((value) => !value.startsWith("/") && !/[\\\0\r\n]/.test(value) && value.split("/").every((part) => part && part !== "." && part !== ".."));
export const parserManifestSchema = z.strictObject({
  schemaVersion: z.literal(1), target: z.enum(["darwin-arm64", "darwin-x64", "win32-x64"]), protocolVersion: z.literal(1), guessitVersion: z.literal("3.8.0"), pythonVersion: z.string().regex(/^3\.11\.\d+$/),
  sourceHash: z.string().regex(/^[a-f0-9]{64}$/), entryPoint: relative,
  files: z.record(relative, z.union([z.strictObject({ sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number().int().min(0).max(128 * 1024 * 1024) }), z.strictObject({ link: relative })])).refine((files) => Object.keys(files).length > 0 && Object.keys(files).length <= 4096),
});
export const parserLaunchSchema = z.strictObject({ root: z.string().min(1).max(4096), manifest: parserManifestSchema });
export type ParserLaunch = z.infer<typeof parserLaunchSchema>;
