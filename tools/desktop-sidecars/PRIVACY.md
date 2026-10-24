# 组件私有状态与诊断边界

本记录对应 OpenList `v4.2.7` 与 Rclone `v1.75.2`。Main 账号凭据保险箱、私有注入、受管 OpenList 和默认诊断导出已接线；用户账号界面和传输执行器仍由后续任务实现。

| 状态 | 已确认行为 | 约束 |
| --- | --- | --- |
| 应用权威凭据 | 当前桌面宿主写入 `userData/credentials.json`，内容由 safeStorage 加密 | 云账号扩展沿用系统保护；普通查询、日志与导出不返回密钥 |
| OpenList 初始管理员密码 | `internal/bootstrap/data/user.go` 读取 `OPENLIST_ADMIN_PASSWORD` 并在首次 stdout 输出该值 | 初始化时不把密码放入 argv；原始 stdout 必须丢弃或先脱敏，禁止直接进入日志和诊断 |
| OpenList 驱动 Cookie | `drivers/quark_uc/meta.go` 的 cookie 属于 Addition；`internal/op/storage.go` 将其序列化，`internal/db/storage.go` 直接存入组件数据库 | `sidecars/sessions/<hostGeneration>/openlist/data.db` 及 WAL、备份均视为敏感，不能宣称已被 safeStorage 加密 |
| 更新的 Cookie | Quark 驱动可能更新 `__puus` 并调用 `MustSaveDriverStorage` 持久化 | 组件私有库和配置读取接口同样必须保密，业务库只保留引用 |
| OpenList 管理接口 | storage/list 返回完整 addition，fs/get 可能返回带授权的 raw_url/sign | 不把原始管理响应回传 Renderer；字段脱敏后才能形成诊断 |
| Rclone 临时配置 | WebDAV 密码采用可逆 obscure 表示；不是加密存储 | 只放只读 WebDAV 授权，不放网盘 Cookie；私有目录、退出回收和启动核对后清理 |
| Rclone 原始 JSON 日志 | 错误可包含路径、对象名称或远端信息 | 先归一化业务错误和统计；原始流默认不导出 |

`private-paths.json` 定义相对 userData 的默认排除路径、禁止原样导出的进程流及字段。设置页默认诊断使用更严格的字段白名单，仅由 Main 构造版本、核心/组件状态、账号数量和固定错误码；完全不读取用户文件、数据库或原始日志。通过原生保存对话框选择位置，Renderer 不能传入任意输出路径。组件私有备份必须放在单独受限范围，并从普通备份排除；业务数据库备份不等于组件凭据备份。

正常退出或下次启动时，Main 先按可执行路径、完整命令、OS 创建时间和 session 标识核验并停止旧进程，再删除旧 UUID 会话目录；无法查证就保留私有目录并阻止接管。清理不遍历下载暂存/完成目录，拒绝会话根或会话目录中的符号链接/联接点。意外退出可能暂留受权限保护的明文副本，因此仍需如实说明组件私有库未加密。

在 POSIX 下先创建 0700 父目录、0600 配置，并以 `umask=0077` 启动组件；仅设置父目录仍不能自动保证子文件 0600。`contract_smoke.py` 实际验证了本机临时配置和 SQLite 文件权限；如产生附属文件，也纳入同一检查。当前夹具仅产生 config.json 和 data.db。测试还验证 guest 禁用、匿名 fs/list 和 WebDAV 被拒绝、未签名 `/d` 与 `/p` 被拒绝、只读账号无法 PUT。

三平台已实际验证 Electron 异步 safeStorage 的加密往返及明文不出现在密文中。macOS 目录/文件验证当前用户与 0700/0600；Windows 使用系统安全描述符，禁用继承并核验 owner、当前用户与 SYSTEM 的显式完整访问，不能用 chmod 位代替 ACL。证据见 `fixtures/platform-host.json`。加密不可用时拒绝保存，不写明文替代。解除挂载与删除文件均不承诺安全擦除存储介质或数据库旧页。

2026-10-24 的账号联调中，独立 Electron 窗口加载夸克页面返回 `ERR_FAILED`，改用独立 Chrome 非持久上下文完成用户扫码。凭据仅存在于内存会话和本次测试的 stdin；OpenList 临时私有库在进程停止后删除。真实账号的指定文件前 8 MiB 读取、Range 一致性、匿名拒绝和失效 Cookie 拒绝已通过，脱敏证据不包含用户名、文件路径、Cookie 或签名地址。该工具只用于 M0 验收，不代表产品已实现扫码登录。
