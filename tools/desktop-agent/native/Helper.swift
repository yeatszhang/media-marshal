import Foundation
import AppKit
import ApplicationServices
import CoreGraphics
import ScreenCaptureKit
import CryptoKit
import Darwin

let repository = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().standardizedFileURL

struct Input: Decodable {
    let command: String
    let pid: Int32
    let executable: String
    let profile: String
    let generation: String?
    let path: [Int]?
    let fingerprint: String?
    let text: String?
    let key: String?
    let windowID: UInt32?
    let output: String?
    let screenX: Double?
    let screenY: Double?
}
func processGeneration(_ pid: Int32) throws -> String {
    var information = proc_bsdinfo()
    let size = Int32(MemoryLayout<proc_bsdinfo>.size)
    guard proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, &information, size) == size, information.pbi_start_tvsec > 0 else { try reject("PROCESS_IDENTITY_UNAVAILABLE", "无法读取目标内核创建时间") }
    return "\(information.pbi_start_tvsec):\(information.pbi_start_tvusec)"
}
func sessionLocked() -> Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else { return true }
    let locked = session["CGSSessionScreenIsLocked"] as? Bool ?? false
    let onConsole = session[kCGSessionOnConsoleKey as String] as? Bool ?? false
    return locked || !onConsole
}
func trustedApplication(_ input: Input) throws -> NSRunningApplication {
    guard input.pid > 0, let app = NSRunningApplication(processIdentifier: input.pid), let executable = app.executableURL?.resolvingSymlinksInPath().path else { try reject("PROCESS_UNAVAILABLE", "目标进程不存在") }
    let expected = URL(fileURLWithPath: input.executable).resolvingSymlinksInPath().path
    let electron = repository.appendingPathComponent("node_modules/electron/dist/Electron.app/Contents/MacOS/Electron").resolvingSymlinksInPath().path
    let packages = repository.appendingPathComponent("apps/desktop/release").path + "/"
    guard executable == expected, expected == electron || expected.hasPrefix(packages) else { try reject("PROCESS_MISMATCH", "目标不是本工作树的桌面实例") }
    let profile = try restrictedAgentPath(input.profile, base: repository.appendingPathComponent("test-results/agent"), newFile: false).path
    guard profile.hasSuffix("/data") else { try reject("PROFILE_MISMATCH", "目标不是开发工具的隔离目录") }
    let query = Process(), pipe = Pipe()
    query.executableURL = URL(fileURLWithPath: "/bin/ps"); query.arguments = ["-p", String(input.pid), "-o", "args="]; query.standardOutput = pipe; query.standardError = Pipe()
    try query.run(); let bytes = pipe.fileHandleForReading.readDataToEndOfFile(); query.waitUntilExit()
    let command = String(data: bytes, encoding: .utf8) ?? ""
    guard query.terminationStatus == 0, command.contains("--user-data-dir=" + profile) else { try reject("PROFILE_MISMATCH", "进程未使用本会话的数据目录") }
    if let generation = input.generation {
        guard try processGeneration(input.pid) == generation else { try reject("GENERATION_MISMATCH", "目标进程已更换代际") }
    } else if input.command != "identity" { try reject("GENERATION_REQUIRED", "操作须携带进程创建时间") }
    return app
}
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var result: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, name as CFString, &result) == .success else { return nil }
    return result
}
func children(_ element: AXUIElement) -> [AXUIElement] { attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? [] }
func geometry(_ element: AXUIElement) -> [String: Double] {
    var point = CGPoint.zero, size = CGSize.zero
    if let value = attribute(element, kAXPositionAttribute), CFGetTypeID(value) == AXValueGetTypeID() { AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cgPoint, &point) }
    if let value = attribute(element, kAXSizeAttribute), CFGetTypeID(value) == AXValueGetTypeID() { AXValueGetValue(unsafeBitCast(value, to: AXValue.self), .cgSize, &size) }
    return ["x": point.x, "y": point.y, "width": size.width, "height": size.height]
}
func windowRecords(_ pid: Int32) -> [[String: Any]] {
    guard let all = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] else { return [] }
    return all.filter { ($0[kCGWindowOwnerPID as String] as? Int32) == pid }.map { row in
        ["id": row[kCGWindowNumber as String] ?? 0, "bounds": row[kCGWindowBounds as String] ?? [:], "layer": row[kCGWindowLayer as String] ?? 0, "onScreen": row[kCGWindowIsOnscreen as String] ?? false]
    }
}
func sameRectangle(_ left: CGRect, _ right: CGRect) -> Bool {
    abs(left.minX - right.minX) < 1 && abs(left.minY - right.minY) < 1 && abs(left.width - right.width) < 1 && abs(left.height - right.height) < 1
}
func ownedPointWindow(_ input: Input) throws -> CGRect? {
    guard let x = input.screenX, let y = input.screenY, x.isFinite, y.isFinite else { try reject("POINT_REQUIRED", "命中核验需要窗口内的有限坐标") }
    var element: AXUIElement?
    guard AXUIElementCopyElementAtPosition(AXUIElementCreateSystemWide(), Float(x), Float(y), &element) == .success, let hit = element else { try reject("HIT_TEST_UNAVAILABLE", "无法核验目标位置的原生窗口") }
    var owner: pid_t = 0
    guard AXUIElementGetPid(hit, &owner) == .success, owner == input.pid else { return nil }
    let window: AXUIElement
    if attribute(hit, kAXRoleAttribute) as? String == "AXWindow" { window = hit }
    else {
        guard let value = attribute(hit, kAXWindowAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { try reject("HIT_WINDOW_UNKNOWN", "无法确认命中元素所属窗口") }
        window = unsafeBitCast(value, to: AXUIElement.self)
    }
    let frame = geometry(window)
    guard let width = frame["width"], let height = frame["height"], width > 0, height > 0 else { try reject("HIT_WINDOW_UNKNOWN", "命中窗口缺少可核验几何信息") }
    return CGRect(x: frame["x"]!, y: frame["y"]!, width: width, height: height)
}
func visibilityRecords(_ input: Input) throws -> [String: Any] {
    let pid = input.pid
    guard let rows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { try reject("WINDOW_STATE_UNAVAILABLE", "无法核验屏幕窗口次序") }
    var windows = [[String: Any]]()
    func bounds(_ row: [String: Any]) -> CGRect? {
        guard let value = row[kCGWindowBounds as String] as? NSDictionary else { return nil }
        return CGRect(dictionaryRepresentation: value)
    }
    let hasPoint = input.screenX != nil || input.screenY != nil
    if hasPoint {
        guard let x = input.screenX, let y = input.screenY, rows.contains(where: { ($0[kCGWindowOwnerPID as String] as? Int32) == pid && bounds($0)?.contains(CGPoint(x:x,y:y)) == true }) else { try reject("POINT_OUTSIDE_TARGET", "坐标不属于自有窗口") }
    }
    let pointWindow = hasPoint && !sessionLocked() ? try ownedPointWindow(input) : nil
    for (index, row) in rows.enumerated() where (row[kCGWindowOwnerPID as String] as? Int32) == pid {
        guard let rectangle = bounds(row) else { try reject("WINDOW_STATE_UNAVAILABLE", "自有窗口缺少位置证据") }
        let occluded = rows.prefix(index).contains { higher in
            if (higher[kCGWindowAlpha as String] as? Double ?? 1) <= 0 || (higher[kCGWindowLayer as String] as? Int ?? 0) < 0 { return false }
            guard let frame = bounds(higher) else { return true }
            return !frame.intersection(rectangle).isNull
        }
        let pointOwned: Any = hasPoint ? (pointWindow.map { sameRectangle($0, rectangle) } ?? false) as Any : NSNull()
        windows.append(["id": row[kCGWindowNumber as String] ?? 0,
                        "bounds": ["x": rectangle.minX, "y": rectangle.minY, "width": rectangle.width, "height": rectangle.height],
                        "occluded": occluded, "pointOwned": pointOwned])
    }
    return ["source": "native-window-metadata", "sessionLocked": sessionLocked(), "frontmost": NSWorkspace.shared.frontmostApplication?.processIdentifier == pid, "windows": windows]
}
func snapshot(_ root: AXUIElement, pid: Int32) throws -> [String: Any] {
    var nodes = [[String: Any]](), truncated = false, omissions = [[String: Any]]()
    func omit(_ path: [Int], _ reason: String) {
        truncated = true
        if omissions.count < 100 { omissions.append(["path": path, "reason": reason]) }
    }
    func walk(_ element: AXUIElement, _ path: [Int], _ depth: Int) {
        guard nodes.count < 500 else { omit(path, "node-limit"); return }
        guard depth < 24 else { omit(path, "depth-limit"); return }
        var owner: pid_t = 0
        guard AXUIElementGetPid(element, &owner) == .success, owner == pid else { omit(path, "unknown-owner"); return }
        let role = attribute(element, kAXRoleAttribute) as? String ?? "unknown"
        let title = attribute(element, kAXTitleAttribute) as? String ?? attribute(element, kAXDescriptionAttribute) as? String ?? ""
        nodes.append(["path": path, "role": role, "subrole": attribute(element, kAXSubroleAttribute) as? String ?? "", "name": String(title.prefix(200)), "enabled": attribute(element, kAXEnabledAttribute) as? Bool ?? false, "focused": attribute(element, kAXFocusedAttribute) as? Bool ?? false, "bounds": geometry(element), "secure": role == "AXSecureTextField"])
        // 保留原生控件及明确的内容边界，不递归枚举 Renderer 和无界文件列表。
        if nativeTraversalBoundary(role) { return }
        for (index, child) in children(element).enumerated() {
            // Apple 菜单属于系统，不开放其遍历及动作。
            if role == "AXMenuBar" && index == 0 { continue }
            walk(child, path + [index], depth + 1)
        }
    }
    walk(root, [], 0)
    let windows = windowRecords(pid)
    let fingerprint = SHA256.hash(data: try encode(["nodes": nodes, "windows": windows, "omissions": omissions])).map { String(format: "%02x", $0) }.joined()
    return ["nodes": nodes, "windows": windows, "fingerprint": fingerprint, "truncated": truncated, "omissions": omissions, "coordinates": "screen-points-top-left", "coverage": "native-controls-content-boundaries"]
}
func target(_ root: AXUIElement, _ path: [Int]) throws -> AXUIElement {
    guard path.count < 24 else { try reject("INVALID_TARGET", "原生目标路径过深") }
    var element = root
    for index in path {
        if nativeTraversalBoundary(attribute(element, kAXRoleAttribute) as? String ?? "") { try reject("NATIVE_CONTENT_BOUNDARY", "此内容区域不属于原生控件观察范围，不能向未观察路径输入") }
        if attribute(element, kAXRoleAttribute) as? String == "AXMenuBar" && index == 0 { try reject("SYSTEM_MENU_REJECTED", "系统菜单不属于开发实例的控制范围") }
        let values = children(element)
        guard index >= 0, index < values.count else { try reject("STALE_TARGET", "原生目标已变化，请重新观察") }
        element = values[index]
    }
    return element
}
func pressKey(_ value: String, pid: Int32) throws {
    let keys: [String: (CGKeyCode, CGEventFlags)] = ["Escape": (53, []), "Enter": (36, []), "Tab": (48, []), "Command+Shift+G": (5, [.maskCommand, .maskShift]), "Command+R": (15, [.maskCommand]), "Command+W": (13, [.maskCommand])]
    guard let (code, flags) = keys[value], NSWorkspace.shared.frontmostApplication?.processIdentifier == pid else { try reject("FOCUS_MISMATCH", "按键不在允许清单内，或焦点已离开目标实例") }
    guard let source = CGEventSource(stateID: .privateState) else { try reject("INPUT_UNAVAILABLE", "无法创建原生按键源") }
    let modifiers: [(CGKeyCode, CGEventFlags)] = [(55, .maskCommand), (56, .maskShift)].filter { flags.contains($0.1) }
    var sequence = [(CGKeyCode, Bool, CGEventFlags)](), held = CGEventFlags()
    for (modifier, flag) in modifiers { held.insert(flag); sequence.append((modifier, true, held)) }
    sequence.append((code, true, flags)); sequence.append((code, false, flags))
    for (modifier, flag) in modifiers.reversed() { held.remove(flag); sequence.append((modifier, false, held)) }
    // 先构造整个序列，失败不发送半个组合键；所有抬起事件仍只发给原 PID。
    let events = try sequence.map { (key, down, held) -> CGEvent in
        guard let event = CGEvent(keyboardEventSource: source, virtualKey: key, keyDown: down) else { try reject("INPUT_UNAVAILABLE", "无法创建原生按键") }
        event.flags = held; return event
    }
    for event in events { event.postToPid(pid); usleep(20000) }
    RunLoop.current.run(until: Date(timeIntervalSinceNow: 0.05))
}
@available(macOS 14.0, *)
func capture(_ input: Input, root: AXUIElement, observed: [String: Any]) async throws -> [String: Any] {
    try requireNativePermission(accessibility: AXIsProcessTrusted(), screenCapture: CGPreflightScreenCaptureAccess(), image: true)
    guard !sessionLocked() else { try reject("NATIVE_SESSION_LOCKED", "系统锁屏时不能捕获原生窗口") }
    guard let fingerprint = input.fingerprint, fingerprint == observed["fingerprint"] as? String else { try reject("STALE_SNAPSHOT", "窗口捕获前原生界面已经变化") }
    guard let id = input.windowID, let output = input.output else { try reject("INVALID_INPUT", "截图需要明确窗口及输出文件") }
    let destination = try restrictedAgentPath(output, base: repository.appendingPathComponent("test-results/agent"), newFile: true)
    guard destination.pathExtension == "png" else { try reject("OUTPUT_REJECTED", "截图只能写入新的会话 PNG 文件") }
    guard let records = observed["windows"] as? [[String: Any]], records.contains(where: { ($0["id"] as? UInt32) == id }) else { try reject("WINDOW_MISMATCH", "截图窗口不属于当前快照") }
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let window = content.windows.first(where: { $0.windowID == id && $0.owningApplication?.processID == input.pid }) else { try reject("WINDOW_MISMATCH", "截图窗口不属于当前实例") }
    let config = SCStreamConfiguration(); config.width = max(1, Int(window.frame.width * 2)); config.height = max(1, Int(window.frame.height * 2)); config.showsCursor = false
    let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: window), configuration: config)
    let bitmap = NSBitmapImageRep(cgImage: image)
    guard let data = bitmap.representation(using: .png, properties: [:]) else { try reject("CAPTURE_FAILED", "无法编码窗口截图") }
    let after = try snapshot(root, pid: input.pid)
    guard fingerprint == after["fingerprint"] as? String else { try reject("STALE_SNAPSHOT", "窗口捕获期间原生界面发生变化，未写入图片") }
    try data.write(to: destination, options: .withoutOverwriting)
    return ["path": destination.path, "width": image.width, "height": image.height, "windowID": id, "source": "native", "fingerprint": fingerprint, "generation": try processGeneration(input.pid)]
}
func act(_ input: Input, app: NSRunningApplication, root: AXUIElement, observed: [String: Any]) throws -> [String: Any] {
    guard let fingerprint = input.fingerprint, fingerprint == observed["fingerprint"] as? String else { try reject("STALE_SNAPSHOT", "原生界面已经变化，请重新观察") }
    guard !sessionLocked() else { try reject("NATIVE_SESSION_LOCKED", "系统锁屏时不能执行原生输入") }
    if input.command == "activate" {
        app.unhide()
        guard app.activate(options: []) else { try reject("ACTIVATE_REJECTED", "目标实例未接受激活请求") }
        return ["status": "sent", "requiresPostcondition": true]
    }
    guard NSWorkspace.shared.frontmostApplication?.processIdentifier == input.pid else { try reject("FOCUS_MISMATCH", "焦点已离开目标实例") }
    if input.command == "key" {
        guard let value = attribute(root, kAXFocusedUIElementAttribute), CFGetTypeID(value) == AXUIElementGetTypeID() else { try reject("NATIVE_FOCUS_UNKNOWN", "无法核验原生键盘焦点归属") }
        var focusOwner: pid_t = 0
        let focused = unsafeBitCast(value, to: AXUIElement.self)
        try requireNativeOwner(AXUIElementGetPid(focused, &focusOwner) == .success ? focusOwner : nil, expected: input.pid)
        try pressKey(input.key ?? "", pid: input.pid)
        return ["status": "sent", "requiresPostcondition": true]
    }
    guard let path = input.path else { try reject("INVALID_TARGET", "操作须指定快照内的目标") }
    guard let records = observed["nodes"] as? [[String: Any]], records.contains(where: { ($0["path"] as? [Int]) == path }) else { try reject("NATIVE_TARGET_UNOBSERVED", "目标未包含在当前可信观察中，未知面板或省略区域不接受输入") }
    let element = try target(root, path)
    var owner: pid_t = 0
    try requireNativeOwner(AXUIElementGetPid(element, &owner) == .success ? owner : nil, expected: input.pid)
    guard attribute(element, kAXEnabledAttribute) as? Bool == true else { try reject("NOT_ACTIONABLE", "原生控件不可操作") }
    let result: AXError
    switch input.command {
    case "press":
        guard ["AXButton", "AXCheckBox", "AXRadioButton", "AXMenuItem", "AXMenuBarItem", "AXPopUpButton"].contains(attribute(element, kAXRoleAttribute) as? String ?? "") else { try reject("ROLE_REJECTED", "此原生角色不在基础操作清单内") }
        result = AXUIElementPerformAction(element, kAXPressAction as CFString)
    case "fill":
        let role = attribute(element, kAXRoleAttribute) as? String
        guard ["AXTextField", "AXTextArea", "AXComboBox"].contains(role ?? ""), let text = input.text, text.count <= 4096 else { try reject("INVALID_INPUT", "仅允许向受限文本控件输入") }
        result = AXUIElementSetAttributeValue(element, kAXValueAttribute as CFString, text as CFString)
    default: try reject("UNKNOWN_COMMAND", "原生操作未在允许清单内")
    }
    guard result == .success else { try reject("ACTION_REJECTED", "系统未接受原生操作，请重新观察") }
    return ["status": "sent", "requiresPostcondition": true]
}
@main struct NativeHelper {
    static func main() async {
        do {
            if CommandLine.arguments.dropFirst().first == "capabilities" {
                emit(["protocolVersion": 1, "accessibility": AXIsProcessTrusted(), "screenCapture": CGPreflightScreenCaptureAccess(), "sessionLocked": sessionLocked()]); return
            }
            let bytes = try FileHandle.standardInput.read(upToCount: 65537) ?? Data()
            guard bytes.count <= 65536 else { try reject("INPUT_TOO_LARGE", "原生请求超过允许大小") }
            let input = try JSONDecoder().decode(Input.self, from: bytes), app = try trustedApplication(input)
            if input.command == "identity" { emit(["pid": app.processIdentifier, "generation": try processGeneration(input.pid)]); return }
            try requireNativePermission(accessibility: AXIsProcessTrusted(), screenCapture: CGPreflightScreenCaptureAccess(), image: false)
            if input.command == "window-state" { emit(try visibilityRecords(input)); return }
            let root = AXUIElementCreateApplication(input.pid)
            let observed = try snapshot(root, pid: input.pid)
            if input.command == "capture" {
                guard #available(macOS 14.0, *) else { try reject("UNSUPPORTED", "当前 macOS 不支持此窗口截图驱动") }
                emit(try await capture(input, root: root, observed: observed)); return
            }
            if input.command == "observe" { emit(observed); return }
            emit(try act(input, app: app, root: root, observed: observed))
        } catch let error as ControlError { emit(["status": "blocked", "error": ["code": error.code, "message": error.message]]); exit(2) }
        catch { emit(["status": "failed", "error": ["code": "NATIVE_FAILURE", "message": "原生请求未完成，请核对输入、实例身份和系统能力"]]); exit(1) }
    }
}
