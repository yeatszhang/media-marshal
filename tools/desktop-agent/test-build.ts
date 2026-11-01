import { resolve } from "node:path";
import { buildStatus, createBuild } from "./build.ts";
import { parseRequest } from "./protocol.ts";
const target = process.argv[2] ?? "development",
  root = resolve(process.cwd());
let job = await createBuild(root, parseRequest({ command: "build", payload: { target } }));
const deadline = Date.now() + 15 * 60 * 1000;
while (job.status === "running" && Date.now() < deadline) {
  await new Promise((done) => setTimeout(done, 250));
  job = await buildStatus(root, job.id);
}
process.stdout.write(
  JSON.stringify({
    event: "desktop.test.build",
    status: job.status,
    jobId: job.id,
    result: job.result,
    error: job.error,
  }) + "\n",
);
if (job.status !== "completed") process.exitCode = 1;
