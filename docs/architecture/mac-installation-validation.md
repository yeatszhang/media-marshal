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
