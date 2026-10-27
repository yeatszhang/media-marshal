# 独立同步、识别与 Emby 关联验收

本记录对应 `finish-source-sync-rules`、`add-independent-recognition-mapping` 与 `add-emby-target-path-binding` 的实施。产品操作见[统一来源](../architecture/source-rules.md)、[识别规则](../architecture/desktop-recognition.md)及[整理流水线](../architecture/desktop-ingestion.md)。

## 验证范围

Core 使用真实隔离目录和 SQLite，Rclone 对照使用锁定二进制。窗口运行真实 Electron Main、Preload、Utility Process、冻结解析器和原生文件组件；目录选择的对话框结果受控，原卷身份、文件读取、摘要、COPY、发布和持久查询走生产实现。完整窗口链路不改观察时钟，分别等待同步和识别连续 120 秒。

TMDB 仅准备合法成功缓存，不预置候选、COPY 操作或完成收据；缓存未命中通过不可达本地代理失败，不使用个人密钥。Emby 使用隔离的本地 HTTP 固定响应，核对显式转换后的服务端路径、电影作品和剧集季集。此证据验证客户端协议与交付协调，不等同于真实 Emby Server 的扫描性能或实际下载客户端的完成行为。

非 macOS、Intel 实机、真实下载客户端就绪矩阵、正式签名／公证、只读 DMG 安装升级仍由相应独立变更跟踪；没有用此处的测试补记那些任务，也没有读取个人媒体或网盘凭据。目录包验证与开发构建分别记载，不沿用旧产物冒充新构建。

## 任务与证据

| 变更任务 | 主要证据 |
| --- | --- |
| 同步 1.1 | 默认下载目录组件与原生窗口；`sync-sources.test.tsx` 的取消、缺默认、账号管理往返及授权根变化；窗口验证草稿往返、长路径、重载与 Core 授权恢复 |
| 同步 1.2 | `sync-filters-rclone.test.ts` 与锁定 Rclone 对照；`sync-rules.test.ts` 的无账号本地预览、连续就绪、精确清单、同名占用及输入保留；窗口生产 120 秒 COPY |
| 同步 1.3 | `sync-receipts.test.ts` 的弱／强版本、等价需求、缺盘、本地移除和冲突；既有网盘成功历史／重登录测试；本地五阶段独立进程 SIGKILL、提交后仅补记账、输入离线恢复及相同 inode |
| 识别 1.1 | `recognition-rules.test.ts` 的活动 COPY 安全点、暂停／全局隔离、删除／恢复／重置、旧输入与目标冻结及手动重试；窗口暂停删除恢复且文件保持 |
| 识别 1.2 | 普通目录直接接入、受管收据补处理与并发去重、暂存／外部文件排除、缺成果不补下载、并发确认循环阻断及持久补扫恢复；窗口同步到识别的正式成果交接 |
| 识别 1.3 | 单／批量目标选择组件；多 target、混合分库、空目标、同类多匹配、版本样本授权、范围变化及迟到响应；窗口电影／剧集实际 COPY、任务链接重载及 Core 重启 |
| Emby 1.1 | `emby-paths.test.ts`、`emby-delivery.test.ts` 的 POSIX／Windows／UNC、全段边界、全部库根、类型冲突、歧义、连接及绑定版本；窗口显式转换和多库根 |
| Emby 1.2 | 无 Emby 独立 COPY、离线与绑定修复只重试交付、冻结旧快照、重复回执及证据失效；窗口按逻辑 target 分别核对电影与剧集服务端路径并恢复 COLLECTED 状态 |

## 复现

核心、组件和迁移入口为 `npm test`，新增强杀用例在 `packages/media-core/src/sources/sync-rules.test.ts`。强杀夹具只在 Core 层注入观察时钟，以便精确停在计划、复制、校验、发布、记账五个检查点；它不作为真实客户端稳定时长证据。每个检查点均终止实际独立 Electron Node 进程，重新打开数据库和原授权目标，保持操作 ID、冻结计划、唯一成功收据及已发布文件身份。

窗口先运行 `npm run desktop:build`，再执行：

```bash
npm run test:desktop -- --grep '三者闭环|独立普通目录|Emby 显式路径转换|独立目录授权'
```

当前平台目录包先运行 `CSC_IDENTITY_AUTO_DISCOVERY=false npm run desktop:pack`。按桌面开发文档设置 `MARSHAL_APP_PATH` 与 `MARSHAL_EXECUTABLE=1` 后执行同一窗口选择，另运行 `scripts/check-desktop-artifact.mjs` 核验资源。实际命令、结果、源码与构建／截图摘要保存在 `tools/desktop-files/fixtures/`；复现时重新生成摘要，不从阶段记录推定当前产物通过。
