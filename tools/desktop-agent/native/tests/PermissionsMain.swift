import Foundation

@main struct PermissionChecks {
    static func main() throws {
        var codes = [String]()
        for (accessibility, screen, image) in [(false, true, false), (true, false, true)] {
            do { try requireNativePermission(accessibility: accessibility, screenCapture: screen, image: image) }
            catch let failure as ControlError { codes.append(failure.code) }
        }
        try requireNativePermission(accessibility: true, screenCapture: false, image: false)
        try requireNativePermission(accessibility: true, screenCapture: true, image: true)
        let root = FileManager.default.temporaryDirectory.appendingPathComponent("marshal-path-" + UUID().uuidString).resolvingSymlinksInPath()
        let run = root.appendingPathComponent(UUID().uuidString)
        let data = run.appendingPathComponent("data")
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        _ = try restrictedAgentPath(data.path, base: root, newFile: false)
        _ = try restrictedAgentPath(run.appendingPathComponent("new.png").path, base: root, newFile: true)
        let existing = run.appendingPathComponent("exists.png")
        try Data("fixture".utf8).write(to: existing)
        let link = run.appendingPathComponent("link")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: data)
        let broken = run.appendingPathComponent("broken.png")
        try FileManager.default.createSymbolicLink(at: broken, withDestinationURL: run.appendingPathComponent("missing"))
        var pathsRejected = [String]()
        for value in [root.deletingLastPathComponent().appendingPathComponent("outside.png"), existing, link.appendingPathComponent("new.png"), broken] {
            do { _ = try restrictedAgentPath(value.path, base: root, newFile: true) }
            catch let failure as ControlError { pathsRejected.append(failure.code) }
        }
        var ownersRejected = [String]()
        for owner: Int32? in [nil, 0, 43] {
            do { try requireNativeOwner(owner, expected: 42) }
            catch let failure as ControlError { ownersRejected.append(failure.code) }
        }
        try requireNativeOwner(42, expected: 42)
        guard nativeTraversalBoundary("AXWebArea"), nativeTraversalBoundary("AXBrowser"), nativeTraversalBoundary("AXOutline"), !nativeTraversalBoundary("AXSheet"), !nativeTraversalBoundary("AXButton") else { fatalError("原生内容边界不符") }
        emit(["rejected": codes, "pathsRejected": pathsRejected, "ownersRejected": ownersRejected, "nonImageWithoutRecording": true, "authorizedImage": true])
    }
}
