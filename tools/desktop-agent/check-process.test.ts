import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { checkProcess } from "./check-process.ts";
import { identify, sameProcess } from "./process.ts";
test(
  "检查超时只结束本次子进程，外部实例保留，UTF-8 跨块输出不损坏",
  { timeout: 10000 },
  async () => {
    const external = spawn(process.execPath, ["-e", "setInterval(()=>{},10000)"], {
      stdio: "ignore",
    });
    const identity = identify(external.pid!)!;
    try {
      const complete = await checkProcess(
        process.cwd(),
        process.execPath,
        [
          "-e",
          "const b=Buffer.from('中文输出');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),10)",
        ],
        process.env,
        5000,
      );
      assert.equal(complete.text, "中文输出");
      assert.equal(complete.exitCode, 0);
      const timed = await checkProcess(
        process.cwd(),
        process.execPath,
        ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},10000)"],
        process.env,
        600,
      );
      assert.equal(timed.timedOut, true);
      assert.equal(timed.exitCode, null);
      assert.notEqual(timed.owner?.pid, external.pid);
      assert.equal(sameProcess(identity), true);
      if (timed.owner) assert.equal(identify(timed.owner.pid), undefined);
    } finally {
      if (sameProcess(identity)) external.kill("SIGTERM");
    }
  },
);
