import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  cloudAccountSchema, cloudFailure, cloudFailureSchema, CloudError, parseCloudRequest,
  remotePageSchema, versionEvidenceSchema,
} from "./index";
import { transferSourceLeaseSchema } from "../internal/index";
// @ts-expect-error 跨工具共享的本地 ESM 检查器。
import { dependencyViolation } from "../../../../scripts/desktop-boundary-rules.mjs";

describe("云端公开边界", () => {
  it("业务请求只接受应用引用，拒绝 URL、参数、私有定位及未知动作", () => {
    const payload = { accountId: randomUUID(), remoteRef: randomUUID(), targetGrantId: randomUUID(), requestKey: randomUUID() };
    expect(parseCloudRequest({ action: "cloud.downloads.preview", payload }).payload).toEqual(payload);
    for (const extra of [ { url: "http://127.0.0.1:1" }, { shell: "rm" }, { binary: "/tmp/tool" }, { cookie: "secret" }, { locator: { kind: "path", segments: [] } } ])
      expect(() => parseCloudRequest({ action: "cloud.downloads.preview", payload: { ...payload, ...extra } })).toThrow(CloudError);
    for (const action of ["http.fetch", "shell.exec", "provider.list", "transfer.start", "__proto__"])
      expect(() => parseCloudRequest({ action, payload: {} })).toThrow(CloudError);
    expect(() => parseCloudRequest({ action: "cloud.downloads.confirm", payload: { previewId: "http://example.com", requestKey: randomUUID() } })).toThrow();
  });
  it("账号查询 DTO 不能回传凭据或实现私有字段", () => {
    const account = { id: randomUUID(), name: "账号", providerKind: "quark", status: "READY", capabilities: null };
    expect(cloudAccountSchema.safeParse(account).success).toBe(true);
    for (const field of ["cookie", "credentialRef", "addition", "storageId", "endpoint"])
      expect(cloudAccountSchema.safeParse({ ...account, [field]: "private" }).success).toBe(false);
  });
  it("错误只输出归一化消息，认证不自动重试，限流延时有上限", () => {
    expect(JSON.stringify(cloudFailure(new Error("cookie=secret /Users/private")))).not.toMatch(/secret|private/);
    expect(cloudFailure(new CloudError("AUTH_REQUIRED"))).toMatchObject({ retryable: false });
    expect(cloudFailure(new CloudError("RATE_LIMITED", 30))).toMatchObject({ retryable: true, retryAfterSeconds: 30 });
    expect(cloudFailure(new CloudError("RATE_LIMITED", 999999))).not.toHaveProperty("retryAfterSeconds");
    expect(cloudFailureSchema.safeParse({ code: "INTERNAL_ERROR", message: "cookie=secret", retryable: true }).success).toBe(false);
  });
  it("版本证据不把弱信息伪装成摘要，完整页不保留后续游标", () => {
    expect(versionEvidenceSchema.safeParse({ kind: "weak", size: 1, modifiedAt: null }).success).toBe(true);
    expect(versionEvidenceSchema.safeParse({ kind: "hash", algorithm: "sha256", value: "00" }).success).toBe(false);
    expect(remotePageSchema.safeParse({ items: [], nextCursor: "next", total: null, complete: true }).success).toBe(false);
  });
  it("Host 的私有租约也拒绝外网、URL 凭据和非 HTTP 读取", () => {
    const lease = { leaseId: randomUUID(), generation: randomUUID(), kind: "webdav", endpoint: "http://127.0.0.1:5244/dav/", root: "/", credentialHandle: randomUUID() };
    expect(transferSourceLeaseSchema.safeParse(lease).success).toBe(true);
    for (const endpoint of ["https://example.com/dav/", "http://user:secret@127.0.0.1:5244/", "file:///etc/passwd", "invalid", "http://localhost:5244/"])
      expect(transferSourceLeaseSchema.safeParse({ ...lease, endpoint }).success).toBe(false);
  });
  it("导入检查阻止包路径、相对路径及公开重导出绕过内部边界", () => {
    const renderer = resolve("apps/desktop/src/renderer/src/services.ts");
    const area = "apps/desktop/src/renderer";
    expect(dependencyViolation(area, renderer, "@media-marshal/contracts")).toBeUndefined();
    for (const name of ["@media-marshal/contracts/internal", "../../../../../packages/contracts/src/internal/index", "node:child_process", "../../sidecar-host/index"])
      expect(dependencyViolation(area, renderer, name)).toBeTypeOf("string");
    expect(dependencyViolation("packages/contracts/src", resolve("packages/contracts/src/index.ts"), "./internal/index.js")).toBeTypeOf("string");
    expect(dependencyViolation("apps/desktop/src/preload", resolve("apps/desktop/src/preload/index.ts"), "@media-marshal/contracts/internal")).toBeTypeOf("string");
  });
});
