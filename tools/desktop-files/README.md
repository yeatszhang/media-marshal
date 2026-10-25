# 修正文件操作的 macOS 原语

本目录提供 `renameatx_np(..., RENAME_EXCL)` 的 Node-API 8 绑定，作为后续单条／批量修正的底层能力。Apple 将独占改名定义为文件系统能力，不能从普通 `rename` 或词法预检推断支持：[Apple 文档](https://developer.apple.com/documentation/foundation/urlresourcevalues/volumesupportsexclusiverenaming)。Node-API 的接口版本与 Electron 的普通 C++ 模块 ABI 分开，实际可加载性仍须按目标运行验证：[Node-API 文档](https://nodejs.org/api/n-api.html)。

当前已接入 Main 私有资源定位、Utility Process 与固定 Preload 方法，并进入 Mac 按架构准备和打包资源。Core 修正的文件计划、历史及 Emby 编排见下文；单条修正页面、历史及逐文件修复／重试已接通并在 arm64 开发构建及目录包验证，任务 5.6 已完成；同季／同剧批量页面已接通；完整安装矩阵和正式签名仍待完成。

## 构建与验证

Mac 需安装 Xcode Command Line Tools。准备命令使用根锁文件已有的 node-gyp，通过 Electron 官方地址校验并缓存固定版本头文件；运行中的客户端不下载头文件或调用编译器。

```sh
npm run desktop:prepare-native-files
npm run desktop:prepare-native-files -- x64
npm test -- packages/media-core/src/files/rename-exclusive.test.ts
node tools/desktop-files/check-filesystems.mjs
```

准备命令输出位于忽略的 `apps/desktop/resources/native-files/darwin-{arm64,x64}`，同时准备对应源码、GPL 许可和发行材料清单。`desktop:build` 与 builder 的 `beforePack` 都会调用准备入口；运行中的应用不编译模块。构建记录源码和四份 Node-API 头文件的 SHA-256、Electron 头文件版本、SDK、编译器、架构及二进制摘要；构建期间输入变化则失败。每次临时编译后核对 Mach-O CPU，再发布到开发输出目录。未承诺跨机器或临时链接标识的逐字节可复现构建。

`build.mjs --headers <目录> --out <隔离输出> --arch <架构>` 可用于已准备 SDK 的离线编译。单独调用 `build.mjs` 默认仍输出 `build-artifacts/desktop-files/darwin-{arm64,x64}`，标记 `unintegrated-development`；准备入口发布为 `unsigned-preview`。这是无 Developer ID 的内测状态，clang 可能给 Mach-O 附加 linker ad-hoc 签名，不能据此宣称 Developer ID 或公证完成。

## 内部契约与恢复边界

`renameExclusive(fromParentFd, fromName, toParentFd, toName, expected)` 只接受两个目录 FD、两个单层名称和原文件 BigInt 快照 `{dev, ino, size, birthtimeNs, mtimeNs, ctimeNs}`。拒绝穿越、绝对路径、NUL、超长名称、孤立代理项、非整数 FD、伪造快照及非普通来源；不接收任意命令或 SQL。**目录 FD 是否来自已授权媒体根仍由 Core 保证**，本原语不能替代原卷、父目录或路径边界核验。

排队前以 `F_DUPFD_CLOEXEC` 复制并独占持有目录 FD，避免调用者关闭／复用句柄后改名到另一目录。三个原生入口共享一个实例的 64 项等待上限；在 libuv 工作线程执行，完成或排队失败释放 FD、工作对象和名额。函数对象释放后在途工作仍保留实例状态，不借全局实例数据与其他原生模块共享所有者。

返回固定结果，不包含路径或原始系统消息：

| 状态 | 语义 | 后续 Core 必须采取的动作 |
| --- | --- | --- |
| `NOT_RENAMED` | 系统调用没有成功改名；包括目标占用、来源变化、跨卷、不支持和不可用 | 保留原目标；按原因等待、重新预览或进入跨卷计划 |
| `RENAMED` | 独占改名成功，改名后身份与大小／修改时间相符，目录同步成功 | 仍须核对内容证据并补记持久日志，不能仅凭返回值完成历史 |
| `UNCERTAIN` | 改名成功后身份核对或目录同步失败 | 原位置可能已变化；按持久日志定位现存文件，不自动删除或逆向改名 |

`renameBeneath(fromRootFd, fromSegments, toRootFd, toSegments, expected)` 从根 FD 逐层 `openat`，拒绝符号链接、非目录父项和跨设备子挂载；最多 256 层，每段最多 255 字节。来源身份核对后才创建缺少的目标父目录，并同步父目录；随后再次核对来源身份并独占改名。跨卷在创建目标目录之前返回 `CROSS_VOLUME`。调用方仍须持有已授权根、检查根身份，并通过日志核对并发目录变动后的现存文件。

`linkBeneath` 使用相同参数和目录约束，把目标卷中的已验证暂存文件以不覆盖硬链接发布；来源暂存锚点保留。返回 `PUBLISHED`／`NOT_PUBLISHED`／`UNCERTAIN` 与 `published`，不能将发布当作旧媒体已回收。该入口只服务已明确规划的跨卷复制发布，不是独占改名不受支持时的自动降级。

Core 的 `files/native-rename.ts` 校验 Main 私有启动参数指定的 manifest 摘要、严格字段、平台架构、Node-API 版本、固定二进制名、大小、SHA-256 和 Mach-O CPU 后加载组件；资源符号链接被拒绝。Main 从开发目录或 ASAR 内清单计算可信摘要，仅在初始化私有通道传给 worker；安装包模块及清单位于 ASAR 外 `Contents/Resources/native-files`。Renderer 不能提供资源路径。`ManagedRoot` 提供完整摘要与原生快照、私有 UUID 隔离、发布锚点及证据一致时的清理；恢复补记重新同步目录，内容相同但 inode 不同的外部目标仍是冲突。这些接口不拥有业务文件，也不代替持久计划。

原文件的 ctime 用于改名前核对，改名后允许内核更新 ctime；摘要和文件的业务归属由上层另行证明。原语不提供“取消后必未执行”的承诺。调用前必须先持久化完整计划，调用后等待确定结果；Core 被强杀时应从日志核对旧／新位置，不重放普通覆盖式改名。返回 `CROSS_VOLUME` 或 `UNSUPPORTED` 不执行 COPY、硬链接降级或旧目标删除。同路径或仅大小写改名的计划应由上层明确判定，必要时使用可恢复中间计划。

## 已有证据与缺口

`fixtures/mac-rename-exclusive-2026-10-25.json` 保存本机 arm64 的自有 256 MiB 稀疏映像结果和构建摘要：APFS、HFS+ 改名及不覆盖通过；exFAT 实际改名返回 `UNSUPPORTED`；三种目标的跨卷调用均返回 `CROSS_VOLUME`。工具以 `hdiutil info` 核对映像与设备归属后卸载，不按设备名猜测；残留挂载未确认时不递归删除测试目录。

2026-10-26 新增根内遍历、保留锚点的发布、资源篡改／链接／架构拒绝、根替换、取消摘要、隔离文件清理及发布回执丢失补记测试；16 项 Electron Node 文件测试通过。原 8 项原生测试覆盖同卷 inode／内容保持、外部进程抢占、并发目标领取、来源变化、符号链接、目录、非法输入、权限撤销、异步 FD 复用以及 64 项上限和完成后名额释放。同一模块还由本机 Node 22.23.1 加载完成文件系统矩阵；Electron 44.9.0 内置 Node 24.22.0 实测加载。x64 仅交叉编译与 Mach-O 核对，不能视作 Intel Mac 运行或安装验收。

`fixtures/mac-rename-beneath-2026-10-26.json` 另记录同一源码下的根内改名、嵌套发布、占用保留及跨卷提前拒绝实测；APFS／HFS+ 通过，exFAT 改名与发布均不支持，未执行降级；映像均完成核对卸载。

尚未覆盖“改名后来源被并发替换”的 `UNCERTAIN` 实际竞争窗口及同步故障注入；该返回分支只是必要契约，不能据此宣称修正恢复已验证。下方组件已补齐旧目标隔离、逐文件日志及相应 SIGKILL 恢复；上层修正仍须接入主视频／附属文件范围、业务历史和 Emby 事务，并完成整条流程的部分失败与强杀恢复，不沿用旧 Java 的内存回滚方式。

## 文件日志组件验证

schema v21 的 `FileRelocations` 已在内部组件层连接上述原语，冻结逐文件计划、执行同卷隔离／改名或 COPY／发布／旧目标回收，并在历史记账前保留位置占用和暂存锚点。它不自行建立业务历史或 Emby 交付；schema v22 的上层 `Corrections` 已接入 Core 命令、历史和交付事务，单条修正页面已接通，资源和宿主接线的验证见下文。

```sh
npm run build -w @media-marshal/contracts
npm run build -w @media-marshal/media-core
npm test -- packages/media-core/src/files/relocations.test.ts
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron tools/desktop-files/check-relocations.mjs
```

日志测试的六个独立进程检查点使用 `relocation-crash-child.mjs`，父测试只对自己启动并已到达检查点的进程发 SIGKILL，核对退出后才打开原库恢复。单元 COPY 分支使用不同授权卷身份，真实跨设备另由 HFS+ 自有映像工具验证 APFS → HFS+、HFS+ → APFS 和 HFS+ 本卷改名；双向 COPY 都核对新文件后才回收旧媒体，并保留下载原件。工具先关闭所属资源，核对映像与设备归属后卸载，未确认卸载时保留目录而不递归删除。脱敏结果为 `fixtures/mac-relocation-journal-2026-10-26.json`，不代替修正界面、附属文件、批量历史或签名安装验收。


schema v22 的上层业务测试为 `npm test -- packages/media-core/src/ingestion/corrections.test.ts`。`correction-crash-child.mjs` 仅用于该测试的两个独立进程检查点：父测试核对检查点后 SIGKILL，重建不恢复下载来源、不注入个人凭据，只按已确认媒体目标计划补历史或清理。Core 的私有启动参数可传入经完整性校验的原语；Main／worker 已传递经验证的私有资源；这些底层检查与后续页面验收分别记录。

大文件核验：schema v23 将公开预览／确认动作改为先返回持久核验编号，`corrections.preparation` 查询当前文件读取进度，`corrections.cancel-preparation` 传递取消信号；Core 内部仍可直接等待核验方法，测试不会以该内部方法冒充 IPC 立即返回。核验队列、请求合并、取消、停止及恢复收据测试位于 `packages/media-core/src/ingestion/correction-preparations.test.ts`。单条与普通剧集批量页面均已接通，当前批量页面验收见下文。

## 宿主、目录包与完整性核验

Main 的 `nativeFilesLaunch` 只读固定的当前架构清单；打包时可信清单留在 ASAR，Core 读取 ASAR 外副本并要求摘要匹配，再核对固定模块、大小、SHA-256、Node-API 与 Mach-O CPU。`runtime.get.correctionFiles` 表示 Core 是否已加载组件，不代表某个文件操作成功。升级版本记录同时保存原生组件清单摘要。Preload 只暴露任务、预览、确认、核验查询／取消、作业查询和重试，不暴露资源路径或通用 invoke。

Mac 包只新增一个固定的外部 `.node`，原 ASAR SQLite 架构白名单保持不变；包内外清单、二进制和源码／许可均检查摘要，其他架构及未知文件不能混入。`afterSign` 发现模块摘要改变时拒绝产物，当前尚未实施 Developer ID 最终摘要流程。

```sh
CSC_IDENTITY_AUTO_DISCOVERY=false npm run desktop:pack
node scripts/check-desktop-artifact.mjs
node tools/desktop-files/check-packaged-native.mjs
npm run test:desktop -- --grep '修正原生组件经 Main|真实窗口、核心握手'
```

实际打包窗口使用 `MARSHAL_APP_PATH` 指向目录包可执行文件并设置 `MARSHAL_EXECUTABLE=1`。2026-10-26 在 macOS 26.5.2／arm64 验证开发构建和 arm64 目录包各两项检查：经真实 Main 授权、Utility Process 和 Preload 完成视频／字幕改名、历史及重启查询，保留原下载文件和 inode。`seed-host-correction.mjs` 仅在隔离 Main 退出后，沿原生授权准备真实 COPY 收据与离线元数据；受控时钟和目录对话框替身不作为真实客户端就绪或 OS 对话框验收。

`check-packaged-native.mjs` 复制自有目录包，在中文／空格路径与最小 PATH 下启动；先核对正常组件，再同时改写副本的外部模块和清单，验证 ASAR 可信摘要仍阻止加载，普通核心和 parser 保持可用，不产生修正作业。原目录包不改写，退出后移除副本。脱敏摘要见 `fixtures/mac-native-host-2026-10-26.json`。x64 当前仅交叉编译和 Mach-O 检查，未声明 Intel 运行；同季／同剧批量修正现已接通并另存当前证据，完整故障矩阵和正式发行仍未完成。

单条页面验证：`npm run test:desktop -- --grep '单条修正页面'`。当前 arm64 开发构建和目录包完成预览恢复／过期重做、显式完整确认、历史导航，以及字幕目标冲突后的同作业重试。下载原件和已完成主文件 inode 保留；构建及截图摘要见 `fixtures/mac-correction-ui-2026-10-26.json`，操作步骤见 `docs/product/desktop-corrections.md`。


schema v24 的批量修正服务已接通完整范围快照、后台预览／复核、原子登记全部成员意图及逐项执行查询。测试仍使用上方 `corrections.test.ts` 入口，覆盖跨分页范围、成员变化、目标冲突和局部失败后服务重建；`correction-batch-crash-child.mjs` 在第一成员记账后、第二成员记账前两个检查点实际 SIGKILL，验证原批次续作及历史唯一；开发构建经固定 Preload API 完成两成员和 Core 重启查询。批量页面另经当前窗口验收，服务阶段的证据与后续页面证据分开保存，细节见 `docs/architecture/desktop-ingestion.md` 的 Core 批量修正章节。旧 v23 目录包证据仅证明对应当时构建，不作 v24 新批次的安装态证据。

批量固定桥验收：`npm run test:desktop -- --grep '同季批量修正经固定'`。最终 arm64 未签名目录包完成该 API 链路及两项单条回归，资源白名单通过；脱敏构建与断言见 `fixtures/mac-correction-batch-core-2026-10-26.json`。LikeC4 模型及四张图使用本机已安装的 1.60.0 导出，命令为 `likec4 export png docs/architecture --flat -o docs/public/architecture/cloud-downloads`。


批量页面验收命令为 `npm run test:desktop -- --grep '批量修正页面'`；当前页面覆盖完整范围、参数恢复、过期重做、整批确认、历史导航，以及字幕冲突后的 Core 重启和原成员独立重试。截图分别保存为 `correction-batch-preview-minimum.png`、`correction-batch-conflict-minimum.png`、`correction-batch-recovered-minimum.png`，均为隔离目录、离线元数据夹具与当前实际窗口；它们不证明真实 Emby 收录或官方客户端下载行为。

批量页面闭环及最终 arm64 目录包证据见 `fixtures/mac-correction-batch-ui-2026-10-26.json`；范围表单另存 `correction-batch-draft-minimum.png`，最小窗口检查实际核对复选框宽度和文字间距。5.7 已完成功能验收，Intel、正式签名与完整安装矩阵仍未完成。


待处理确认页面的季集分组与 7.5 闭环证据见 `fixtures/mac-ingestion-review-ui-2026-10-26.json`。最终 arm64 未签名目录包执行 `npm run test:desktop -- --grep '单条修正页面|批量修正页面|目录批量识别经真实|季集分组跨目录选择|来源表单按文件去向分组'` 的七项窗口用例；目录／季集使用真实 120 秒观察，修正初始收据与元数据为隔离夹具。来源／目标均在测试临时目录，系统对话框使用受控替身；该记录不替代第三方客户端下载、真实 Emby、Intel、完整安装或正式签名验收。


7.6 的运行设置与许可页面证据见 `fixtures/mac-runtime-settings-ui-2026-10-26.json`，用户说明和两张实际窗口截图位于 `docs/product/desktop-settings.md`。最终 arm64 未签名目录包通过运行偏好、六类随包许可、默认取消的升级确认、备份恢复、诊断及代理校验五项窗口检查；真实登录项只读查询通过，注册／撤回与待批准状态使用系统 API 替身，不修改本机实际登录项。托盘原生菜单、注销登录、Intel 及完整安装和正式签名仍单独验收。

来源表单的执行摘要、React 草稿与跨页／重载验证见 `fixtures/mac-source-react-draft-2026-10-26.json`，用户说明及三张实际截图位于 `docs/product/cloud-downloads.md`。当前 arm64 未签名目录包通过表单长路径／窄窗口、删除恢复、统一来源授权与 Core 重启、旧 schema 迁移、草稿跨页返回及完整重载五项窗口检查；目录授权对话框使用受控替身。此记录只验证了来源阶段，当时设置查询代际和受控重载尚未完成，7.7 保持未勾选。

7.7 的后续设置查询与受控重载证据见 `fixtures/mac-renderer-lifecycle-2026-10-26.json`。来源、任务、待处理和设置均使用公开框架服务／hooks，临时输入保留在 React；固定重载握手只在 React 与 Application 清理完成后刷新。测试分别核对异步清理、扫码取消回执、请求代际、顶层 frame／nonce、失败／超时、真实 Renderer 强杀与主窗口销毁重建，以及同一 Core PID 和持久 DTO 不变。Electron 菜单回调、输入端口与 app.activate 事件用于窗口自动化，不代替 OS 原生菜单、系统快捷键和 Dock 点击；HMR 启停交错以受控 Promise 门验证。上方来源阶段记录保留当时未完成状态，后续完成状态以当前 OpenSpec 和此证据为准。

schema v25 的本地目录健康阶段见 `fixtures/mac-local-source-health-2026-10-26.json`。验证命令为 `npm run test:desktop -- --grep '本地来源健康区分原目录替换|来源表单按文件去向|旧 schema 来源|菜单与快捷键受控重载|整包升级停写备份'`，当前开发构建及 arm64 未签名目录包各五项通过。输入与目标的原目录／权限分别检查，不扫描文件或提交整理；Core 重启后只将旧检查作为历史诊断，恢复后仍保留暂停和版本。系统目录选择与 resume 事件为受控替身，真实改名／权限测试不替代物理磁盘拔插、休眠或官方客户端行为夹具。7.3 的自动接入仍在原变更范围内，当前阶段不将其勾选完成。

手动补扫和请求生命周期的 2.9 验收见 `fixtures/mac-source-scans-2026-10-26.json`。schema v26 只增加补扫意图、请求收据和逐项问题；Root 替换与暂停阻止迟到候选，网盘摘要只取本来源有效需求。全量 823 passed／13 skipped，最终 arm64 未签名目录包五项窗口检查覆盖补扫与历史恢复、内容复核、目录健康、请求取消与期限及升级恢复；选择器与宿主 RPC 的受控范围在夹具中单列。
