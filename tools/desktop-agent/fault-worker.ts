import { resolve } from "node:path";
import { performFault } from "./fault-run.ts";
try {
  await performFault(resolve(process.cwd()), process.argv[2]!);
} catch {
  process.exitCode = 1;
}
