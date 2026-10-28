# 独立桌面客户端开发

桌面迁移采用 npm workspaces：`apps/desktop` 负责 Electron 宿主、最小 Preload、Utility Process 入口和 React；`packages/contracts` 定义普通数据与严格动作；`packages/media-core` 负责框架组装和 SQLite。迁移范围及旧行为证据见[迁移基线](./desktop-migration.md)。

旧 `backend/`、`frontend/`、`parser/` 和 Docker 入口仍独立使用。客户端构建不运行 Maven、不引用 Vue、不打开旧数据库。不要通过个人目录或全局软链接接入应用依赖。

## 环境与命令

使用 Node.js 22.12+ 和 npm。工作区首次安装：

```bash
npm ci
npm run typecheck
npm run check:boundaries
npm run check:framework
```

开发和构建：

```bash
npm run desktop:rebuild
npm run desktop:dev
npm run desktop:build
npm run test:electron-node
npm run test:desktop
npm run desktop:pack
```

Mac 首次运行测试前，先执行 `npm run desktop:prepare-native-files`。它使用锁文件已有 node-gyp 从 Electron 官方地址校验并缓存当前版本头文件，再通过 Xcode Command Line Tools 编译修正所需的 Node-API 原语；其他平台的该组原生测试按条件跳过。随后执行 `npm test`。当前原语已连接 Core 单条／批量修正服务、Main 资源准备、worker 私有注入、客户端页面及 arm64 安装包，输出位于 `build-artifacts/desktop-files`；Intel 运行和正式签名仍分别验收。

原生模块需要匹配目标平台、架构和运行时。`npm test` 通过仓库运行器使用 Electron 内置 Node，`test:electron-node` 是兼容别名；SQLite 二进制必须先匹配桌面 ABI。当前 SQLite 包提供平台预编译文件，产物检查核对它在 ASAR 外可用，实际加载仍以窗口测试为准。不要用另一系统 Node ABI 直接加载已经重建的 SQLite 模块。`desktop:build` 只编译，不启动旧服务。

Mac 的 `desktop:build` 及 `beforePack` 准备 Node-API 8 安全修正组件，需 Xcode Command Line Tools；运行中的应用不下载或编译原语。Main 从当前架构开发目录或 ASAR 内清单计算可信摘要，Core 校验 ASAR 外模块后加载，`runtime.get.correctionFiles` 可查询可用性。按架构资源、源码／许可和完整性验证命令见 `tools/desktop-files/README.md`；x64 交叉编译不作为 Intel 运行验收。

`desktop:pack` 生成当前系统的应用目录包；正式 DMG/NSIS、签名、公证和其他架构须在对应目标环境验收。未配置开发者证书时的本地原型可使用 `CSC_IDENTITY_AUTO_DISCOVERY=false npm run desktop:pack`，该产物不能作为正式发行完成的证据。运行已打包的应用测试时，将 `MARSHAL_APP_PATH` 设为可执行文件并使用 `MARSHAL_EXECUTABLE=1`；具体路径以构建输出为准。

当前平台目录包可直接使用 `npm run test:packaged` 验证，它先检查许可、原生库和框架来源，再运行真实窗口测试。`.github/workflows/desktop-prototype.yml` 预置 macOS arm64、macOS Intel 和 Windows x64 矩阵；尚未远端运行时不能据此宣称三平台通过。

实际只读 DMG 的验收需让 `MARSHAL_APP_PATH` 和 `MARSHAL_ARTIFACT_RESOURCES` 指向同一个映像内的可执行文件与 Resources，并显式设置 `MARSHAL_INSTALL_MATRIX=1`。`installation.spec.ts` 验证 EROFS、系统 PATH、中文／空格安装位置、覆盖安装和卸载重装；提供历史实际 DMG 的 `MARSHAL_PREVIOUS_APP_PATH` 后另验手动升级及旧库备份。未指定安装态入口时这组用例跳过，不能将目录包回归计为映像验收。命令、结果与边界见 [Mac 安装态验证](./mac-installation-validation.md)。

## 框架与模块约定

采用公开 npm 包 `@yeatz/app-framework@0.1.0`，精确版本与内容由根锁文件固定。注册表已可取得该版本，因此按技术方案的发布后路径直接接入，不创建 vendor 源码副本。`apps/desktop/resources/framework-origin.json` 保存 npm integrity 和源码评估引用；许可随应用资源保留。

`npm run check:framework` 核对版本、来源、依赖可解析性、公开入口、同版本 React／React DOM 和 MIT 许可，拒绝个人路径与跨仓链接。`npm run check:framework -- --verify-contents` 在独立临时项目中禁用安装脚本，取得固定 npm 包并复核 integrity，再逐文件比较当前安装内容；临时项目随后清理。`npm run desktop:pack` 先执行完整内容核对，失败则不开始打包。首次核对可能需要连接 npm 公共注册表，不改变项目依赖。

升级框架时显式修改工作区精确版本、锁文件和来源清单，重新执行内容、DI、React 与生命周期检查，并重新打包。修改上游源码不会替换当前发布包，不使用跨仓链接把源码变更混入产物。来源评估 commit 与 npm integrity 分别追踪，未将缺少 gitHead 的发布包宣称为该 commit 的可复现构建。2026-10-25 对固定 0.1.0 的 74 个文件逐字节核对通过。

- Main：`desktop.host`、`desktop.credentials`、`desktop.core`、`desktop.bridge`、`desktop.windows`。
- Core：`media.storage` → `media.services` → `media.commands`。后续业务模块按迁移矩阵扩展，storage 最后释放。
- Renderer：`renderer.desktop-client` 提供受限接口，runtime/sources/tasks/settings 模块绑定各自 StatefulService。
- Preload 只导出明确方法，不创建 Application；领域纯函数与 contracts 不依赖框架。

legacy 装饰器由 TypeScript 统一转换，参数使用显式 `@inject(Token)`。Vite 与 Vitest 共用转换插件，避免编译器默认装饰器语义不同。不得使用框架的深层源码入口或全局命令容器。

来源表单草稿由路由上层 React Provider 持有，来源 ViewModel 只保存核心 DTO、操作反馈及 computed 投影。使用公开 `useService`／`useServiceState` 读取；框架 computed 为不可枚举 getter，组合组件草稿时显式投影，不能用对象展开假设它们会被复制。页面卸载释放订阅和轮询，根卸载解除草稿绑定并使旧查询失效；不停止组件树外共享的 Application。

设置查询分别核对请求与页面代际，保存前使旧读取失效，写入期间不发布旧 DTO；离页后的迟到结果不更新视图，重新进入仍只查询核心。地址草稿在 React 按字段记录是否编辑，保存密钥或刷新连接状态不覆盖未保存地址。已提交的保存仍由核心完成；Renderer 停止后不续发读取或接受新保存。

### Renderer 受控重载

「视图」中的普通／忽略缓存重载及 Command+R、Command+Shift+R、F5 经过固定生命周期握手。Main 只接受当前受信任主窗口、原顶层 frame 和本次随机标识的严格收据，不接受任意动作、路径或错误原文。Preload 只允许注册一个本地异步清理回调，不向 Renderer 暴露通用事件或 IPC；回调不经过进程边界。

Renderer 先卸载 React 根，再等待 `Application.stop()`，并发停止共用同一个 Promise。页面卸载取消的扫码请求与服务清理共用回执，应用停止会等待该回执，迟到登录响应不续发查询；已持久化的授权或媒体作业继续由 Main／Core 持有。清理成功后 Main 才调用 Electron 的刷新 API，Core、SQLite 和后台作业保持原实例。清理失败或十五秒超时不强制刷新，显示退出并重开的动作；旧收据不能完成新请求。导航、窗口销毁和进程中断使原握手失效。只有 Electron 已报告 `isCrashed()` 时才独立恢复界面，不把超时当成崩溃。

HMR dispose 在异步启动完成前登记并记录清理 Promise，新模块在创建 Application 前等待上一代完成。启动期间被替换的一代等待已取得资源落定并清理，不再挂载旧页面；若受控重载已开始则不再启动一代 HMR 容器。没有依赖异步 unload 或 beforeunload 完成清理。普通页面刷新和进程强杀属于独立恢复路径，不冒认为受控清理成功。启动／替换交错使用受控 Promise 门验证，未宣称真实 Vite HMR 事件的专项验收。

Electron 的 [before-input-event](https://www.electronjs.org/docs/latest/api/web-contents#event-before-input-event) 用于阻止默认快捷键并路由受控请求，[IpcMainEvent.senderFrame](https://www.electronjs.org/docs/latest/api/structures/ipc-main-event) 用于核对发送 frame；实现同时按当前安装的 Electron 类型编译。自动化通过 Electron 菜单回调和输入端口验证接线，不表示已覆盖 OS 原生菜单点击与系统快捷键分发。

2026-10-26 本阶段全量 784 passed／13 skipped，类型、边界及框架来源检查通过。当前构建的两项窗口检查验证任务分页／筛选与识别字段 DTO 在 Core 重启及界面重载后恢复，不创建新文件作业；最终 arm64 未签名目录包另通过六项窗口检查，覆盖两类受控刷新、强杀 Renderer 恢复、主窗口销毁重建、同一 Core PID、草稿版本与作业数不变，以及设置草稿、来源表单、沙盒与运行偏好。React 根卸载及延迟清理、启动交错、扫码取消、旧请求、frame／nonce、失败和超时使用定向测试核对。源码、ASAR、截图及范围映射见 `tools/desktop-files/fixtures/mac-renderer-lifecycle-2026-10-26.json`；[实际已保存草稿恢复截图](/desktop/renderer-source-dto-restored.png)对应从 Core 读回的表单。7.7 据此完成；Intel、正式签名、完整 OS 安装与原生菜单验收仍由各自任务记录。

## 请求等待与执行所有权

固定公共动作先按 contracts 校验，再映射到已注册的 `media.<action>` CommandService。框架的 `{ timeout: 0 }` 只用于静态命令查找；真正的执行等待由 Core 的 `RequestExecutions` 管理，默认十五秒，最多同时持有六十四项公共／私有执行。同一正在执行的请求 ID 不能再次进入。参数和未知动作在取得执行名额前即失败。

Main 的等待期限或内部 `AbortSignal` 结束时，通过本次请求的原 MessagePort 发送严格的 `core.request.cancel` 收据，只包含协议版本、请求 ID 和 `TIMEOUT`／`INTERRUPTED` 原因。Worker 验证后结束对应请求的等待；Renderer 的业务 API 不接受该收据，不提供任意 action、channel 或通用取消入口。发送前取消不会发出原动作；正常响应、超时、取消及核心退出均清理 Main 定时器和信号监听。

结束等待不会取消持久化的下载、识别、COPY 或修正作业，也不会回滚已保存配置。底层请求尚未完成时仍占用 Core 执行名额，迟到成功或失败只完成资源回收，不再次返回页面结果；作业状态继续由原业务服务保存。独立业务取消沿各自受限动作和安全点处理。退出先停止接入和等待，再协调业务所有者、排空真实在途执行，最后停止 Application 并关闭 SQLite；不能只等待已提前结束的页面响应 Promise。同步 SQLite 或原生调用无法被 JavaScript 定时器抢占，宿主最终退出期限仍负责强杀与后续恢复。

长文件工作的持久作业接口和调度由下载、内容复核、识别批次、整理批次及修正服务持有。手动 `ingestion.scan` 也先落库并返回扫描作业 ID，目录枚举由来源扫描所有者在后台执行；`ingestion.scans` 和 `ingestion.scan-job` 查询历史、等待原因及分页问题。详情见[持久手动补扫](./source-rules.md#持久手动补扫)。请求期限控制等待，持久作业负责实际进度与恢复。

当前长执行入口与持久身份对应如下；普通状态查询和有界元数据预览继续受请求期限管理，文件读取、枚举和执行不依赖页面 Promise 的存活。

| 工作 | 立即返回的身份 | 后台所有者 |
| --- | --- | --- |
| 本地目录手动补扫 | `ingestion.scan` 的扫描 ID | SourceScans，复用 IngestionPipeline 的来源内扫描 |
| 全量内容读取复核 | `ingestion.review-content` 的复核 ID | ContentReviews |
| 单文件／批量识别 | 任务 ID／识别批次 ID | IngestionPipeline／RecognitionBatches |
| 批量整理预览与确认 | 整理批次 ID | OrganizeBatches |
| 单文件 COPY | `ingestion.confirm` 的 operationId | IngestionPipeline |
| 显式授权后的新候选自动整理 | 候选查询中的自动意图 ID | Pipeline 持有 AutomaticIngestion，复用原识别／预览／确认及文件作业 |
| 单条修正预览与确认核验 | CorrectionPreparation ID | CorrectionPreparations |
| 同季／同剧修正 | 修正批次 ID | CorrectionBatches |
| 网盘范围预览、下载和周期扫描 | 预览、下载作业和来源运行 ID | DownloadPreviews、CloudDownloads、SourceRuns／CloudSubscriptions |

2026-10-26 请求等待阶段：全量 807 passed／13 skipped，定向 48 项通过；类型、边界、文档与 OpenSpec 严格检查通过。真实 Utility Process 使用隔离数据库及受控延迟的宿主 RPC，验证非法取消收据被忽略、合法收据立即结束等待、原工作继续占用并发范围、迟到结果不重复返回、实际十五秒执行期限和原授权作业 ID 保留。最终 arm64 未签名目录包通过该用例、受控重载和升级备份恢复共三项检查。宿主响应为测试替身，未访问个人账号或媒体，不作为真实网盘网络故障及安装态矩阵的证据。源码、ASAR 和端口结果见 `tools/desktop-files/fixtures/mac-request-executions-2026-10-26.json`。

2026-10-26 schema v26 补扫闭环：全量 823 passed／13 skipped，九十二个公共动作的静态注册审计通过；类型、边界、迁移保留／回滚、文档和 OpenSpec 严格检查通过。开发构建通过三项窗口检查，最终 arm64 未签名目录包通过补扫、内容复核、目录健康、真实 Utility Process 请求期限／取消及升级恢复共五项检查。补扫实际文件权限问题、来源暂停、Core 重启、历史保留、长中文名称和最小窗口得到验证；原文件内容及 inode 保留，没有创建识别、下载或 COPY。原目录枚举后被替换、共享根按需求汇总、迟到读取、停止排空和分页由隔离 Core／组件用例验证。系统选择器和宿主 RPC 为受控入口，不替代原生 OS、真实网盘、Intel 或签名安装态矩阵。源码、ASAR、截图及 2.9 的对应证据见 `tools/desktop-files/fixtures/mac-source-scans-2026-10-26.json`；2.9 据此完成。

## 运行与数据

页面使用 `marshal://app` 协议。Main 校验顶层 frame、来源、动作和参数；目录保存还要求通过原生目录对话框取得授权。Core 再次核对真实路径、目录关系与权限。Main 与 Renderer 不打开 SQLite。Main/Core 通信使用私有 MessagePort，端口断开后 Core 安全退出；媒体业务不开放 HTTP/WS 服务。新增受管网盘组件的授权回环接口及凭据副本边界见仓库中的 `openspec/changes/archive/2026-10-27-add-local-desktop-emby-ingestion/design.md`，尚未验收的能力不视为当前可用功能。

桌面数据位于 Electron 用户数据目录的 `desktop.sqlite3`，敏感凭据单独由 safeStorage 保护；查询不返回密钥。测试只使用临时数据目录。数据库使用 `user_version`、短事务和升级前 SQLite backup；未知或更高版本停止写入，旧 Java 无版本表不会被接管。

当前 schema v30 为重新登录后的网盘历史增加待核对定位线索及明确确认，确认绑定本次授权与目录预览，并与来源配置原子提交；v29 的成功收据、不可变文件证据和本地现状观测继续保留；普通扫描不补回已成功但本地移除的同版本副本，显式重新下载仍须预览。v28 追加的同步／识别配置投影继续保留，保留旧配置及活动计划，不启动文件操作；默认下载目录等待用户选择，自动策略重新授权，新入口及运行行为由后续任务接通，见[来源配置迁移](./source-rules.md#schema-v28-的追加迁移)。v27 增加的首次自动授权和持久自动意图继续保留，旧 v27 及更早 Core 拒绝新库；迁移不登记自动作业。v26 的手动补扫意图、幂等收据和逐项问题继续保留。v25 的本地来源版本化目录健康快照继续保留。v24 的同季／同剧批量修正冻结范围、成员、预览和确认收据继续保留；v23 的修正预览／确认持久后台核验继续保留，停止等待不撤销文件作业；v22 的修正预览、确认收据和历史操作继续保留，Emby 交付可引用 COPY 或修正二者之一。v21 的不可变逐文件计划与位置占用继续保留。Core 单条与批量修正服务已接入内部命令及 Main／worker／Preload，arm64 目录包资源、单条和批量页面已接入，完整安装态仍待完成；迁移不会自动搬动媒体。v20 的持久批量整理预览、成员与确认收据继续保留；v19 的批量识别意图与逐项提交记录继续保留；v18 的人工识别字段、匹配版本和编辑请求收据继续保留；v17 的来源可恢复删除及生命周期并发检查继续保留；v16 建立的本地资产当前版本约束和持久内容复核作业继续保留；v15 建立的恢复后媒体核对队列继续保留。首次、手动和自动启动 Core 共用备份检查，失败不能通过重启绕过；整包恢复先处理日志，再复核下载成果及已整理主文件／附属文件。WAL 与中断的具体保证见[升级备份与恢复验收](./mac-upgrade-recovery-validation.md)，内容复核见[整理流水线](./desktop-ingestion.md#本地资产版本与全量内容复核)。

长任务必须返回持久化作业 ID。框架 CommandService 的注册等待超时不代表执行取消；业务请求和文件任务的取消分别实现。退出先阻止新接入并等待受管操作安全点，再清理框架和数据库。窗口关闭保留托盘，显式退出才停止应用。

退出期间的异步启动会在取得资源后重新检查停止状态，不能在升级检查或窗口加载结束后继续拉起 Core；迟到握手也不能触发凭据注入。Main 并发停止扫码、账号接入与 Core，避免授权作业等待已停止核心。Core 的幂等停止先关闭新命令和领取，取消网络、parser 及宿主响应等待，等待在途工作落到持久化安全点，再调用 `Application.stop()`。框架启动失败的 abort 同样触发这条取消路径，清理失败仍继续释放其他资源并返回可观察错误；数据库在其使用者之后关闭。取消宿主等待不作为写入者已停止证明，Main／Host 仍须确认回收后才允许新核心取得写入权。

### 核心与解析器恢复

Main 取得单实例锁后才组装应用，重复启动唤起已有窗口。核心握手最多等待十五秒，协议不符或超时即停止该实例；旧进程仍未退出时拒绝另开核心。异常退出立即将所有等待请求标记为中断，随后等待云端宿主完成写入者回收；停止证据不确定时阻断自动恢复。正常回收后最多自动恢复三次，间隔一、二、三秒，耗尽后保留失败状态，等待用户显式重启。重启不重放原变更请求，只恢复持久化记录和必要授权。

冻结 parser 使用独立 stdio 握手和单通道请求关联。单请求默认五秒超时；超时、取消或非法输出后先关闭旧进程，必要时强杀并确认退出，下一请求才可启动新实例。一个 Core 生命周期内同样最多恢复三次，队列最多三十二项。解析器只接收名称文本，拒绝路径与任意命令。关闭 Core 的父端口会沿 stdio 清理 parser，不按进程名回收。

Main 收到 resume 后先通过私有动作重置就绪观察，再恢复目录、账号及周期调度；该动作不向 Preload 开放。主文件和附属文件同时检查单调时钟与墙上时钟的间隔，任一时钟倒退或停顿超过三十秒都重新观察，稳定性仍以至少一百二十秒连续观察判断。Core 重启也清空观察缓存，已处理记录保持。任务页重载只重新查询持久记录。固定时钟及受控 resume 事件用于回归，不将其描述为真实整机休眠验收；真实休眠仍由 9.1 的环境矩阵记录。

2026-10-25 的六项 Core 故障单元与七项 parser 管道测试通过；真实 Electron 补充强杀核心、恢复同一持久草稿、原解析器退出及不产生执行来源的检查通过。握手与重试上限采用可控时钟及受控进程替身，真实强杀另使用 OS 创建时间和完整命令核验进程归属，二者证据分别记录。

2026-10-26 进一步使用实际冻结 guessit 做持续 SIGSTOP 检查：核对本测试父子进程与 OS 停止状态后，使用默认五秒期限等待 TIMEOUT；旧解析器由生产 `ParserProcess` 回收，下一名称在新的 PID 解析成功，关闭后新旧进程均不存在。成功路径不发送 SIGCONT，也不由测试代杀；失败清理仅针对身份核对后的自有进程。八项 parser 管道测试全部通过，全量为 887 passed／13 skipped，复验为 `npm test -- packages/media-core/src/infrastructure/parser-process.test.ts`。证据摘要见 `tools/desktop-files/fixtures/mac-parser-timeout-2026-10-26.json`。这项证据来自本机 arm64 冻结组件，缺少该二进制或非 macOS 时会跳过，不代表完整应用安装态、Intel 或真实登录启动已经验收。

## 本机运行设置与许可读取

运行偏好由 Main 的 `HostPreferencesController` 独占，不进入业务 SQLite。`host-preferences.json` 只保存版本及首次关闭提醒，以 0600 临时文件独占创建后原子替换；登录项不保存第二份权威副本，以 Electron 系统 API 当前状态为准。默认不注册，只在用户明确保存且状态需要改变时调用系统设置；待批准单独展示，读取、窗口重载和启动不注册。开发构建及未支持平台拒绝注册请求。保存失败时核对登录项回退结果，不能将未确认回退报告为成功；退出／维护阻止迟到保存并等待在途落盘。

关闭窗口仍保留托盘。提醒开关只控制每次启动后的首次说明，不改变后台语义。Main 查询返回托盘是否已就绪；真实原生菜单、注销登录与完整生命周期仍按 2.6 的 OS 验收另行记录，系统 API 替身不作为这些证据。

托盘菜单与原生「任务」菜单共用两项独立的复选控制：「暂停全部整理」和「暂停云端下载」。Main 的 `NativePauseControls` 只投影 Core 保存的状态，通过现有固定业务动作读写，不保存第二份权威配置，也不增加 Preload 通道。启动、打开菜单、页面修改暂停、Core 恢复及十秒轮询会重新读取；并发读取合并，旧代际或旧读取结果不能覆盖新写入。状态未知时禁用对应控制并解释原因，另一项已核对的控制仍可使用。

每次明确点击只提交一次带幂等键的意图，同一项在途时禁止重复点击。失败立即显示受限错误，并在当前 Main 生命周期保留「查看上次控制问题」入口；随后只读回查，不能以响应丢失推断事务未提交，也不自动重放写入。成功回查清除读取问题，保留原写入问题供核对。退出和升级维护先冻结控制，再等待真实在途读写与 Core 停止；不将页面等待结束视为文件任务已取消。

2026-10-26 原生暂停阶段：全量 884 passed／13 skipped（包含九项控制器用例），开发构建五项窗口、最终 arm64 未签名目录包七项窗口及 9534 个 ASAR 条目检查通过，类型和依赖边界通过。窗口检查覆盖页面／菜单同步、窗口隐藏、重载、Core 与应用重启，实际 SIGSTOP 后的十五秒请求期限、错误即时反馈及无自动写入重放。退出在途用例会在 500 毫秒后恢复被暂停的自有 Core，不能作为永不响应 Core 的强杀保证。

同一目录包另经普通启动的真实 macOS「任务」菜单点击、两次系统目录授权、首次关闭提醒、留在后台、重复启动唤起及原生退出菜单检查；后台测试文件的候选创建时间早于重复唤起，原 Main／Core 保留，退出后二者与 parser 均已停止。此检查没有连接账号、保存密钥或复制媒体；托盘图标菜单本身未实际点击，真实登录启动和完整生命周期矩阵仍由 2.6 继续验收。分项收据、源码及 ASAR 摘要见 `tools/desktop-files/fixtures/mac-native-pause-controls-2026-10-26.json`。

同日继续对持续 `SIGSTOP` 的实际 Core 补验：先从本次 Main 的 AppMetrics 取得 Core，核对 OS 父子关系、创建时间与完整命令，再由 `ps` 确认处于停止状态。显式退出在约十秒后回收 Core 和 parser；显式重启先回收旧 Core／parser，再启动新 Core，保留同一未生效草稿、修订号和整理／下载独立暂停状态，没有文件作业。两个成功路径均未发送 `SIGCONT` 或由测试强杀；失败清理只作用于复核身份后的本次进程，不计入成功证据。开发构建两项与同一 arm64 未签名目录包四项回归通过，后者同时重跑原 Main／Core SIGKILL 恢复检查。

本次只增加回归测试与证据，没有修改生产退出实现，也没有重建沿用的目录包；ASAR 与当前宿主构建逐字节一致。不能把此结果推广到内核不可中断 I/O、Core 与 Main 同时故障、Intel 或已签名安装态。严格测试类型检查、产物检查、两套分项收据及运行身份见 `tools/desktop-files/fixtures/mac-core-termination-2026-10-26.json`。原生暂停阶段的 500 毫秒恢复用例仍只证明在途协调，此独立补验才证明本机持续 SIGSTOP 条件下的退出与重启。

后续包含新版表单的 `a152322` 目录包首轮定向检查出现一次冻结 Core 重启「核心启动已停止」，保留原失败后，单独连续三次、原顺序八项及只读 DMG 中重启均通过，具体原因尚未证明。测试增加应用退出事件观察和独立失败收据，诊断失败不能覆盖原重启错误；成功路径明确核对无 `before-quit`／`will-quit`。没有修改生产生命周期或将后续通过表述为修复。当前包与历史完整回归的范围分列于[安装态验证](./mac-installation-validation.md#install-a152322)，2.6 仍保留完整验收要求。

`desktop.host-preferences.get/save`、`desktop.about` 和 `desktop.license` 是固定宿主动作，Preload 不暴露路径、任意命令或通用文件读取。许可仅接受固定材料标识，Main 从当前开发／ASAR 和外部资源布局读取包内许可、来源说明及版本，缺失提示完整重装，不通过网络替换。它不启动云端组件或依赖 Core 可用性。运行设置与许可页使用独立 StatefulService，组件保留本地表单草稿；只读查询和许可请求核对代际，关闭页面不停止共享 Application，也不重放保存。

服务地址在契约和页面提交前按现有 Core 保存规则校验，核心校验继续保留：Emby 允许 HTTP(S) 基路径，代理仅允许根地址，二者均不接受 URL 凭据、查询或片段。TMDB 代理不代替 Emby 或网盘配置。准备升级先经过默认取消的原生确认，取消不停止核心或创建备份；恢复继续使用选择与确认两阶段。普通诊断仍沿白名单导出，宿主偏好、许可与个人路径不混入诊断。

操作说明与截图见[客户端设置与运行方式](../product/desktop-settings.md)。业务备份不重新注册系统登录项，首次关闭提醒保留当前本机宿主偏好。

2026-10-26 本阶段全量 761 passed／13 skipped；最终 arm64 未签名目录包完成五项实际窗口检查，覆盖真实登录项只读查询、受控系统 API 下的申请／撤回和待批准、提醒关闭及保留后台、窗口重载不重放注册、六类随包许可、升级取消／备份恢复、诊断脱敏与代理校验和 Core 重启。窗口在 920×640 核对开关宽度与标签间距，操作手册保留实际截图。系统注册修改和原生对话框为替身，未修改真实登录项；不替代注销登录、托盘原生菜单、完整安装矩阵或正式签名。源码、ASAR 及截图摘要见 `tools/desktop-files/fixtures/mac-runtime-settings-ui-2026-10-26.json`。

## 页面布局与识别规则交互回归（2026-10-28）

桌面公共样式明确区分文本输入与复选框，标题操作统一分组并按可用空间换行。来源同步和识别映射表单按输入、目标、过滤与策略分组；目录选择器按内容宽度排列，长路径另行完整换行展示，有序过滤规则在窄窗口分行。总览三个统计卡片均匀排列；待处理表格单独约束选择列，避免继承全局首列宽度。已删除识别规则只保留紧凑的折叠恢复入口，删除或访问旧链接会清除对应预览与编辑状态；已有规则编辑自动滚动并聚焦表单，过期预览提供重新编辑入口。

本机 macOS arm64 的当前开发构建通过 Renderer 22 个文件／129 项测试、工作区类型与依赖边界检查，以及本轮修改的测试文件严格类型检查。八项 Electron 定向回归覆盖主导航、账号、任务分页、识别字段、运行设置及键盘取消；新增布局用例分别检查 1240×820 和 920×640 的全部八个主导航页面、长路径、过滤行和复选文字位置，并通过真实 IPC 验证已确认规则再次编辑、保存、删除、旧链接重载及恢复后保持暂停。目录对话框使用隔离临时目录的受控替身，测试未连接个人网盘或处理真实媒体；这些结果属于开发窗口回归，不代表安装包或其他架构验收。

复验入口：`npm test -- apps/desktop/src/renderer/src`；`npm run test:desktop -- apps/desktop/tests/layout.spec.ts`。完整定向组合使用 `npm run test:desktop -- --grep '全部主导航|同步和识别表单|来源表单按文件去向|任务分页筛选|单条与批量识别字段|运行设置固定桥|云端账号界面取消|最小窗口下键盘'`。实际截图由用例写入 `test-results/desktop/layout-*.png`，包含同步表单、识别表单、删除后页面和两种窗口尺寸的主导航页面。

同步来源删除反馈补验（2026-10-28）：删除失败在确认弹窗内显示来源名称、具体原因和原确认按钮，提交期间显示「正在删除…」并禁止重复提交，默认聚焦取消；成功关闭弹窗并清理对应页面预览。按用户确认清空当前开发业务库后重新初始化，本轮没有新增存量数据兼容或迁移处理。Renderer 22 个文件／130 项测试和三项 Electron 窗口回归通过，后者在隔离目录验证全新来源确认、暂停、删除、重载及恢复，原文件内容保留且不创建同步或整理作业；类型、依赖边界、桌面构建与窗口测试严格类型检查通过。复验仍使用上方 Renderer 和 `layout.spec.ts` 入口，截图为 `test-results/desktop/sync-remove-confirm.png` 与 `sync-restored-paused.png`，未将开发窗口结果计作安装态验收。

## 当前验收边界

当前开发构建已接通冻结 parser、统一来源、云端下载、候选识别、默认人工确认、首次预览授权后的持久自动意图、COPY 及独立 Emby 交付。账号页只管理连接；来源页配置本地或网盘范围、周期及可选整理。保存草稿不执行，确认配置与一次性执行分别记账；首次也可原子确认配置并执行一次。来源版本、旧配置定位、分层暂停和按需求选择整理目标见[统一来源配置与版本](./source-rules.md)，文件状态和交付边界见[桌面整理流水线](./desktop-ingestion.md)。

当前业务 SQLite 为 schema v33。单元与真实文件测试覆盖下载交接、识别预览、COPY 和固定服务器响应；另在维护者自己的 Mac 完成了[单资源真实 Emby 收录闭环](./mac-unified-source-validation.md)。官方客户端行为夹具、共享自动权限、完整故障矩阵、Mac Intel 安装态和正式签名仍按变更中的未完成任务验收。下方 10 月 18～19 日的原型表是历史记录，其中的「尚未接通」只描述当时构建。

窗口测试对目录对话框使用受控替身，只证明授权桥和界面逻辑；原生对话框、托盘、签名、Mac 两架构安装及网盘实际磁盘行为须另做 OS 实测。20.4 另有真实 HFS+ 目录授权与重载记录，不推广为完整文件链路。未满足完整验收的 OpenSpec 任务保持未勾选；其他 OS 由独立变更承接。

## 本轮验证记录（2026-10-18～19）

本机为 macOS 26.5.2 / arm64，开发 Node 22.23.1。当前锁定 Electron 44.9.0、React/React DOM 19.3.1、框架 0.1.0、SQLite 包 13.0.3。以下结果仅证明当前原型，不表示完整媒体业务已经实现。

| 检查 | 证据与结论 |
| --- | --- |
| 技术方案提交 | `0f9282c`，后续实现及任务进度另行记录 |
| 干净安装和定向构建 | `/tmp` 独立目录中的 npm 10 `ci` 与桌面构建通过，不依赖 wenger 仓库或全局链接 |
| 类型与依赖边界 | 工作区类型检查、contracts/Core/Renderer/Preload 导入检查通过 |
| 框架发布包 | 固定版本、integrity、ESM/CJS/React 公开入口和 MIT 许可检查通过 |
| Node/核心/组件 | 5 个文件、18 项测试通过，覆盖契约、SQLite 迁移、模块隔离、失败清理及 React createRoot/StrictMode 轮询 |
| 目录包 | macOS arm64 未正式签名的应用目录包通过原生库解包、框架来源、项目/框架许可与旧工程排除检查 |
| 真实窗口 | 4 项打包版测试通过：旧业务端口占用不影响启动；沙盒及非法参数；授权目录保存和重启恢复；Main 强杀后核心退出；最小窗口键盘取消与焦点恢复。目录对话框为受控替身，不能视作系统对话框实测 |
| 文档 | 文档站构建通过，旧工程保持原位置且未参与桌面构建 |
| 离线解析器 | 独立 stdio 源码与 macOS arm64 冻结程序各 7 项测试通过，冻结测试清空 PATH/PYTHONHOME/PYTHONPATH；未接入 Core。冻结时额外收集 babelfish 数据文件，避免源码通过而冻结后缺失语言数据 |

| 待验证目标 | 当前状态 |
| --- | --- |
| Windows x64、macOS Intel 的真实目录包 | CI 矩阵已准备，尚未远端执行；任务 1.3 保持未完成 |
| Windows/macOS Intel 冻结解析器 | CI 已包含源码测试、冻结和相同协议 smoke，尚未运行；任务 1.4 保持未完成 |
| parser 与 Core 的运行协调 | 待接入，超时/非法响应/重启和完整进程树清理仍须实现 |
| 正式安装包与签名 | DMG/NSIS、签名、公证、最低系统与卸载升级尚未验收 |
| 实际媒体业务 | 发现、匹配、预览确认、复制/修正恢复、Emby 交付待迁移；当前不操作媒体文件 |

上表保留当时三平台原型的验证范围。当前任务 1.3 按已修订的 Mac 两架构门槛核验，非 macOS 由独立变更承接；本机 arm64 结果不替代 Intel Mac 的运行证据。

### 内置网盘组件 M0（2026-10-24）

OpenList v4.2.7 lite 与 Rclone v1.75.2 已固定三目标资产及双重摘要。独立 Chrome 扫码会话完成普通 Quark 驱动只读联调：指定约 577 MiB 视频的前 8 MiB 代理读取、重复 Range、匿名拒绝与失效 Cookie 拒绝通过；公开接口仍只有弱版本证据。Cookie 未保存，测试会话已关闭。

macOS arm64、Intel Mac、Windows x64 在同一提交上各通过 22 次本地 API/WebDAV 请求、Rclone 传输用例及六种退出/强杀场景，见 [M0 CI 记录](https://github.com/yeatszhang/media-marshal/actions/runs/40086100943) 和 `tools/desktop-sidecars/fixtures/platform-m0.json`。实测要求在 Utility Host 之外增加独立 Guardian；Windows 先建立 Job 归属再启动子进程，父管道断开后回收自有执行。查询失败不能视为停止证据。

此结果不覆盖上表中的原型目录包、冻结 parser、正式签名安装器或完整媒体业务；云端契约、宿主接线与下载界面仍待实施。

## 原型测量

生成当前平台目录包后，在 macOS 运行 `npm run desktop:benchmark`。测量从包内启动同一冻结 parser，不要求另有工作区 parser 产物。原始样本、ASAR／parser 摘要及环境保存到 `test-results/desktop/benchmark.json`。测量包含 Playwright 启动、查询与交互开销，系统磁盘缓存未清空；冷启动在此定义为新应用进程，热唤起为已有托盘进程重新显示窗口。它们不等于安装态真实用户体验的最终基准。

空队列测量使用隔离资料目录。从实际 Main 的 PID、创建时间和完整命令核对归属，递归采样其 OS 子进程，包含 Core 和冻结 parser。CPU 使用两次 `ps` 累计 user＋system CPU 时间之差除以实际采样间隔，RSS 为末次快照；Electron `app.getAppMetrics` 单列，不能重复相加。新出现或缺少比较基线的进程保留未知 CPU，不记为零。以下原型表保留 2026-10-18～19 的旧测量，不将旧值套用于当前构建。

2026-10-18～19 的 Apple M1 / 16 GiB、macOS 26.5.2、系统 APFS（应用目录 statfs type `0x1a`）空队列原型结果：

| 项目 | 样本 | P75 | P95 |
| --- | --- | --- | --- |
| 首次数据目录、新进程到可交互 | 3 次 | 1184.79 ms | 1184.79 ms |
| 已初始化目录、新进程到可交互 | 5 次 | 684.89 ms | 953.10 ms |
| 已有进程隐藏窗口后的重复启动唤起 | 5 次 | 242.97 ms | 551.19 ms |
| 独立冻结 parser 连续解析两个固定名称 | 20 次 | 4.87 ms | 5.67 ms |

冻结 parser 启动到 health 响应为一次样本 239.67 ms。最后一次启动稳定 2 秒后，Electron 管理的全部进程 CPU 采样合计约 0.33%，工作集相加约 566.69 MiB；共享页可能重复计算，该值不是系统独占内存。此时独立 parser 未接入 Core，不在该应用进程树内，不能视作最终完整流水线的资源数据。

当时 `du -sk` 测得应用目录约 367.91 MiB，独立 parser 目录约 23.53 MiB，均非 DMG/NSIS 下载体积。样本较小，未设置虚构性能承诺；Windows、Intel Mac、最低系统、正式签名产物及完整媒体队列均未测，后续接通 parser 和业务后需重新测量。

### 当前目录包测量（2026-10-26）

已接入 Core／冻结 parser 的 arm64 未签名目录包在同一 Apple M1／16 GiB、macOS 26.5.2／APFS 机器重新测量。修正脚本对「来源配置」标题的定位，直接测量随包解析器，补齐原先不在 Electron 指标中的 parser 进程。应用 ASAR 为 `6a35a50718d0f0a61fdb160d45186a62fa2046cdd5ed150dafd4e0dd7da08510`；脚本、环境与完整样本见 `tools/desktop-files/fixtures/mac-benchmark-2026-10-26.json`。

| 检查 | 样本数 | P75 | P95 |
| --- | --- | --- | --- |
| 新资料目录、新进程到核心连接且来源页可用 | 3 | 5434.49 ms | 5434.49 ms |
| 复用资料目录、新进程到同一可用状态 | 5 | 2770.02 ms | 2782.38 ms |
| 已有进程隐藏窗口后重复启动唤起 | 5 | 214.16 ms | 225.11 ms |
| 同一随包 parser 的名称解析请求 | 20 | 4.50 ms | 4.68 ms |

parser 独立启动至 health 为 91.03 ms，首个解析请求为 37.31 ms，已包含在二十项原始样本中。启动后的 2198 ms 空队列窗口共采样六个 OS 进程，含 Core 和 parser，单核满载为 100% 口径的累计 CPU 时间差为 3.20%，末次 RSS 合计 682.73 MiB。Electron 五个进程的 SDK 指标另保存为 0.4043%／640.05 MiB，不与 OS 数据相加。RSS／工作集相加可能重复计算共享页，不是系统独占内存。

应用目录占用 596.19 MiB，包含的 parser 为 26.22 MiB，均非 DMG 下载体积。此记录包含自动化和磁盘缓存影响；未登录账号、没有媒体作业，不能推广为真实下载、COPY、长期空闲或其他架构性能，也不作为已签名安装态的结果。


云端测试默认使用 `npm test` 的 Electron Node 运行器，SQLite 与桌面 ABI 保持一致；`npm run test:electron-node` 为兼容别名。准备与验证命令见 [网盘与传输扩展开发](./cloud-adapter-development.md)。不要在桌面原生模块重建之后直接用另一 Node ABI 加载该 SQLite 二进制。

`npm test` 的 Electron Node 运行器先串行构建 contracts 与 `packages/media-core/dist`，成功后才运行并行测试；真实强杀夹具统一读取这份编译输出，测试文件不再各自重编共享目录。`typecheck` 会更新 contracts 声明，`desktop:build` 会更新完整产物，因此类型构建、单元测试和桌面构建仍须按顺序执行，不能并行运行多个写入同一 dist 的入口。Electron 窗口测试在构建成功后启动；构建失败后不得继续沿用旧 Renderer 或混合宿主／核心产物作为当前验收。
