import Foundation

// DOM 使用 CDP；文件列表采用路径导航，不递归枚举可能无界的目录内容。
func nativeTraversalBoundary(_ role: String) -> Bool {
    ["AXWebArea", "AXOutline", "AXBrowser"].contains(role)
}
func requireNativeOwner(_ owner: Int32?, expected: Int32) throws {
    guard expected > 0, owner == expected else { try reject("PANEL_OWNER_UNKNOWN", "无法确认原生目标属于当前实例") }
}
