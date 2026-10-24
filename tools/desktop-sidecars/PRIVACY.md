# 组件私有状态与诊断边界

本记录对应 OpenList `v4.2.7` 与 Rclone `v1.75.2`。组件仍在集成前验证阶段；这里交付默认排除规则，正式诊断导出与凭据保险箱接线由后续任务 3.2/3.5 实现。

| 状态 | 已确认行为 | 约束 |
| --- | --- | --- |
| 应用权威凭据 | 当前桌面宿主写入 `userData/credentials.json`，内容由 safeStorage 加密 | 云账号扩展沿用系统保护；普通查询、日志与导出不返回密钥 |
| OpenList 初始管理员密码 | `internal/bootstrap/data/user.go` 读取 `OPENLIST_ADMIN_PASSWORD` 并在首次 stdout 输出该值 | 初始化时不把密码放入 argv；原始 stdout 必须丢弃或先脱敏，禁止直接进入日志和诊断 |
| OpenList 驱动 Cookie | `drivers/quark_uc/meta.go` 的 cookie 属于 Addition；`internal/op/storage.go` 将其序列化，`internal/db/storage.go` 直接存入组件数据库 | `sidecars/openlist/data.db` 及 WAL、备份均视为敏感，不能宣称已被 safeStorage 加密 |
| 更新的 Cookie | Quark 驱动可能更新 `__puus` 并调用 `MustSaveDriverStorage` 持久化 | 组件私有库和配置读取接口同样必须保密，业务库只保留引用 |
| OpenList 管理接口 | storage/list 返回完整 addition，fs/get 可能返回带授权的 raw_url/sign | 不把原始管理响应回传 Renderer；字段脱敏后才能形成诊断 |
| Rclone 临时配置 | WebDAV 密码采用可逆 obscure 表示；不是加密存储 | 只放只读 WebDAV 授权，不放网盘 Cookie；私有目录、退出回收和启动核对后清理 |
| Rclone 原始 JSON 日志 | 错误可包含路径、对象名称或远端信息 | 先归一化业务错误和统计；原始流默认不导出 |

`private-paths.json` 定义相对 userData 的默认排除路径、禁止原样导出的进程流及字段。组件私有备份必须放在单独受限范围，并从普通备份排除；业务数据库备份不等于组件凭据备份。后续导出器必须消费同一份规则或使用等价且更严格的白名单，不能把本文件的存在当作已经完成导出保护。

在 POSIX 下先创建 0700 父目录、0600 配置，并以 `umask=0077` 启动组件；仅设置父目录仍不能自动保证子文件 0600。`contract_smoke.py` 实际验证了本机临时配置和 SQLite 文件权限；如产生附属文件，也纳入同一检查。当前夹具仅产生 config.json 和 data.db。测试还验证 guest 禁用、匿名 fs/list 和 WebDAV 被拒绝、未签名 `/d` 与 `/p` 被拒绝、只读账号无法 PUT。

Windows 的文件权限不由 chmod 位证明，需要当前用户 ACL 和目标平台实测；这部分尚未验收。测试夹具中的 POSIX 结果不能代替 Windows 结果。解除挂载与删除文件均不承诺安全擦除存储介质或数据库旧页。

2026-10-24 的账号联调准备中，独立 Electron 扫码窗口加载夸克页面返回 `ERR_FAILED`，未取得登录 Cookie；该临时工具已移除，不作为可用登录能力。真实账号授权、会员条件、云端读取和 Cookie 失效行为仍待验证，不以本地挂载结果替代。
