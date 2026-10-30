/** 仅将可信失败码投影为修复文案，不返回第三方响应或原始错误。 */
export function embyFailureMessage(code: string) {
  const messages: Record<string, string> = {
    AUTH_REQUIRED: "Emby 密钥无效或权限不足，请在设置重新验证连接，再仅重试交付。",
    CONNECTION_CHANGED: "Emby 连接已变化，旧收录证据已失效。请在设置重新发现关联，再仅重试交付。",
    LIBRARY_CONFIGURATION_CHANGED: "Emby 媒体库配置已变化，请在设置重新发现库根关联，再仅重试交付。",
    LIBRARY_PATH_MISMATCH: "目标没有可用的 Emby 库根关联，请在设置核对两侧完整路径或显式转换，再仅重试交付。",
    LIBRARY_TYPE_MISMATCH: "Emby 库类型与媒体不兼容，请核对电影／剧集目标及库类型，再仅重试交付。",
    BINDING_CHANGED: "Emby 路径转换或绑定版本已变化，旧证据已失效。请核对当前关联，再仅重试交付。",
    TARGET_CHANGED: "已整理目标文件的身份或内容已变化，请核对原媒体文件和磁盘后再重试交付。",
    CHECK_TIMEOUT: "Emby 收录核对超时，请检查目标路径、媒体库读取权限和元数据，再仅重试交付。",
    NETWORK_UNAVAILABLE: "暂时无法连接 Emby，已保留刷新意图并退避重试；请检查服务器和网络，媒体文件保留。",
    TIMEOUT: "Emby 请求超时，已保留交付并退避重试；请检查服务器与网络。",
    RATE_LIMITED: "Emby 请求受到限制，交付会等待后重试，媒体文件保留。",
    INVALID_RESPONSE: "Emby 响应无法核对，请检查服务器地址及版本，再重新验证连接。",
    UNSAFE_PATH: "目标路径与冻结的 Emby 绑定不一致，请核对原媒体目录和路径转换，再仅重试交付。",
    LOCAL_UNAVAILABLE: "原媒体目录或磁盘不可用，请恢复原卷与目录授权，再仅重试交付。",
  };
  return messages[code] ?? "Emby 交付未能完成，请核对原目标文件、媒体库关联和连接设置后，仅重试交付。";
}
