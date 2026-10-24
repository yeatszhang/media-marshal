# 桌面伴随程序的固定资产

OpenList `v4.2.7` lite 与 Rclone `v1.75.2` 是当前待集成组合。`sidecars.lock.json` 固定 release 资产、上游源码 commit、归档和解压后二进制的 SHA-256。摘要来自 GitHub release 元数据并在下载后复核；许可证从固定 commit 源码复制。准备器不查 latest、不搜索系统 PATH、不运行下载的程序。

OpenList lite 不包含管理前端，保留 API、WebDAV 和驱动。当前只验证 macOS arm64 的进程和 HTTP 行为；准备出其他架构文件不代表对应平台运行通过。

## 准备与检查

构建机使用 Python 3.11+；最终用户不需要 Python。以下命令从仓库根目录运行；脚本使用自身位置定位仓库，改用脚本绝对路径时也不依赖工作目录：

```bash
python3 tools/desktop-sidecars/prepare.py
python3 tools/desktop-sidecars/prepare.py --target win32-x64
python3 tools/desktop-sidecars/prepare.py --all
python3 -m unittest discover -s tools/desktop-sidecars/tests -v
python3 tools/desktop-sidecars/contract_smoke.py
python3 tools/desktop-sidecars/rclone_smoke.py
node tools/desktop-sidecars/process-smoke.mjs
```

第一条准备当前架构，`--all` 只准备三种目标，不运行异构程序。缓存位于 `build-artifacts/desktop-sidecars/downloads/`，产物位于 `apps/desktop/resources/sidecars/<target>/`，均不提交 Git。只有完整核验通过才替换目标目录；损坏的缓存直接报错，应调查后删除对应缓存再重试。产物包含 `bin/`、`licenses/`、`manifest.json`，尚未接入正式安装包。

归档只能取出锁定的单个普通文件，拒绝重复成员、链接、长度不匹配和路径穿越。准备器验证解压后二进制摘要，防止误取归档成员。macOS 后续签名会改变二进制摘要，签名后的资源清单必须由发行阶段重新生成，不能混用原始摘要。

`contract_smoke.py` 验证当前架构二进制后，在临时目录启动仅回环的独立 OpenList，建立本地测试挂载和只读 WebDAV 账号，再删除挂载、停止进程并清理目录。它不读取用户数据库或网盘凭据。原始 stdout/stderr 被丢弃，避免上游初始管理员密码进入日志。默认输出 `test-results/sidecars/openlist-contract.json`；仓库内的 `fixtures/openlist-v4.2.7.local.json` 来自此命令，包含已脱敏的实际请求/响应。

## 固定接口契约

具体字段以固定 commit 下的 `cmd/root.go`、`internal/bootstrap/data/user.go`、`server/router.go`、`server/handles/{auth,storage,user,fsread}.go` 及 `drivers/quark_uc/` 为准：

| 动作 | 固定版本契约 |
| --- | --- |
| 启动 | `openlist --data <私有目录> --config <配置文件> server`；配置 `force=true`、`scheme.address=127.0.0.1`、显式端口 |
| 初始化 | 无管理员时默认进入初始化向导；显式 `OPENLIST_ADMIN_PASSWORD` 可在监听前创建管理员；该变量会被上游打印到首次 stdout，必须丢弃/脱敏原始流 |
| 初始化状态 | `GET /api/public/init_status` → `data.initialized`；不作为实例所有权证明 |
| 登录 | `POST /api/auth/login`，body 为 username/password → `data.token`；私有 `Authorization` 直接使用 token，无 Bearer 前缀 |
| 身份核验 | `GET /api/me` → username/role；此身份是 OpenList 用户，不是夸克账号 UID |
| 驱动 schema | `GET /api/admin/driver/info?driver=Quark` → common/additional/config；普通夸克内部驱动名为 `Quark` |
| 挂载 | `POST /api/admin/storage/create`，driver/mount_path/addition 等 → `data.id`；addition 是 JSON 字符串，不是对象 |
| 查询挂载 | `GET /api/admin/storage/list?page=1&per_page=10` → content/total；会返回 addition，必须视为敏感响应 |
| 移除挂载 | `POST /api/admin/storage/delete?id=<id>`；删除配置不等于安全擦除数据库/WAL |
| 只读用户 | `POST /api/admin/user/create`：role=0、base_path 指向指定挂载、permission=256；第 8 位允许 WebDAV 读取，第 9 位写入关闭 |
| 文件列表 | `POST /api/fs/list`：path/page/per_page/password/refresh → content/total；refresh=true 需要可刷新权限，不能直接套用只读用户 |
| 文件信息 | `POST /api/fs/get`：path/password → name/size/is_dir/modified/created/hash_info/raw_url 等；不把 raw_url、sign 回传给 Renderer |
| 数据读取 | `/dav/` 使用独立只读账号 Basic Auth；本地夹具验证 PROPFIND、HEAD、GET、Range，PUT 返回 403 |

API 通常使用 HTTP 200 包装业务错误，必须同时检查 JSON `code`。夹具验证未授权列表为 HTTP 200 / code 401，未授权 WebDAV 为 HTTP 401。

普通 Quark 的 additional 至少有 cookie、root_folder_id、排序和转码选项；根为 `0`，不使用转码地址。初始化代码在 AdditionVersion 首次迁移时设置 `web_proxy=true` 和 `webdav_policy=native_proxy`。后续仍须显式固定代理配置，而不是依赖默认值。

源码中的驱动对象有 fid，但 `fs/list` / `fs/get` 的公开响应**不提供 fid、可信 revision 或账号 UID**，普通 Quark 的 GetHash 也为空。因此这个实现以路径身份、弱元数据比较起步；认证成功不能证明与旧 Cookie 属于同一个账号，重新授权需要重新确认根范围。不得把 modified、同尺寸或 OpenList storage ID 当作网盘稳定内容身份。

## 当前证据与后续门槛

2026-10-24：六个三目标归档与二进制摘要核验通过；当前 macOS arm64 的版本命令及 22 次本地 HTTP/WebDAV 请求通过，包含匿名拒绝和私有文件权限检查；准备器 5 项完整性/归档边界测试通过。Rclone 的特殊名称、JSON 统计、非零退出部分成功、终止及新 attempt 重跑实测通过，日志保存在 `fixtures/rclone-v1.75.2.local.json`。后续实施记录应区分本地夹具、真实夸克、异构平台运行和正式签名安装包。

Rclone 本地 smoke 关闭 reflink clone，确保终止用例经过实际传输路径。它也确认 `--files-from-raw` 中不存在的源路径默认不会令命令失败，因此不能依赖该参数验证文件清单完整性；应用必须在传输后逐项核对。暂停后新建 attempt 的测试不证明跨进程字节级续传。凭据落盘、初始化 stdout 和默认导出规则见 [PRIVACY.md](PRIVACY.md)。

真实夸克普通 Cookie 驱动、下载速度、授权/账号身份、云端 Range、限流及三目标进程回收均未由此夹具证明。完整流水线和自动整理依赖 OpenSpec 中尚未完成的任务。

## 真实账号与进程树验收补充（2026-10-24）

真实账号已通过独立 Chrome 会话扫码取得本次授权。普通 Quark 驱动挂载、指定文件父目录、匿名拒绝、前 8 MiB 代理读取、重复 Range 的字节一致性及失效 Cookie 拒绝均通过；来源大小约 577 MiB，会员条件为用户声明 VIP。仅记录不含路径/凭据的 `fixtures/quark-v4.2.7.probe.json`，不宣称整文件下载完成、稳定内容版本或限流验收。无效 Cookie 在上游被包装为业务 code 500，后续适配器不能把所有 500 一律当成认证错误。

如需重新验收，在安装了 Google Chrome 的构建机运行 `node tools/desktop-sidecars/quark-login.mjs` 并保持交互终端打开。它使用独立的非持久上下文及当前代理；凭据仅经 stdin 交给只读 probe，不写 argv、日志或文件。登录后向该交互终端发送业务请求 `{"action":"probe","remotePath":"/用户指定文件","membership":"用户说明的会员类型"}`，完成后发送 `{"action":"close"}` 清理会话。Chrome 仅为 M0 验收工具，产品安装包不依赖它。

进程树 smoke 额外需要 Go 1.26.0（仅构建机依赖）。它先构建应用自有 Guardian，再运行真实 Electron Main → Utility Host → Guardian → OpenList/Rclone，检查正常停止、Main/Host/OpenList/Rclone/Guardian 各自强杀六种情形。进程身份从自有启动消息取得，并以 OS 父子关系、创建时间及唯一配置路径核验，不按进程名或 PID 文件杀进程。

本机初版仅依靠 Utility Host 清理时，Main 强杀留下 Go 孤儿，证实原假设不足。独立 Guardian 通过父 stdin EOF 收敛生命周期；Windows 在任何子进程启动之前先建立自身 Job 归属及 KILL_ON_JOB_CLOSE。该修正后 macOS arm64 六项通过。Intel Mac/Windows x64 的实际结果由 `.github/workflows/sidecar-validation.yml` 的独立矩阵提供，源码交叉编译不计为目标平台验收。正式宿主接线、打包、签名仍待后续任务。

## 许可与更新

许可证保留在 `licenses/`，SPDX 信息随锁文件和产物记录；本目录不改变项目的 GPL-3.0 许可。使用上游原始二进制，未修改 OpenList/Rclone。源码获取地址与精确 commit 已固定；正式分发时还须准备对应源码及构建材料并完成发行审查。

升级须显式更新锁文件、重新核验所有目标、重新生成脱敏夹具并执行安全/兼容检查，不能仅修改版本号。组件随 App 整包更新，运行时不执行 selfupdate。
