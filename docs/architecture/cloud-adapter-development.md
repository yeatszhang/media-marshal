# 新增网盘接入与传输引擎

扩展点在 Host 的 `CloudDriveProvider` 和 `TransferEngine`，类型位于 `packages/contracts/src/internal/index.ts`。Core 只保存账号、应用远端引用、版本证据和目标授权，不导入 OpenList、Rclone 或候选实现。Renderer 继续使用公开 DTO；不要向公开桥增加 URL、上游 ID、HTTP 头、二进制路径或通用命令入口。

![接入与传输的可替换边界](/architecture/cloud-downloads/adapters.png)

## 使用 WebDAV Bridge 替换 OpenList

1. 按 `apps/desktop/src/sidecar-host/testing/webdav-provider.ts` 实现 Provider，使用新的固定 `implementationId`。实现认证、能力、stat/list、acquireSource/releaseSource 和 disconnect。错误使用 `CloudError`，不能转发原始响应、Cookie、路径或授权地址。
2. `list` 必须有界、准确声明完整性，并保持对象 locator 与父目录关系。分页失败抛出规范错误；没有列出的条目不能推断为删除。`stat` 不支持可靠版本时返回 null，不能把时间戳伪装为 revision 或摘要。网关的“对象不存在”可能包装网络故障，只有可信缺失证据才能映射为 REMOTE_NOT_FOUND；当前 OpenList 接入会刷新并完整核对有界父目录，存在、分页失败或缺少证据时保留可重试错误。
3. Bridge 必须是 Host 监管的只读回环服务，使用独立授权。租约声明 `webdav`，endpoint 仅限带端口的 `http://127.0.0.1`，凭据通过 `SourceCredentialBroker` 的不透明句柄交给 Engine。`file` 映射必须精确指向对应远端引用；Cookie 不进入租约或 Core。
4. 静态注册新 Provider。开发夹具由测试显式传入 `createSidecarApplication({ providers, engines, ... })`；正式实现通过 Host 的 ApplicationModule 注册，不能把测试服务或动态模块加载器带入发行入口。保留既有 RcloneCliEngine 即可，不改业务表或 UI。
5. 所有服务、租约与进程都必须登记到生命周期中。stop 只在确认写入者停止后应答；不能证明停止时抛 `ExecutionUncertainError`，保留占位并等待 Main 的 OS 回收证明。

## 账号与对象身份

`validateCredential` 返回 `stableKey`，仅能使用可信的原生账号身份；Main 哈希后交给 Core。没有可信 UID 就返回 null。声称稳定对象 ID 的实现还必须返回 `objectNamespace` 与 `rootLocator`；命名空间应表示同一上游原生 ID 体系，例如受控的 `quark.native-files`，不能取实现名称或任意路径。

Main 内部的 `CloudAccountController.migrate(draft, implementationId)` 复用授权事务和保险箱轮换。它先暂停领取、确认旧 Host 执行停止并等待 Core 收敛，再验证候选；Core 对相同账号、相同对象命名空间的原生 ID 逐项 stat。核对成功才在事务中换代，保留应用 UUID 和本地历史；对象超过 10000、改名/缺失、命名空间不同或只有路径证据时要求重新选择目录和完整预览。网络验证失败保留原绑定。回退也走相同迁移入口，使用新授权和新代际，不重新启用旧执行 token。

当前 UI 不提供第二个正式接入实现，普通夸克驱动也不声称可信 UID 或稳定对象 ID。未来添加迁移入口时只提供受控选项；Renderer 不接收私有命名空间、locator 或实现安装路径。

## 新增 Engine 或 http-object

Engine 的 `supportedSourceKinds` 必须与租约匹配；没有匹配时在获取租约和写入前失败。start 使用不可变计划及独立 attempt，立即返回稳定句柄；进度有界、有序且不是完成证据。stop 等待原生执行真正退出，不承诺未验证的跨进程字节续传。提交、长度/版本检查、本地摘要与完成记账仍由 Core 的共享文件组件负责。

当前内部联合类型只支持 WebDAV。引入 `http-object` 必须同时扩展内部租约 Schema、Registry 协商、Engine 和契约测试；授权 URL、请求头、过期刷新、Referer、Range 和重试在 Host 内处理，Core 只持有远端引用。不能把 URL 存入任务表，也不能将未知 source kind 兜底交给 shell。

## 可重复验证

在 Mac 完成组件准备与 Electron 原生依赖重建后运行：

```sh
npm run typecheck
npm run check:boundaries
npm run test:electron-node -- packages/media-core/src/cloud/bindings.test.ts apps/desktop/src/sidecar-host/registry.test.ts
MARSHAL_NATIVE_TESTS=1 npm run test:electron-node -- apps/desktop/src/main/cloud/downloads.test.ts
```

最后一条通过独立测试 WebDAV、真实 Rclone 与同一 Core 预览、SQLite 调度、校验、提交、完成/outbox 流程获取测试文件，不启动 OpenList。对应测试保持正式 Core 和 Renderer 不变；当前 Mac arm64 已通过。补充用例应覆盖账号不一致、失效凭据、限流、分页中断、租约失代、停止未知、旧事件、目标冲突和失败回退；不得用假 Engine 的成功断言代替真实传输证据。


架构图仅从 `cloud-downloads.c4` 生成；使用固定工具版本复现：

```sh
npx --yes likec4@1.60.0 validate --no-layout docs/architecture
npx --yes likec4@1.60.0 export png --flat -o docs/public/architecture/cloud-downloads docs/architecture
```

导出需要对应 Playwright 的 Chromium Headless Shell；工具行为以 [LikeC4 官方 CLI 文档](https://likec4.dev/tooling/cli/) 为准。
