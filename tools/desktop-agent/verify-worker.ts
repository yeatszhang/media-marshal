import { resolve } from "node:path";
import { performVerification } from "./verify-run.ts";
try {
  await performVerification(resolve(process.cwd()), process.argv[2]!);
} catch {
  process.exitCode = 1;
}
