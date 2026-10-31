# 桌面开发控制工具

统一入口供 Codex 和本地开发脚本调用，协议使用 JSON。当前已交付命令参数、结果、异步收据、环境诊断和 CLI 基础；具体能力按 OpenSpec 任务逐项接入，未接入命令返回 `blocked`，不会报告为验证成功。

```sh
npm run --silent desktop:agent -- help --json
npm run --silent desktop:agent -- doctor --json
npm run test:desktop-agent
npm run typecheck:desktop-agent
```

复杂参数使用 `--input 请求参数.json`，会话使用 `--session UUID`，幂等请求使用 `--request UUID`。help 返回命令的 JSON Schema；不接受额外属性、任意代码、SQL 或任意 IPC 动作。stdout 仅输出一条 JSON 结果，结果包含协议版本、请求身份、状态和可信修复动作。

异步操作返回 jobId；重复请求继续使用原收据。相同请求 ID 携带不同输入会拒绝，超时或取消可能只结束等待，必须先查询结果，不能重新确认写操作。收据容量耗尽时拒绝新请求，不静默淘汰旧写操作身份。

开发工具不进入发行包，不连接用户正在使用的实例。完整能力和验收条件见 `openspec/changes/refactor-desktop-module-boundaries/`；架构检查同样覆盖本目录。

`doctor` 只读检查依赖、Electron／SQLite ABI、源码映射和本机资源，不自动安装或下载。资源缺失返回 `blocked` 和修复命令，退出码为 2。原生权限严格检查使用输入 `{"native": true}`；后台 DOM 自动化不需要屏幕录制权限。

macOS 原生 helper 需显式执行 `npm run desktop:agent:native:build`。其能力探测不会弹出或操作权限确认；系统未授权录屏时原生截图保持受阻。helper 仅面向本工作树中使用工具隔离 profile 的进程，拒绝不匹配的可执行文件、创建时间和界面指纹，输出只进入新的会话证据文件。

当前原生 helper 已通过编译、能力探测及非法输入／进程拒绝测试；完整目标身份、窗口代际和前台原生流程仍在任务 2.12／2.13 验收，不能将这些探测结果算作原生交互已通过。

构建使用 `build --json`，默认 development；目录包输入为 `{"target":"packaged"}`。命令立即返回持久作业 ID；将 `{"jobId":"返回的 UUID"}` 写入参数文件后使用 `status --input 参数文件 --json` 查询。同一 `--request UUID` 只返回原构建，输入不同会拒绝。失败日志位于对应 `test-results/agent/builds/<jobId>/build.log`，不会混入 stdout。

成功构建清单绑定 Git 基点、未提交及未跟踪有效源码、配置／锁文件、运行平台和产物摘要。构建前后同时比较内容及文件变化观测；构建期间改后复原也拒绝。生成的 dist、资源和证据不被误计为源码。启动前重新核对清单和产物；最近构建失败、清单损坏、源码变化或产物缺失时拒绝使用旧成功结果。崩溃遗留构建锁不自动删除，必须先核实原构建及子进程已停止。

`start --json` 创建默认后台的 empty 会话；随后以 `--session <sessionId>` 调用 `status`、`restart`、`stop`。耗时生命周期操作先返回 running 收据，使用 status 等待 running／stopped；重复原 request ID 查询其结果，不重新执行。前台通过参数 `{"mode":"foreground"}` 显式选择。当前仅 empty 场景接入，其余场景明确受阻。

本地控制进程跨 CLI 调用存活，随机凭证仅留在权限受限的会话记录，本机 socket 权限为 0600，不开放网络监听。会话记录在 `test-results/agent/sessions/`；每次启动或重启创建新的 `test-results/agent/<runId>/`。重启保留初始 run 的 data 目录并提升 generation，旧证据不覆盖。共享 Electron 启动夹具位于 `apps/desktop/tests/support/electron.ts`，呈现 E2E 已使用同一入口。

停止只通过原应用连接请求正常退出，等待应用自身 drain；不强制结束业务进程。PID、创建时间或命令不符、控制连接丢失或停机超时均保持 unknown，不接管替代进程。停止回收控制连接和自有应用进程，隔离数据及证据继续保留，过期证据回收按任务 2.15 接入。单元检查使用 `npm run test:desktop-agent`；真实会话回归需先完成当前 build，再运行 `node --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types --test tools/desktop-agent/session.integration.ts`。

开发会话的启动身份与请求关联沿用统一日志，详见[日志因果、事件目录及完整性边界](../../docs/development/desktop-logging.md)。控制器注入实际 buildId／sessionId／runId；每个进程有独立代际和序号。界面请求只记录动作和受限业务 ID，后台轮询不冒用上一次点击，普通发行的高频只读调用使用 debug 级别。logs／diagnose 的查询范围和完整性说明见下文。

`logs --session <sessionId> --input 过滤参数.json --json` 读取本会话日志；支持 level（最低级别）、process、scope、requestId、operationId、limit 和 cursor。operationId 可查询业务 job／task／item ID 或状态事件中的物理关联。一次最多返回 200 条，扫描预算 2 MiB、输出预算 192 KiB；继续查询使用返回的 cursor。游标绑定会话密钥和过滤条件，可调整 limit，不能挪到其他会话或更换过滤条件。轮转按文件身份续读，历史删除／改写、超长行、部分写入及采集限流都有完整性标记。

`diagnose --session <sessionId> --json` 汇总受限只读业务查询、宿主进程列表、最近警告与异常采集；不直接打开运行中的业务 SQLite，不触发重试、补扫、复制或清理。分页摘要会标记截断，组件缺失返回 unavailable。诊断完成只说明查询已结束，`assertions` 始终标记未执行，不据此断言业务成功。

每个 run 自动保留 `observations.jsonl`，采集受信任主页面 pageerror、窗口崩溃、组件退出和日志文件失败；其他来源的登录窗口只记录不可观察，不采集其异常正文。未标记控制台不保存。采集队列最多 256 条、文件最多 1 MiB，丢弃数量和缺失总结均明确报告；正常停止保存 collector.json，异常退出不能假定最后记录完整。日志记录的 dropBatchId／dropReason 按批次分组，dropCount 取最大计数；batchComplete 为 false 时只是下界，不能重复相加。所有查询均保留 historyComplete=false，范围是当前可用历史或有界尾部。
