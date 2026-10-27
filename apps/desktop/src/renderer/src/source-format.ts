export const sourceSize = (value: number | null) => value === null ? "大小未知" : value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KiB` : value < 1024 ** 3 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : `${(value / 1024 ** 3).toFixed(2)} GiB`;
export const sourceDate = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN") : "—";
export const sourceClients = { quark: "夸克客户端", baidu: "百度客户端", alipan: "阿里云盘客户端", custom: "自定义目录" };
export const sourceScanLabels = { IDLE: "等待下次扫描", SCANNING: "正在扫描", RETRY_WAIT: "等待重试", PAUSED: "扫描已暂停", AUTH_REQUIRED: "需要重新授权", BLOCKED_LOCAL: "原磁盘不可用", RESELECT_REQUIRED: "需要重选远端范围", FAILED: "扫描失败", CANCELLED: "旧扫描配置已取消" };
export const sourceRunLabels = { QUEUED: "等待账号与目录就绪", SCANNING: "正在枚举执行范围", SUBMITTED: "已提交下载需求", FAILED: "本次执行失败", ABANDONED: "旧版本执行已废弃" };
