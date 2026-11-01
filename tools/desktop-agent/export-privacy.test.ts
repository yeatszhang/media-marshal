import { test } from "node:test";
import assert from "node:assert/strict";
import { zipSync, unzipSync, strToU8, strFromU8 } from "fflate";
import { redactExport } from "./export-redaction.ts";
import { exportTrace } from "./export-trace.ts";
test("JSON 导出清除 Cookie、令牌、秘密输入及私人路径，截断明确报告", () => {
  const result = redactExport("/workspace/owned", {
    cookies: [{ name: "session", value: "cookie-value-secret" }],
    headers: [{ name: "Authorization", value: "Bearer header-value-secret" }],
    field: { type: "password", value: "input-secret" },
    requestId: "keep-id",
    url: "https://user:pass@example.invalid/path?token=url-secret",
    path: "/workspace/owned/src/a.ts",
    elsewhere: "/Users/owner/private/file.txt",
    nested: { token: "token-secret" },
  });
  const text = JSON.stringify(result.value);
  for (const secret of [
    "cookie-value-secret",
    "header-value-secret",
    "input-secret",
    "url-secret",
    "token-secret",
    "/Users/owner",
    "user:pass",
  ])
    assert.equal(text.includes(secret), false);
  assert.ok(text.includes("keep-id") && text.includes("<workspace>/src/a.ts"));
  assert.ok(result.redactions > 0);
  assert.equal(redactExport("/workspace", "x".repeat(9000)).truncated, true);
});
test("trace 解压前核对范围和容量，Cookie／令牌标记整份拒绝，安全 trace 隐去工作区路径", () => {
  const normal = zipSync({
    "trace.trace": strToU8(
      JSON.stringify({ type: "before", file: "/workspace/owned/test.ts" }) + "\n",
    ),
  });
  const result = exportTrace("/workspace/owned", normal);
  const decoded = strFromU8(unzipSync(result.bytes)["trace.trace"]!);
  assert.equal(decoded.includes("/workspace/owned"), false);
  assert.ok(decoded.includes("<workspace>/test.ts"));
  for (const value of [
    '{"token":"trace-token-secret"}',
    '{"authorization":"Bearer trace-header-secret"}',
  ])
    assert.throws(() => exportTrace("/workspace", zipSync({ "trace.trace": strToU8(value) })), {
      code: "TRACE_SENSITIVE_MARKER",
    });
  assert.throws(() => exportTrace("/workspace", zipSync({ "../trace.trace": strToU8("{}") })), {
    code: "TRACE_ARCHIVE_REJECTED",
  });
  assert.throws(
    () => exportTrace("/workspace", zipSync({ "trace.trace": new Uint8Array(17 * 1024 * 1024) })),
    { code: "TRACE_ARCHIVE_REJECTED" },
  );
});
