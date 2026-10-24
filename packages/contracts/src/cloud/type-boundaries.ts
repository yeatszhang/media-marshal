import type { CloudAction, CloudInput } from "./index.js";

type AssertNever<T extends never> = T;
type CommandKeys = { [K in CloudAction]: keyof CloudInput<K> }[CloudAction];
export type PublicCommandPrivateFields = AssertNever<Extract<CommandKeys,
  "cookie" | "password" | "endpoint" | "url" | "shell" | "binary" | "credentialHandle" | "locator"
>>;
// 构建时验证公开入口没有意外重导出内部类型。
// @ts-expect-error 传输租约只允许从内部入口导入。
type PrivateLeaseMustStayPrivate = import("../index.js").TransferSourceLease;
// @ts-expect-error 宿主协议只允许从内部入口导入。
type PrivateRequestMustStayPrivate = import("../index.js").HostRequest;
