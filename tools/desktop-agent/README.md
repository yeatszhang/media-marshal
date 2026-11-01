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

`start --json` 创建默认后台的 empty 会话；随后以 `--session <sessionId>` 调用 `status`、`restart`、`stop`。耗时生命周期操作先返回 running 收据，使用 status 等待 running／stopped；重复原 request ID 查询其结果，不重新执行。前台通过参数 `{"mode":"foreground"}` 显式选择。

场景使用 `scenario --input 参数文件 --json`：`{"mode":"list"}` 查询注册定义，`{"mode":"run","name":"recognition-review","seed":"复现编号"}` 创建新后台隔离会话。也可向 start 传 `scenario` 与 `seed`。同 seed 保持合成输入与业务后置条件一致，物理目录、会话和运行身份各自独立。场景 run 拒绝已有 session；不能通过此命令重置活跃业务库。

| 场景               | 实际运行与后置条件                                                           | 替身与限制                                                        |
| ------------------ | ---------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| empty              | 应用自行初始化当前空库，没有同步、识别或下载                                 | 无业务数据替身                                                    |
| local-sync-ready   | 独立同步 API 保存、预览、确认一条本地配置                                    | 仅自有目录授权；输入仍须生产稳定观察，不保证立即产生同步任务      |
| recognition-review | 真实下载提交、暂存清理及收据接入，独立识别规则，待确认任务，无整理 COPY 计划 | 云端计划／stat 与识别结果为固定替身，不验证远端账号或真实识别质量 |
| download-conflict  | 启动后 BLOCKED_LOCAL，已有不同目标内容保留                                   | 固定云端计划，不连接真实账号、不执行远程下载                      |
| recovery-pending   | 未完成写入进入 RECONCILING，不发布 completed 文件                            | 固定中断状态，不等同于本轮实际 SIGKILL 恢复验收                   |

非空场景当前需要 macOS 原生卷探测和匹配 Electron ABI 的 SQLite。控制器在应用启动前以 Electron Node 独占初始化自有数据库，复用 `apps/desktop/tests/support/` 的下载与识别夹具；启动后通过受限只读 API 核对后置条件。`scenario.json` 记录当前 schema、版本、seed、真实路径及替身；`scenario-check.json` 仅在业务和文件检查都通过后标记 passed。重启保留原数据，只记录初始断言未重跑，避免把开发操作重置成夹具。

已有库、部分准备、准备超时或 schema／场景版本不符均保留证据并拒绝覆盖，不自动删除数据库或重复灌数据。通过 seed-worker.json 核实准备进程，失败后使用新会话复现。场景集成检查需先 build，再运行 `node --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types --test tools/desktop-agent/scenarios.integration.ts`。

本地控制进程跨 CLI 调用存活，随机凭证仅留在权限受限的会话记录，本机 socket 权限为 0600，不开放网络监听。会话记录在 `test-results/agent/sessions/`；每次启动或重启创建新的 `test-results/agent/<runId>/`。重启保留初始 run 的 data 目录并提升 generation，旧证据不覆盖。共享 Electron 启动夹具位于 `apps/desktop/tests/support/electron.ts`，呈现 E2E 已使用同一入口。

停止只通过原应用连接请求正常退出，等待应用自身 drain；不强制结束业务进程。PID、创建时间或命令不符、控制连接丢失或停机超时均保持 unknown，不接管替代进程。停止回收控制连接和自有应用进程，隔离数据及证据继续保留，过期证据回收按任务 2.15 接入。单元检查使用 `npm run test:desktop-agent`；真实会话回归需先完成当前 build，再运行 `node --disable-warning=ExperimentalWarning --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types --test tools/desktop-agent/session.integration.ts`。

开发会话的启动身份与请求关联沿用统一日志，详见[日志因果、事件目录及完整性边界](../../docs/development/desktop-logging.md)。控制器注入实际 buildId／sessionId／runId；每个进程有独立代际和序号。界面请求只记录动作和受限业务 ID，后台轮询不冒用上一次点击，普通发行的高频只读调用使用 debug 级别。logs／diagnose 的查询范围和完整性说明见下文。

`logs --session <sessionId> --input 过滤参数.json --json` 读取本会话日志；支持 level（最低级别）、process、scope、requestId、operationId、limit 和 cursor。operationId 可查询业务 job／task／item ID 或状态事件中的物理关联。一次最多返回 200 条，扫描预算 2 MiB、输出预算 192 KiB；继续查询使用返回的 cursor。游标绑定会话密钥和过滤条件，可调整 limit，不能挪到其他会话或更换过滤条件。轮转按文件身份续读，历史删除／改写、超长行、部分写入及采集限流都有完整性标记。

`diagnose --session <sessionId> --json` 汇总受限只读业务查询、宿主进程列表、最近警告与异常采集；不直接打开运行中的业务 SQLite，不触发重试、补扫、复制或清理。分页摘要会标记截断，组件缺失返回 unavailable。诊断完成只说明查询已结束，`assertions` 始终标记未执行，不据此断言业务成功。

每个 run 自动保留 `observations.jsonl`，采集受信任主页面 pageerror、窗口崩溃、组件退出和日志文件失败；其他来源的登录窗口只记录不可观察，不采集其异常正文。未标记控制台不保存。采集队列最多 256 条、文件最多 1 MiB，丢弃数量和缺失总结均明确报告；正常停止保存 collector.json，异常退出不能假定最后记录完整。日志记录的 dropBatchId／dropReason 按批次分组，dropCount 取最大计数；batchComplete 为 false 时只是下界，不能重复相加。所有查询均保留 historyComplete=false，范围是当前可用历史或有界尾部。

`observe --session <sessionId> --json` 读取当前可信主窗口的归一化 ARIA 快照；参数 `{"mode":"windows"}` 只枚举窗口元数据。非可信窗口不读取标题、URL 和内容。多窗口时须明确 windowId，工具不会选择第一个。快照记录 sessionId／runId／buildId、windowId／窗口代际、文档身份／变化序号和几何状态；控件包含角色、可访问名称、状态、CSS 视口坐标及区域关系。输入内容统一遮罩，匿名控件保持不可操作；同名控件保留独立 ref 和 duplicateName 提示。

快照最多 4000 个节点并明确截断，每页默认 100、最多 500；继续查询使用 `{"snapshotId":"上一页身份","cursor":100}`，可带 regionRef 查询子树。焦点、dialog／alert 引用始终关联完整快照。控制器只保留最近 8 份可续用快照，归一化证据保存在本 run 的 `aria-<snapshotId>.json`，不保存原始 ARIA 数据。页面导航、重载、窗口替换／移动／缩放、焦点或 DOM 变化均拒绝续用旧快照；重新观察不会自动重放操作。嵌入页面及 `data-agent-sensitive="true"` 区域存在时整次观察受阻。语义观察不能代替原生验证。

观察参数 `{"image":true}` 同时取得关联截图，默认覆盖 CSS 视口；regionRef 对应元素的可见区域，也可使用 `{"clip":{"x":0,"y":0,"width":320,"height":200}}` 指定视口矩形，两者只能选一个。范围不完整可见时图片明确缺失，不自动滚动改变现场。`scale` 为 css（默认，每 CSS 像素一个 PNG 像素）或 device。工具保存 PNG 与 image manifest，返回真实路径、sha256、裁剪起点、像素大小、CSS 转换比例、页面 DPR、窗口 zoomFactor 和 deviceScaleFactor；页面 DPR 包含页面缩放，Electron device 截图使用显示设备比例，因此坐标转换必须使用实际 PNG 的 pixelsPerCss。

截图前后重新核对同一快照身份与几何状态，并对最多 6000 个 DOM 元素的位置生成布局摘要；超出核验预算会受阻。输入区域使用临时自有遮罩，图像采集失败或布局变化不保存无法关联的 PNG，仍保存 status=missing 及原因；完整性不能从命令 completed 推断。画布、二维码或敏感上下文禁止截图。此能力只捕获自有 Renderer 视口，不需要屏幕录制权限，也不代表菜单、系统对话框或其他原生窗口已验证。

`act --session <sessionId> --input 动作参数.json --request UUID --json` 使用当前 snapshotId 和 targetRef，或 `target:{"role":"button","name":"确认"}` 的精确语义目标；二者必须选一个。同名目标拒绝并返回候选引用，不选择第一个。控件必须有可信名称、可操作角色且可见／可用；scroll 可选择命名区域。当前支持 click、fill、select、check、key、scroll；fill／select 的 value 为字符串，check 为布尔值，scroll 方向为 up／down／left／right。key 只允许导航／编辑按键及 ControlOrMeta+A，坐标操作尚未接入。调用前核对当前构建及快照，页面重载后旧 ref 不会指向新的同名控件。

动作立即返回持久 jobId（同 requestId）；使用 `status --session UUID --input 作业参数.json` 和 `{"jobId":"原身份"}` 查询。先持久受理记录，再持久标记 sending，才发送输入；发送／等待超时返回 unknown，重复原请求只能续查，不再执行。不同参数复用请求 ID 会拒绝；重启后和停止后保留原收据。每会话最多 512 份收据，容量满时拒绝新动作，不自动淘汰确认身份。收据使用 HMAC 绑定请求但不保存输入明文或条件期望值。

动作可带 after 条件，例如 `{"target":{"role":"heading","name":"设置"},"state":"visible"}`；timeoutMs 默认 5000、最多 10000。独立 `wait` 同样需要当前 snapshotId、唯一目标和条件，等待期间允许同一文档内容变化，跨文档重载拒绝。条件包括 visible／hidden／enabled／disabled／checked／text／value；text 是包含匹配，value 是精确匹配，checked 使用布尔期望值。动作收据区分输入发送、界面条件、后续观察和业务断言；界面条件通过不代表持久业务已成功，businessAssertion 仍为 not-run。控件结果未知时应查询 diagnose／业务任务，不能再点一次确认。

DOM 变化判断会合并同一批次内原值重复写入及写后恢复，避免 React 重渲染临时修改 input name／type 导致误判；真实属性／文本／节点变化、输入及焦点事件仍使快照失效。快照过期原因只记录变化类别，不记录属性旧值或输入内容。动作要求实例 buildId 与当前成功构建相同，旧实例不能借用新清单验收。应用代码更新后可安全 restart；控制工具、契约或共享驱动更新后，旧控制进程仍持有旧模块，必须 stop 后新建场景，旧数据和证据保留。
