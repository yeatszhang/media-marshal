# Mac 安装态验证

2026-10-26 在 macOS 26.5.2（25F84）、arm64 上，使用 `ecfbdd2` 的 0.2.1／schema v27 目录包生成独立 DMG。映像保存在 `build-artifacts/desktop-install-validation/ecfbdd2/`，未替换旧版 DMG，也未发布或安装到系统 Applications。Developer ID 和公证尚未配置，本次是未签名内测。

## 实际安装文件与数据保留

`installation.spec.ts` 直接启动映像中的可执行文件，并将应用进程 PATH 限制为 `/usr/bin:/bin:/usr/sbin:/sbin`，移除 `NODE_OPTIONS`、`NODE_PATH` 与 `ELECTRON_RUN_AS_NODE`。Main 的实际 `app.isPackaged`、ASAR 位置、userData 路径及 PATH 必须与测试目标一致，不回退到工作区程序。

| 场景 | 实际核对 |
| --- | --- |
| 只读映像启动 | `hdiutil attach -readonly` 后，App 内独占写入返回 EROFS；Core、冻结 parser 与原生修正组件就绪，业务库写入独立资料目录，重启 Core 不改 ASAR |
| 中文与空格路径 | 从映像复制到自有临时中文／空格路径，再从该副本实际启动 |
| 覆盖安装 | 停止应用后覆盖同一个安装副本，重开保留来源 ID、有效版本、候选 ID 和暂停状态 |
| 卸载重装 | 只删除本轮创建的 App 副本，保留资料目录；重新复制并启动后保留同一配置、候选及实际准备升级时生成的私有备份，原来源／目标文件内容、inode、创建及修改时间保持 |
| 历史实际 DMG 升级 | 先启动仓库保留的旧 0.2.1／schema v6 DMG 副本，通过旧版来源接口建立并暂停来源；替换为当前 App 后核对统一来源迁移、暂停、媒体和旧 Schema 的整包备份 |

初次媒体目标授权会合法创建 `.media-marshal` 归属标记。验收以授权完成后的标记与既有媒体为基线，核对重装不产生额外文件；不将归属标记误判为整理操作。未配置 TMDB／Emby 或真实网盘账号，没有识别任务或 COPY。

目录对话框的返回结果在窗口测试中受控，后续真实路径、卷授权、预览、事务、文件读取和迁移使用生产代码。此处证明安装文件与隔离资料的保留，不替代系统目录选择器、Finder 拖放、真实注销登录或真实账号下载验收。

## 复验入口

先生成并只读挂载当前 DMG，再设置以下变量。历史映像也应独立只读挂载；不使用个人资料目录。

```sh
export MARSHAL_INSTALL_MATRIX=1
export MARSHAL_APP_PATH="${MARSHAL_DMG_MOUNT}/Media Marshal.app/Contents/MacOS/Media Marshal"
export MARSHAL_ARTIFACT_RESOURCES="${MARSHAL_DMG_MOUNT}/Media Marshal.app/Contents/Resources"
export MARSHAL_PREVIOUS_APP_PATH="${MARSHAL_PREVIOUS_DMG_MOUNT}/Media Marshal.app/Contents/MacOS/Media Marshal"
npm run test:packaged
```

只运行安装场景时，另设 `MARSHAL_EXECUTABLE=1` 后执行 `npm run test:desktop -- installation.spec.ts`。三项结果分别写入 `test-results/desktop/install-matrix-{readonly,reinstall,upgrade}.json`；缺少历史可执行文件时升级项明确跳过。安装目录和资料都由测试创建，结束后清理，系统既有安装与个人媒体不在操作范围。

## 本轮结果

最终映像完整执行 `npm run test:packaged`：45 passed／3 skipped，实际映像 9534 个 ASAR 条目及依赖、源码和许可核验通过；三个跳过项分别是工作区专用的任务分页夹具、识别字段夹具与启动竞态。新增安装用例另经严格无输出类型检查。备份逐文件摘要断言是在完整回归运行中补充的，Playwright 首次转换缓存没有加载它；证据生成器据收据缺少新字段识别此差异，随后以最新源码单独重跑三项安装用例全部通过，确认保留一个真实升级备份、其中两个文件摘要保持。两次检查使用同一个最终 App，未重建或替换程序。

首轮完整映像曾有两项来源页失败：目录健康信息将暂停操作挤出最小窗口，以及旧草稿用例未展开已折叠的可选筛选。前者将操作移到来源标题与版本之后，保留首屏可见断言；后者先展开再填写，保留草稿及无写入检查。修复提交为 `ecfbdd2`，四项打包窗口和二十五项组件回归通过，再从修复后的目录包生成最终映像。

构建身份、两个 DMG／ASAR 摘要、历史 schema v6 到当前 v27 的收据、安装与备份保留结果见 `tools/desktop-files/fixtures/mac-installation-matrix-2026-10-26.json`。两个内部 App 都显示 0.2.1，须用 Schema 与摘要区分，不能只根据版本号沿用旧验收。旧 DMG 未替换，完整功能、安装态、真实账号及正式发行仍分别记录。

## 尚未完成的验收

本机仍安装开发工具；限制应用 PATH 不等于在未安装 Node／Python／编译器的干净机器验收。Mac Intel 的实际运行、Developer ID／公证、系统 Applications 内的 Finder 安装与真实登录启动仍未验证。此处 `ecfbdd2` 映像的原生界面工具读取曾连续超时，客户端和 Core 的只读查询仍正常；当时托盘尚缺整理与云端下载各自的暂停入口，没有完成原生托盘菜单点击，不能把程序化退出描述为托盘实测。

后续目录包已补齐两项独立暂停入口，并完成实际 macOS「任务」菜单点击、系统目录选择、首次关闭及原生退出检查，见[本机运行设置与许可读取](./desktop-development.md#本机运行设置与许可读取)和 `mac-native-pause-controls-2026-10-26.json`。普通启动时工具可读取，不能据此断言此前超时的原因；托盘图标菜单的实际点击仍未验收。后续目录包不是本页已验证的历史 DMG，不沿用本页安装矩阵作为新产物的证明。2.6、8.4、9.2 及 18.4 继续保持未完成。

## 882e9a7 独立映像回归 {#install-882e9a7}

2026-10-26 随后将包含原生独立暂停控制及受管补扫权限修复的目录包留档为第二份独立 DMG，构建标识 `882e9a7`，业务代码截至 `2afb7f9`。仍为 macOS arm64、0.2.1／schema v27、未签名内测；没有覆盖 `ecfbdd2` 或更早的原始 DMG，也未上传或安装到系统 Applications。

| 身份 | 值 |
| --- | --- |
| 内部路径 | `build-artifacts/desktop-install-validation/882e9a7/Media Marshal-0.2.1-arm64.dmg` |
| 字节数 | 255,475,048 |
| DMG SHA-256 | `9c8c4b060155b0750c76f2fbad32dc30e506063a9b881fdf4136e4debec5de36` |
| ASAR SHA-256 | `6a35a50718d0f0a61fdb160d45186a62fa2046cdd5ed150dafd4e0dd7da08510` |

该映像完整执行 `npm run test:packaged`，50 passed／3 skipped；对应开发构建完整窗口检查也为 50 passed／3 skipped。开发回归跳过显式环境变量开启的三项安装场景，打包回归跳过三项工作区专用夹具，两组跳过对象不同。9534 个 ASAR 条目的产物检查通过。完整打包回归已同时包含只读映像、中文／空格路径、覆盖安装、卸载重装和实际旧 schema v6 升级；保留一个真实升级备份，两个备份文件的逐项摘要断言已加载并通过。持续 SIGSTOP 的 Core 退出／重启、原生暂停控制回调与其请求期限、恢复及既有稳定窗口检查也在本次完整回归中通过。

准备期间全量单元测试先发现受管补扫把终态候选的实际不可读文件误记为发现成功；`099b105` 在幂等接收前重新核验读取权限，普通和 SUPERSEDED 候选均有确定性回归。随后一次内容复核崩溃夹具报泛化错误，补充阶段和有界错误诊断，定向检查通过；另消除四项测试同时编译相同 dist 的已知风险，由公共入口顺序准备依赖。不能据此反推那一次泛化错误的具体原因；该准备完成后的全量结果为 886 passed／13 skipped，类型、边界及目录包构建通过。

映像身份、测试源码在该构建提交的摘要、完整日志摘要、三项安装及暂停／冻结 Core 收据见 `tools/desktop-files/fixtures/mac-882e9a7-install-validation-2026-10-26.json`；对应性能测量见 `mac-benchmark-2026-10-26.json`。结果先保留到各自构建目录，再核对映像路径、挂载点及设备身份卸载本轮自有映像。没有按进程名清理程序或操作个人媒体。

`8bf13cf` 的表单状态增强晚于该映像，其开发窗口检查另记；新增实际冻结 parser 的单元回归也另记，后者所在当前工作区全量为 887 passed／13 skipped。不能将这些后续源码或最新截图描述为本节 DMG 的内容。原生托盘图标、真实登录启动、Intel、最低支持系统、干净主机、签名／公证与真实账号完整故障矩阵仍需独立验收，相关完整任务继续保持未完成。

## a152322 新版表单映像 {#install-a152322}

包含 `8bf13cf` 表单状态增强的目录包另以 `a152322` 留档，0.2.1／schema v27、macOS arm64、未签名内测。独立 DMG 为 255,490,405 字节，SHA-256 `5b7dd5cf2e1f5f1b904b4c8b178dda5a17a6ad3d42f1838163f53b22c694d81a`，ASAR 为 `f6c618b499f4602e8cfeaf9492201a8bafa3107f3585702c2aedc369733bd6bf`。路径为 `build-artifacts/desktop-install-validation/a152322/Media Marshal-0.2.1-arm64.dmg`，未覆盖其他归档或替换个人安装。

当前工作区全量单元为 887 passed／13 skipped，类型检查和新目录包构建通过，9534 个 ASAR 条目核对通过。目录包的八项定向检查通过，覆盖来源表单、配置恢复、键盘、持续冻结 Core 的退出／重启和原生独立暂停控制。再从实际只读 DMG 启动，七项定向检查通过：三项表单／配置／键盘、冻结 Core 重启，以及三项安装场景。覆盖安装、卸载重装保留一个备份、两个备份文件摘要与原有媒体身份；旧 schema v6 升级保留来源和暂停。两份自有映像在保存结果后已核对身份并卸载。此 ASAR 未重跑此前的完整窗口套件，不能沿用 `882e9a7` 的 50 项完整打包结果。

首轮目录包定向检查曾为 7 passed／1 failed，冻结 Core 的显式重启返回「核心启动已停止」。单独连续三次、随后原顺序八项及只读 DMG 中的重启均通过，尚不能证明第一次失败的原因。新增测试内的 `before-quit`／`will-quit` 事件观察及失败阶段收据，成功检查确认重启期间没有应用退出事件；诊断失败不会覆盖原始错误。没有为得到通过结果修改生产退出代码、恢复被停止的 Core 或放宽期限，也不将后续通过表述为该问题已修复。

逐项收据、源码与日志摘要、首次失败和后续检查范围见 `tools/desktop-files/fixtures/mac-a152322-form-install-validation-2026-10-26.json`。系统目录与升级对话框仍为受控结果，使用隔离资料和媒体；实际托盘图标、真实登录启动、首轮中断原因及其余完整生命周期／发行矩阵仍待验证。
