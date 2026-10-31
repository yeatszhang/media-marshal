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
