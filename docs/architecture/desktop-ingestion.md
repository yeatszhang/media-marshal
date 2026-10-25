# 桌面整理流水线

实现位于 `packages/media-core/src/ingestion/`，只有 Core 写 SQLite。schema v7 追加来源授权、候选、计划、COPY 操作、媒体目标路由与独立 Emby 交付表，v8 追加附属文件的独立提交记录；迁移前沿用一致性备份机制，不读取 Java 数据库。Main 通过 safeStorage 保存服务密钥，Core 启动后经私有通道注入内存，公开设置只有是否已配置的布尔值。

来源可为普通目录或受管下载，界面明确区分。受管接收器依据已完成下载及 RECORDED 提交意图接收 `itemId/versionKey`；outbox 重投和 completed 补扫走相同持久唯一键。确认回执丢失后不增加候选，不重传原文件；completed 内没有提交记录的外部文件不被接收，staging 和 `.media-marshal` 不属于候选入口。接收成功只代表候选已保存，不产生媒体 DONE。

启动、每十秒、文件事件提示和手动扫描共用就绪检查；事件经有界延迟合并，同一来源扫描合并为一次执行，事件丢失由定时补扫补偿。观察使用单调时钟，至少连续稳定 120 秒，超长调度停顿、重启、唤醒或暂停恢复会重新计时；零字节和临时文件不能就绪。来源目录句柄、卷身份、实际路径及文件身份同时核验，不能因路径名称相同而绑定替代硬盘。官方客户端行为尚未经版本化验证，当前全部来源保持人工确认，稳定尺寸不能作为完整下载证明。

设置页通过原生目录选择分别授权电影与剧集目录，预览按确认后的媒体类型路由。来源与所有目标、受管根及历史操作保留的目标不能相互包含。Mac 写目标沿用 APFS/HFS+ 原卷探测及实际硬链接提交能力测试；其他文件系统不能证明相同保证时阻止写入，不将未验证平台算作兼容结果。

每个 COPY 操作持久记录 PLANNED、COPYING、VERIFIED、FILE_COMMITTED 与 RECORDED。内容流式写入目标卷的私有暂存区，复制后重新读取来源摘要并核验文件快照，再核对暂存长度和摘要。正式发布使用不覆盖的硬链接；目标抢占或归属证据不符转需处理。已验证的操作恢复只补提交与记账，来源始终保留；清理只处理具有本操作标记的暂存文件。

预览可选择同名字幕、附属文件及通用封面，并逐项列出目标；这些文件同样需要稳定观察。schema v8 为每个附属文件独立保存尝试、摘要与提交阶段，主视频已完成而字幕失败时作业显示部分失败，重试只处理失败附属文件，不复制主视频。初步真实文件用例已覆盖字幕目标抢占与独立重试；批量确认、修正及完整附属文件/崩溃矩阵仍按前案独立任务继续实施，不能据此勾选整条任务。

文件 DONE 与 Emby 交付独立。连接验证读取服务器身份、库路径和读取权限，并实际验证刷新权限；电影与剧集目录分别绑定服务端库。服务端路径必须在这台 Mac 上可访问并包含目标，不自动猜容器或远程 NAS 映射。接受刷新不代表收录成功，Emby 请求不继承 TMDB 代理。

交付意图与文件记账在同一事务中写入，启动也补建缺失意图。按连接版本在三十秒窗口合并刷新，故障退避从三十秒增长到十五分钟并持久保存；认证失败暂停整个连接，修复后重新验证。每十五秒分页核对限定库，最多等待十分钟。核对同时匹配目标路径、电影/剧集类型、作品 TMDB 标识和季集；集级 TMDB ID 不冒充剧集作品 ID，须读取其 Series 的 ProviderIds。证据缺失、冲突或超时保留待处理，重试交付不调用 COPY。打开 Emby 前再次检查服务器身份，地址不携带密钥。

接口依据：[服务器身份](https://dev.emby.media/reference/RestAPI/SystemService/getSystemInfo.html)、[媒体库分页](https://dev.emby.media/reference/RestAPI/LibraryStructureService/getLibraryVirtualfoldersQuery.html)、[限定库条目分页](https://dev.emby.media/reference/RestAPI/ItemsService/getItems.html)、[刷新权限](https://dev.emby.media/reference/RestAPI/LibraryService/postLibraryRefresh.html)。

验证命令为 `npm test -- packages/media-core/src/domain packages/media-core/src/ingestion`，以及 `npm test -- apps/desktop/src/main/cloud/downloads.test.ts -t '生产接收端'`。这些是实际 SQLite、真实本地文件和固定 HTTP 响应测试；用户服务器的真实收录验收、完整 Mac 安装态回归及当前工作树的新安装包仍继续进行。既有 0.2.1 DMG 不含本轮流水线，不能沿用它的通过记录证明新代码已安装验收。

本次源码提交保留开发检查点：本地 COPY 不依赖 Emby 连接验证，现有电影和剧集库直接复用；Emby 刷新/收录为独立步骤。尚未完成真实服务器链路、嵌套签名公证、Mac Intel 运行及所有前案任务，未生成包含本轮代码的新 DMG，不归档变更或标记正式发行。
