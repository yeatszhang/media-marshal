import { resolve } from "node:path";
import { exportCiEvidence } from "./ci-evidence.ts";
try {
  if (process.argv.length !== 2) throw new Error("此入口不接受任意路径或选项");
  const result = await exportCiEvidence(resolve(import.meta.dirname, "../.."));
  process.stdout.write(JSON.stringify(result) + "\n");
  if (result.exported.some((run) => run.status === "missing")) process.exitCode = 2;
} catch {
  process.stdout.write(
    JSON.stringify({
      status: "unknown",
      reason: "CI_EXPORT_UNAVAILABLE",
      rawProfilesUploaded: false,
    }) + "\n",
  );
  process.exitCode = 2;
}
