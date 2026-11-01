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

日常开发默认优先 `logs`、`diagnose` 和基于 CDP 的 `observe` 语义快照（默认 `image:false`），结合动作及业务后置条件验证；不强制截图。仅视觉问题或这些证据不足时显式请求图像，截图不可用只影响对应视觉项。原生流程优先记录 AX 语义和动作后置条件，录屏权限不是日志／CDP 开发的前置。

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

`act --session <sessionId> --input 动作参数.json --request UUID --json` 使用当前 snapshotId 和 targetRef，或 `target:{"role":"button","name":"确认"}` 的精确语义目标；二者必须选一个。同名目标拒绝并返回候选引用，不选择第一个。控件必须有可信名称、可操作角色且可见／可用；scroll 可选择命名区域。当前支持 click、fill、select、check、key、scroll；fill／select 的 value 为字符串，check 为布尔值，scroll 方向为 up／down／left／right。key 只允许导航／编辑按键及 ControlOrMeta+A。调用前核对当前构建及快照，页面重载后旧 ref 不会指向新的同名控件。

动作立即返回持久 jobId（同 requestId）；使用 `status --session UUID --input 作业参数.json` 和 `{"jobId":"原身份"}` 查询。先持久受理记录，再持久标记 sending，才发送输入；发送／等待超时返回 unknown，重复原请求只能续查，不再执行。不同参数复用请求 ID 会拒绝；重启后和停止后保留原收据。每会话最多 512 份收据，容量满时拒绝新动作，不自动淘汰确认身份。收据使用 HMAC 绑定请求但不保存输入明文或条件期望值。

动作可带 after 条件，例如 `{"target":{"role":"heading","name":"设置"},"state":"visible"}`；timeoutMs 默认 5000、最多 10000。独立 `wait` 同样需要当前 snapshotId、唯一目标和条件，等待期间允许同一文档内容变化，跨文档重载拒绝。条件包括 visible／hidden／enabled／disabled／checked／text／value；text 是包含匹配，value 是精确匹配，checked 使用布尔期望值。动作收据区分输入发送、界面条件、后续观察和业务断言；界面条件通过不代表持久业务已成功，businessAssertion 仍为 not-run。控件结果未知时应查询 diagnose／业务任务，不能再点一次确认。

DOM 变化判断会合并同一批次内原值重复写入及写后恢复，避免 React 重渲染临时修改 input name／type 导致误判；真实属性／文本／节点变化、输入及焦点事件仍使快照失效。快照过期原因只记录变化类别，不记录属性旧值或输入内容。动作要求实例 buildId 与当前成功构建相同，旧实例不能借用新清单验收。应用代码更新后可安全 restart；控制工具、契约或共享驱动更新后，旧控制进程仍持有旧模块，必须 stop 后新建场景，旧数据和证据保留。

图像坐标点击使用 act 的 `snapshotId`、`imageId`、`position:{"x":100,"y":50}` 和必填 after 条件，action 只能为 click，不能混入 target／targetRef／value。position 始终是这张 PNG 内的图像像素，从图片左上角计算；需要先用 observe image 取得并查看图片。只接受当前控制器登记的最近 8 张图片，图片 sha256、会话／运行／构建／窗口／快照和实际布局均须匹配。旧图片、文件改写、越界、窗口移动／缩放／重建、焦点或遮挡变化均拒绝；命中输入、敏感或禁用区域时改用语义控件。

坐标收据保留动作前图片、CSS 位置、原生屏幕 DIP 换算、显示比例和动作后语义／图像证据；后置条件未成立时保持 unknown，采集失败标明 missing。输入范围始终是 Renderer 视口，nativeInputSent=false。后台模式记录 background-virtual，不向其他应用或屏幕位置发送鼠标事件；前台额外通过 macOS helper 的只读窗口次序、焦点与遮挡元数据核验，helper 绑定自有进程及内核创建代际，不读取其他应用标题或画面。锁屏／非交互桌面返回 NATIVE_SESSION_LOCKED，doctor 同步报告；前台操作不会自动激活窗口来执行旧坐标。原生截图仍单独依赖录屏权限，后台通过不能代替前台或 OS 原生验收。

前台目标点使用系统 AX 的窗口 Z 序命中测试，返回 pointOwned 与 hitTest；命中的进程和窗口几何必须属于当前实例。window-rectangle 的相交信息单独保留为 rectangleOverlap，避免高层窗口的大范围矩形导致误判。命中其他应用时只返回不属于目标，不读取其名称、控件或画面；同一应用的其他覆盖窗口也不能冒充原窗口。此项保护验证的是本次坐标的输入归属，不表示整个窗口没有任何矩形相交。

统一证据索引的基础 API 位于 evidence-model／store／artifacts 模块，包含格式与摘要校验、跨进程写入权、证据关联和原始失败保留；未采集类型有显式状态，健康读取不将断言标为通过。该索引尚在任务 2.14 接入运行器、reporter 和 trace，当前不能据此声称每个会话已自动生成完整 manifest，collect／导出也尚未接入。

macOS helper 构建使用 `npm run desktop:agent:native:build`。构建生成私有 native-manifest.json，绑定 native 根目录的 Swift 源码、构建器、平台和二进制摘要；doctor 与原生调用均校验，源码改动后须重建，不能沿用旧二进制。固定命令不接收任意脚本，内核创建代际和隔离 profile 必须属于本会话。原生捕获只接受本次观察中的自有窗口，截图前后指纹须一致；输出只写会话内新 PNG，链接、越界及覆盖均拒绝。激活是显式动作，不会为旧坐标自动抢焦点；锁屏时输入和捕获受阻。系统 Apple 菜单不开放控制，其他应用和未知面板不作为可操作目标。当前菜单／面板和发行资源的完整验收仍见 OpenSpec 2.12／2.13，不能仅凭 capability=true 判定通过。

控制器会自动写入 `test-results/agent/<runId>/manifest.json`，登记构建、场景、复现、ARIA／图片及坐标侧车、动作、只读诊断、关闭时日志尾部与采集器结果。默认 historyComplete=false，业务断言保持 not-run；采集失败单独登记并返回 missing，不覆盖启动／崩溃原失败。动作最终状态在证据处理后发布，后续生命周期请求不会因这一段收尾而误报 busy。restart 为新 run 建立索引，旧 run 不覆盖；截图返回的 evidence 字段说明是否已登记，不能仅以 PNG 文件存在推断索引完整。Playwright reporter 和 trace 的接入仍属于未完成的 2.14。

结果 reporter 通过 `media-marshal.run` 注解中的 runId／sessionId 关联已登记上下文，保留断言、超时／中断、启动失败和跳过状态，原始错误和断言值不进入汇总。TraceSession 是内部驱动 API，默认 sensitive 不录制；safe-synthetic 只供受版本管理的无账号流程，敏感转场丢弃整个录制段。敏感输入前 await discard，关闭 context 前 await stop；正常停止的 ZIP 才登记为 available。`reporter-probe.config.ts` 是显式失败采集探针，必须由对应 integration 验收调用，内部失败不作为产品测试通过。主测试入口及全体手动上下文迁移仍在 2.14 中继续。

主测试配置现已启用 reporter，所有手动 Electron E2E 使用 `apps/desktop/tests/support/test-electron.ts`；Node 控制协议仍不提供任意 evaluate、SQL 或 IPC。`test:desktop` 先构建当前源码并保存指纹；`test:packaged` 默认先构建当前目录包、检查资源，再运行用例，可追加用例筛选。显式安装路径必须匹配本轮目录包的全体文件、摘要和内部链接；历史安装夹具单独声明目标局部身份，不认领当前源码构建。CLI 场景、E2E 的 test-fixture 和纯结果 test-result 有独立标签。

actions.jsonl 区分工具动作收据与测试 API 步骤摘要，后者不冒充逐条业务提交；两者均不记录输入值，容量耗尽或未知写入权返回缺失。完整 trace 只供受版本管理的无账号合成流程，默认敏感上下文阻断；包括 iframe 的来源不确定会丢弃整段。关闭前健康查询的 150ms 预算不改变应用退出期限。新 runId 不复用旧目录，旧图片／断言文件不覆盖。2.14 已完成；前述阶段性“尚未接入”说明保留为实施历史，当前未完成的是 2.15 导出过滤、固定失败和自动回收，以及原生前台剩余验收。

证据导出使用 `collect --session UUID --input 导出参数.json --json`，或在输入中指定 `runId` 读取该会话的历史运行；同时指定时必须属于同一 session。`kinds` 可选择 build／scenario／action／log／health／aria／image／trace／assertion／observation／reproduction，省略时选择全部。`pin:true` 固定该运行和它的导出包，`pin:false` 显式解除；省略 pin 保持原值。断言、启动、崩溃或采集失败自动固定，后续新失败会再次固定。完整性以 result.complete 和包内清单为准；省略、受阻、截断或未采集项使 status=partial，CLI 退出码为 2，但保留可用包路径。historyComplete 始终为 false，不能据此宣称完整业务历史。

导出包只包含选中且已登记、摘要未变的结构化证据，以及带遮罩／合成声明、窗口与快照关联的 PNG；完整 trace 还必须来自 safe-synthetic 上下文。未知旧图片／trace 留在本地并明确省略。JSON／JSONL 清除 Cookie、Authorization、令牌、秘密输入及私人路径；trace 在有界解压后复核敏感标记和条目路径，命中则整段拒绝。单文件最多 16 MiB、单次导出净内容最多 64 MiB；归档最多 512 项、解压总量最多 64 MiB。不会打包数据库、凭据配置、任意 userData 或自动上传。包保存在 `test-results/agent/exports/`，带登记侧车、字节数及摘要。

`gc --input 回收参数.json --json` 默认执行回收；`{"dryRun":true}` 仅给出计划。默认保留 7 天，证据预算为 500 MiB；达到预算时限制新增采集，不自动删除固定失败。预算统计 UUID 运行目录的直接文件及 exports，运行资料子目录和 builds 不计入证据配额，也不由此清空。回收只删除终止运行中已登记、普通、非链接、摘要仍一致的文件及登记导出包，保留 manifest、原失败、未登记文件和运行资料。活跃或未知写入者、未知所有权、固定运行和变化文件均保护；空间仍不足返回 blocked。结果明确列出预算范围、回收量和受保护项目，runtimeDataDeleted=false。

采集与导出先在跨进程锁下预留容量；观察事件有独立上限，控制元数据预留少量余量，以便空间不足时仍能保留失败与缺失原因。写入者登记使用 PID／创建时间／命令摘要，不保存原始参数；回收不接管或终止这些进程。已回收运行不能继续补写成新成功记录。trace 先收口到工具新建的临时目录，核实大小并取得证据预算后才落入运行目录；临时目录由本次调用清理。

同源扫码／画布、iframe 及显式敏感标记由 DOM／截图／trace 共用规则阻断。完整 trace 录制前安装页面守卫，短暂敏感节点或敏感转场也丢弃整段；守卫安装失败不开始录制，收口前再次核对。守卫只通知敏感状态，不读取或传出账号内容。原阶段中关于 2.15“尚未接入”的描述为实施历史；当前 collect／gc 已接入，具体验收见桌面重构验证记录。

故障场景使用 `scenario --input 故障参数.json --json`，参数示例为 `{"mode":"fault","fault":"http-timeout","seed":"复现编号","repeat":2}`。`scenario list` 返回版本化的六类故障定义、固定测试文件／用例、正常阶段和实际替身。fault 只允许 http-timeout、http-rate-limit、component-exit、volume-unavailable、same-name-replacement、post-publish-accounting；不接受任意文件、命令、脚本、SQL 或产品注入标志。repeat 为 1–3，默认 2；seed 是复现标记，测试输入来自版本管理中的固定夹具，运行目录与随机身份各自独立。

故障命令立即返回 jobId／runId，随后以 `status --input 作业参数.json --json` 和 `{"jobId":"原身份"}` 查询，不指定 --session。相同 requestId 续查原作业，不重复注入；参数不同则拒绝。每轮 on 执行原故障断言、off 额外执行无故障的正常用例。HTTP、卷与组件退出用例还在原进程／原对象中核对恢复，正常阶段不代替这些恢复断言。每阶段结果先保存，再运行下一步；测试退出、目标缺失／跳过、输出超量、超时或构建／源码变化均不能计为通过。未知结果停止后续重复，原失败不会被正常阶段覆盖。

故障发生在隔离测试进程、回环 HTTP 服务、新建目录／SQLite 或测试注入端口内；没有产品环境变量或发行注入入口。进程退出只作用于用例新建的已核验子进程；未知身份不强杀。测试原始控制台、断言值及错误正文不进入汇总，保留稳定用例 ID、状态、耗时、可取得的源码位置、固定原因和复现入口。Node 的位置标为 test-registration，Vitest 的位置标为 assertion-stack；不可取得时不伪造行号。标准差异比较在 verify 中接入前明确为 standardsComparison=not-run。检查 run 的 GUI／原生验收范围单独声明，核心替身与后台通过不等同于真实账号、真实卷卸载或前台 OS 验收。

`verify --json` 默认仅生成检查计划，按真实 Git 基点、暂存／未暂存及未跟踪差异计算，输入 changedFiles 仅补充提示。baseRef 默认 HEAD，只接受本地已有 commit／分支；无法核实则受阻，不自动 fetch 或忽略基点。未知路径或清单截断回退当前桌面全量；共享契约／工程配置扩大范围；纯文档不默认跑媒体业务。计划列出每项理由、需要的构建及验收文件变化，status=planned、execution=not-run、allPlannedChecksPassed=false；文件级差异不证明语义等价，也不自动接受新基线。追加 `mode:"run"` 执行固定检查目录，立即返回 jobId／runId，随后用不带 --session 的 status 和 `{"jobId":"原身份"}` 续查。相同 requestId 不重跑，变更参数须使用新身份；空计划不会标绿。

性能入口为 `npm run --silent desktop:benchmark -- --json`，要求当前 packaged 构建；默认前台，锁屏时明确受阻。追加 --background 显式选择后台启动／导航／CPU／内存／队列及包内解析器范围，前台窗口唤起记录为 not-run。所有应用样本使用新建临时资料、独立 runId，复用同一资料目录时递增代际，记录关联到汇总 run；截图／完整 trace 按性能采集策略阻断。开始及结束核对源码与目录包，旧报告不覆盖；结果中的 reportPath 指向本轮证据。completed 表示所选指标已测量，性能回归仍为 not-evaluated，没有人为达标阈值。未知写入者的临时资料保留供诊断，实际设备和样本见验证记录。

`verify` 执行前要求工具／桌面／原生项的当前 development 构建，以及目录包／性能项的当前 packaged 构建；缺失或过期时逐项 blocked，修复命令仍为 build，不自动运行旧产物。纯类型、架构、文档和规格检查不要求 GUI 构建。执行使用固定命令与测试文件，不接受任意脚本、SQL 或命令输入；按检查组保存理由、阶段命令、耗时、退出码和测试数量。Node TODO／跳过／空测试、Playwright 跳过／重试、结果缺失均不能计为通过；原始断言正文、控制台和敏感标题不写入汇总。单阶段输出上限 1 MiB、机器结果 32 MiB，超时／超量为 unknown。

每轮 verify 有独立 manifest，构建清单、计划与复现入口、逐组断言及最终报告分别登记，失败自动固定。构建指纹之外还核对真实 Git 差异、文档、断言和未跟踪文件的内容与变化时间；受理后或运行中变化、证据登记失败不能标绿，之前的断言失败保持 failed。结果保留 not-run 和 blocked；`allPlannedChecksPassed` 只在非空计划全部实际通过且身份未变时为 true。验收标准文件包含开发驱动与 benchmark；comparison=file-diff-only、semanticEquivalence=unverified 不会自动批准标准变化。工具回归包含后台协议／驱动集成；OS 前台能力单列，现有 helper／坐标检查通过仍不能代替待完成的菜单与目录面板验收。

验证输入 `{"mode":"run","baseRef":"HEAD","benchmark":true}` 会把当前设备的后台性能采集纳入计划，关联独立 benchmark runId／buildId／reportPath。后台测量范围和前台 not-run 保留，passed 仅表示测量完成，performanceRegression 始终 not-evaluated。默认不执行推荐项；未知路径的全量回退包含性能和 native，权限或未完成验收会明确受阻。verify 不自动接受视觉基线、不清空用户状态、不变更系统权限、不 push 或发布。

需要同时保有两类当前产物时，先 build packaged、再 build development；目录包准备会重生成开发态共享原生资源，旧 development 清单可能过期。Playwright 检查遇到首个失败停止，剩余用例保持未运行／跳过；全量桌面阶段预算 45 分钟，单个用例的断言、等待和超时仍由原测试控制。非零退出后机器结果缺失仍保留 failed，零退出但没有可信结果为 unknown。
