import { resolve } from "node:path";
import { performBuild, recordBuildFailure } from "./build.ts";
const root = resolve(process.cwd());
const id = process.argv[2];
if (!id) throw new Error("构建 worker 缺少作业标识");
try {
  await performBuild(root, id);
} catch (error) {
  await recordBuildFailure(root, id, error);
  process.exitCode = 1;
}
