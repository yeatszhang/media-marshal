import { resolve } from "node:path";
import { supervise } from "./supervisor.ts";
await supervise(resolve(process.cwd()), process.argv[2]!);
