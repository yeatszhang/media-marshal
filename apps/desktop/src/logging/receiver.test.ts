import { expect, it } from "vitest";
import { createProcessLogger } from "./node";
import { createLogReceiver } from "./receiver";

it("逐项扫描诊断经 Core 转发后保留相对路径与错误码，原始消息不进入日志", () => {
  let coreOutput = "",
    mainOutput = "";
  const core = createProcessLogger("core", {
    write: (chunk) => {
      coreOutput += chunk;
    },
  });
  const main = createProcessLogger("main", {
    write: (chunk) => {
      mainOutput += chunk;
    },
  });
  core.warn(
    {
      event: "recognition.scan.file-failed",
      sourceId: "source-id",
      relativePath: "completed/图片/logo.png",
      error: Object.assign(new Error("原始敏感信息"), { code: "ENOENT" }),
    },
    "扫描文件核对失败，已保留逐项原因",
  );
  createLogReceiver(main, "core").line(coreOutput.trim());
  expect(JSON.parse(mainOutput)).toMatchObject({
    process: "core",
    event: "recognition.scan.file-failed",
    sourceId: "source-id",
    relativePath: "completed/图片/logo.png",
    error: { type: "Error", code: "ENOENT" },
  });
  expect(mainOutput).not.toContain("原始敏感信息");
});
