import Foundation

// 仅接受 agent/<UUID>/ 内的现存路径或新文件；根目录和任意中间链接均拒绝。
func restrictedAgentPath(_ value: String, base: URL, newFile: Bool) throws -> URL {
    let root = base.standardizedFileURL
    let destination = URL(fileURLWithPath: value).standardizedFileURL
    guard root.path == root.resolvingSymlinksInPath().path,
          destination.path.hasPrefix(root.path + "/") else { try reject("AGENT_PATH_REJECTED", "路径不属于无链接的会话根目录") }
    let relative = String(destination.path.dropFirst(root.path.count + 1)).split(separator: "/")
    guard relative.count >= 2, UUID(uuidString: String(relative[0])) != nil else { try reject("AGENT_PATH_REJECTED", "路径缺少明确的运行身份") }
    var cursor = root
    for (index, component) in relative.enumerated() {
        cursor.appendPathComponent(String(component))
        let last = index == relative.count - 1
        let exists = FileManager.default.fileExists(atPath: cursor.path)
        // dangling symlink 的 fileExists 为 false，资源查询仍须拒绝。
        let values = try? cursor.resourceValues(forKeys: [.isSymbolicLinkKey, .isDirectoryKey])
        guard values?.isSymbolicLink != true, cursor.path == cursor.resolvingSymlinksInPath().path else { try reject("AGENT_PATH_REJECTED", "会话路径包含符号链接") }
        if newFile && last {
            guard !exists, values == nil else { try reject("OUTPUT_REJECTED", "证据文件已存在，不允许覆盖") }
        } else {
            guard exists, values?.isDirectory == true else { try reject("AGENT_PATH_REJECTED", "会话目录不存在或不是目录") }
        }
    }
    return destination
}
