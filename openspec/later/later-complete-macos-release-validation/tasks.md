# 实施任务

承接[原变更任务](../archive/2026-10-27-add-local-desktop-emby-ingestion/tasks.md)中尚未完成的范围；不以迁出或部分实现标记完成。原 21.1／21.2 已完成，v29 网盘成功历史已有局部接线，均按已有基线复用。

架构构建、签名准备及原生生命周期可先推进；新流程最终验收依赖 finish-source-sync-rules、add-independent-recognition-mapping、add-emby-target-path-binding、validate-local-file-readiness。

## 1. 完成 Mac 发行与综合验收

- [ ] 1.1 （原 1.3）建立 electron-vite/electron-builder 原型、React 窗口和 Utility Process 入口，核心加载 better-sqlite3；先在 macOS arm64 运行真实打包产物，再按同一应用补齐 macOS x64 架构验证，检查 ABI、资源路径、无 JRE 和无旧服务依赖，不要求同期运行 Windows 安装包。
- [ ] 1.2 （原 1.4）在 `tools/desktop-parser` 建立只依赖 guessit 的 JSON Lines stdio 入口与 PyInstaller 目录模式构建；用现有解析响应夹具验证名称解析、超时、非法输出和管道关闭，Mac 两架构包无需系统 Python 且无 FastAPI/uvicorn 监听服务。
- [ ] 1.3 （原 2.6）实现托盘、首次关闭提示、可选登录启动、显式退出及父通道/stdio 关闭清理；在 Mac 测试窗口关闭继续工作、重复启动唤起、Main/Core 强杀和 parser 超时，无孤儿写入者，不按进程名杀进程；平台差异封装在宿主适配中。
- [ ] 1.4 （原 8.1）固定新工作区依赖、Electron ABI 和 Mac 两架构构建流程，配置 SQLite 模块重建/解包与 parser 资源；保留平台/架构选择结构，非 macOS 验收由独立平台变更承接。检查安装包白名单，无 JRE、旧服务、开发数据或个人密钥，干净环境可启动。
- [ ] 1.5 （原 8.2）统一验证 Mac 应用、冻结 parser、OpenList、Rclone、Guardian 及原生依赖的 Developer ID 签名、公证与完整性，覆盖拟公开发行的两架构；验证失败产物不能发布，记录版本、许可、源码、签名和摘要。合并原云端 9.3，暂无配置保持未完成，未签名内测另记；Windows 签名由独立平台变更承接。
- [ ] 1.6 （原 8.4）完成 Mac DMG 安装、重复安装和保留数据卸载；按架构验证只读安装目录、中文/空格路径、重新安装和手动升级，标明内测或正式签名状态，不触碰来源及目标媒体，不读取旧 Java 数据。其他平台安装器不作为本项门槛。
- [ ] 1.7 （原 8.5）在官网文档增加客户端架构下载、系统/客户端前置条件、发行说明及校验值；运行 `npm run docs:build` 并核对链接与版本，实际上传发布按后续用户指令执行。
- [ ] 1.8 （原 9.1）在 Mac 交付架构完成真实本机 Emby 入库流程，arm64 优先并单独记录 x64 验证；覆盖经验证的网盘来源、移动硬盘、暂停续传、空间不足、离线、休眠和 Main/Core 强杀，交付按系统版本/架构/客户端/文件系统分列的结果及未验证项，不等待 Windows 客户端。
- [ ] 1.9 （原 9.2）执行新工作区类型检查、核心/契约/组件测试、Playwright Electron 与安装态检查；记录业务对照差异、性能和恢复结果，模拟原生对话框不得替代 OS 实测，不用开发态宣称公开发行完成。
- [ ] 1.10 （原 18.4）在 Mac 执行适用的 `npm run typecheck`、`npm test`、`npm run check:boundaries`、`npm run test:desktop`、`npm run desktop:pack` 和 `npm run test:packaged`，验证无开发环境、中文/空格路径、只读安装目录、卸载重装，补充真实账号完整文件、大文件、限流、断网、缺盘与进程强杀矩阵；按架构保存脱敏日志、截图及签名状态，区分 Mac 内测与正式发行。
- [ ] 1.11 （原 21.10）验证新流程的本地／网盘同步、混合媒体分目标、Emby 关联和收录、删除同步副本后多次扫描及重启不重下、显式重同步与迁移恢复。执行适用类型／边界／核心／组件、真实 Electron 和当前构建安装态检查，保存截图与脱敏证据；真实账号和服务器验收按授权使用，不能以旧 9.4 或旧包冒充新结果。同步更新当前架构文档、LikeC4 与操作说明并通过文档构建。

## 验收与记录

每项完成时同步相应操作／架构文档，记录实际命令、结果及构建；原任务中要求的真实客户端、OS、架构与故障场景全部保留。通用测试不能替代未执行的实测，未签名包不能替代正式发行。相关测试已覆盖且实现未变时复用同构建证据，避免重复运行。

## 工作流后续

- 使用 `$openspec-apply-change complete-macos-release-validation` 实施本变更。
- 完整验收后单独归档；公开发布、真实凭据和个人媒体操作依照具体授权，不由本次规划迁移自动执行。
