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
npm test
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

原生模块需要匹配目标平台、架构和运行时。`npm test` 通过仓库运行器使用 Electron 内置 Node，`test:electron-node` 是兼容别名；SQLite 二进制必须先匹配桌面 ABI。当前 SQLite 包提供平台预编译文件，产物检查核对它在 ASAR 外可用，实际加载仍以窗口测试为准。不要用另一系统 Node ABI 直接加载已经重建的 SQLite 模块。`desktop:build` 只编译，不启动旧服务。

`desktop:pack` 生成当前系统的应用目录包；正式 DMG/NSIS、签名、公证和其他架构须在对应目标环境验收。未配置开发者证书时的本地原型可使用 `CSC_IDENTITY_AUTO_DISCOVERY=false npm run desktop:pack`，该产物不能作为正式发行完成的证据。运行已打包的应用测试时，将 `MARSHAL_APP_PATH` 设为可执行文件并使用 `MARSHAL_EXECUTABLE=1`；具体路径以构建输出为准。

当前平台目录包可直接使用 `npm run test:packaged` 验证，它先检查许可、原生库和框架来源，再运行真实窗口测试。`.github/workflows/desktop-prototype.yml` 预置 macOS arm64、macOS Intel 和 Windows x64 矩阵；尚未远端运行时不能据此宣称三平台通过。

## 框架与模块约定

采用公开 npm 包 `@yeatz/app-framework@0.1.0`，精确版本与内容由根锁文件固定。注册表已可取得该版本，因此按技术方案的发布后路径直接接入，不创建 vendor 源码副本。`apps/desktop/resources/framework-origin.json` 保存 npm integrity 和源码评估引用；许可随应用资源保留。

`npm run check:framework` 核对版本、来源、依赖可解析性、公开入口、同版本 React／React DOM 和 MIT 许可，拒绝个人路径与跨仓链接。`npm run check:framework -- --verify-contents` 在独立临时项目中禁用安装脚本，取得固定 npm 包并复核 integrity，再逐文件比较当前安装内容；临时项目随后清理。`npm run desktop:pack` 先执行完整内容核对，失败则不开始打包。首次核对可能需要连接 npm 公共注册表，不改变项目依赖。

升级框架时显式修改工作区精确版本、锁文件和来源清单，重新执行内容、DI、React 与生命周期检查，并重新打包。修改上游源码不会替换当前发布包，不使用跨仓链接把源码变更混入产物。来源评估 commit 与 npm integrity 分别追踪，未将缺少 gitHead 的发布包宣称为该 commit 的可复现构建。2026-10-25 对固定 0.1.0 的 74 个文件逐字节核对通过。

- Main：`desktop.host`、`desktop.credentials`、`desktop.core`、`desktop.bridge`、`desktop.windows`。
- Core：`media.storage` → `media.services` → `media.commands`。后续业务模块按迁移矩阵扩展，storage 最后释放。
- Renderer：`renderer.desktop-client` 提供受限接口，runtime/sources/tasks/settings 模块绑定各自 StatefulService。
- Preload 只导出明确方法，不创建 Application；领域纯函数与 contracts 不依赖框架。

legacy 装饰器由 TypeScript 统一转换，参数使用显式 `@inject(Token)`。Vite 与 Vitest 共用转换插件，避免编译器默认装饰器语义不同。不得使用框架的深层源码入口或全局命令容器。

## 运行与数据

页面使用 `marshal://app` 协议。Main 校验顶层 frame、来源、动作和参数；目录保存还要求通过原生目录对话框取得授权。Core 再次核对真实路径、目录关系与权限。Main 与 Renderer 不打开 SQLite。Main/Core 通信使用私有 MessagePort，端口断开后 Core 安全退出；媒体业务不开放 HTTP/WS 服务。新增受管网盘组件的授权回环接口及凭据副本边界见仓库中的 `openspec/changes/add-local-desktop-emby-ingestion/design.md`，尚未验收的能力不视为当前可用功能。

桌面数据位于 Electron 用户数据目录的 `desktop.sqlite3`，敏感凭据单独由 safeStorage 保护；查询不返回密钥。测试只使用临时数据目录。数据库使用 `user_version`、短事务和升级前 SQLite backup；未知或更高版本停止写入，旧 Java 无版本表不会被接管。

长任务必须返回持久化作业 ID。框架 CommandService 的注册等待超时不代表执行取消；业务请求和文件任务的取消分别实现。退出先阻止新接入并等待受管操作安全点，再清理框架和数据库。窗口关闭保留托盘，显式退出才停止应用。

退出期间的异步启动会在取得资源后重新检查停止状态，不能在升级检查或窗口加载结束后继续拉起 Core；迟到握手也不能触发凭据注入。Main 并发停止扫码、账号接入与 Core，避免授权作业等待已停止核心。Core 的幂等停止先关闭新命令和领取，取消网络、parser 及宿主响应等待，等待在途工作落到持久化安全点，再调用 `Application.stop()`。框架启动失败的 abort 同样触发这条取消路径，清理失败仍继续释放其他资源并返回可观察错误；数据库在其使用者之后关闭。取消宿主等待不作为写入者已停止证明，Main／Host 仍须确认回收后才允许新核心取得写入权。

### 核心与解析器恢复

Main 取得单实例锁后才组装应用，重复启动唤起已有窗口。核心握手最多等待十五秒，协议不符或超时即停止该实例；旧进程仍未退出时拒绝另开核心。异常退出立即将所有等待请求标记为中断，随后等待云端宿主完成写入者回收；停止证据不确定时阻断自动恢复。正常回收后最多自动恢复三次，间隔一、二、三秒，耗尽后保留失败状态，等待用户显式重启。重启不重放原变更请求，只恢复持久化记录和必要授权。

冻结 parser 使用独立 stdio 握手和单通道请求关联。单请求默认五秒超时；超时、取消或非法输出后先关闭旧进程，必要时强杀并确认退出，下一请求才可启动新实例。一个 Core 生命周期内同样最多恢复三次，队列最多三十二项。解析器只接收名称文本，拒绝路径与任意命令。关闭 Core 的父端口会沿 stdio 清理 parser，不按进程名回收。

Main 收到 resume 后先通过私有动作重置就绪观察，再恢复目录、账号及周期调度；该动作不向 Preload 开放。主文件和附属文件同时检查单调时钟与墙上时钟的间隔，任一时钟倒退或停顿超过三十秒都重新观察，稳定性仍以至少一百二十秒连续观察判断。Core 重启也清空观察缓存，已处理记录保持。任务页重载只重新查询持久记录。固定时钟及受控 resume 事件用于回归，不将其描述为真实整机休眠验收；真实休眠仍由 9.1 的环境矩阵记录。

2026-10-25 的六项 Core 故障单元与七项 parser 管道测试通过；真实 Electron 补充强杀核心、恢复同一持久草稿、原解析器退出及不产生执行来源的检查通过。握手与重试上限采用可控时钟及受控进程替身，真实强杀另使用 OS 创建时间和完整命令核验进程归属，二者证据分别记录。

## 当前验收边界

当前开发构建已接通冻结 parser、统一来源、云端下载、候选识别与人工确认、COPY 及独立 Emby 交付。账号页只管理连接；来源页配置本地或网盘范围、周期及可选整理。保存草稿不执行，确认配置与一次性执行分别记账；首次也可原子确认配置并执行一次。来源版本、旧配置定位、分层暂停和按需求选择整理目标见[统一来源配置与版本](./source-rules.md)，文件状态和交付边界见[桌面整理流水线](./desktop-ingestion.md)。

当前业务 SQLite 为 schema v14。单元与真实文件测试覆盖下载交接、识别预览、COPY 和固定服务器响应；另在维护者自己的 Mac 完成了[单资源真实 Emby 收录闭环](./mac-unified-source-validation.md)。官方客户端行为夹具、完整季集／批量确认／修正能力、完整故障矩阵、Mac Intel 安装态和正式签名仍按变更中的未完成任务验收。下方 10 月 18～19 日的原型表是历史记录，其中的「尚未接通」只描述当时构建。

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

生成当前平台目录包和独立冻结 parser 后，在 macOS 运行 `npm run desktop:benchmark`。原始样本及环境保存到 `test-results/desktop/benchmark.json`。测量包含 Playwright 启动、查询与交互开销，系统磁盘缓存未清空；冷启动在此定义为新应用进程，热唤起为已有托盘进程重新显示窗口。它们不等于安装态真实用户体验的最终基准。

本轮 Apple M1 / 16 GiB、macOS 26.5.2、系统 APFS（应用目录 statfs type `0x1a`）的空队列原型结果：

| 项目 | 样本 | P75 | P95 |
| --- | --- | --- | --- |
| 首次数据目录、新进程到可交互 | 3 次 | 1184.79 ms | 1184.79 ms |
| 已初始化目录、新进程到可交互 | 5 次 | 684.89 ms | 953.10 ms |
| 已有进程隐藏窗口后的重复启动唤起 | 5 次 | 242.97 ms | 551.19 ms |
| 独立冻结 parser 连续解析两个固定名称 | 20 次 | 4.87 ms | 5.67 ms |

冻结 parser 启动到 health 响应为一次样本 239.67 ms。最后一次启动稳定 2 秒后，Electron 管理的全部进程 CPU 采样合计约 0.33%，工作集相加约 566.69 MiB；共享页可能重复计算，该值不是系统独占内存。此时独立 parser 未接入 Core，不在该应用进程树内，不能视作最终完整流水线的资源数据。

`du -sk` 测得当前应用目录约 367.91 MiB，独立 parser 目录约 23.53 MiB，均非 DMG/NSIS 下载体积。样本较小，未设置虚构性能承诺；Windows、Intel Mac、最低系统、正式签名产物及完整媒体队列均未测，后续接通 parser 和业务后需重新测量。


云端测试默认使用 `npm test` 的 Electron Node 运行器，SQLite 与桌面 ABI 保持一致；`npm run test:electron-node` 为兼容别名。准备与验证命令见 [网盘与传输扩展开发](./cloud-adapter-development.md)。不要在桌面原生模块重建之后直接用另一 Node ABI 加载该 SQLite 二进制。
