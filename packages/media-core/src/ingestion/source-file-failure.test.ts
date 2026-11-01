import { expect, it } from "vitest";
import { DesktopError } from "@media-marshal/contracts";
import { sourceFileFailure } from "./source-file-failure.js";

it.each([
  ["ENOENT", "文件或其父目录已不存在"],
  ["ENOTDIR", "文件或其父目录已不存在"],
  ["EACCES", "读取权限不足"],
  ["EPERM", "读取权限不足"],
  ["ENODEV", "磁盘或挂载已不可用"],
  ["ENXIO", "磁盘或挂载已不可用"],
  ["ESTALE", "磁盘或挂载已不可用"],
  ["EIO", "磁盘 I/O 错误"],
  ["UNKNOWN", "原因尚不明确"],
])("%s 显示可信原因及修复动作，不透传原始异常", (code, reason) => {
  const error = Object.assign(new Error("原始敏感信息 /private/file"), { code });
  const failure = sourceFileFailure(error, true);
  expect(failure).toContain(reason);
  expect(failure).toContain("请");
  expect(failure).not.toMatch(/原始敏感信息|\/private\/file/);
});

it("普通来源缺失不冒充存在同步收据，受管来源说明不自动补下载", () => {
  const error = Object.assign(new Error("missing"), { code: "ENOENT" });
  expect(sourceFileFailure(error)).not.toContain("同步成功记录");
  expect(sourceFileFailure(error, true)).toContain("同步成功记录仍保留，识别不会自动重新下载");
});

it("保留已有受控业务原因；未知异常不猜测成权限或磁盘故障", () => {
  expect(sourceFileFailure(new DesktopError("CONFLICT", "正式成果摘要与成功收据不一致"))).toBe(
    "正式成果摘要与成功收据不一致",
  );
  for (const error of [undefined, null, "错误", new TypeError("内部缺陷")]) {
    expect(sourceFileFailure(error)).toContain("原因尚不明确");
  }
});
