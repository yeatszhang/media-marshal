import Foundation

func requireNativePermission(accessibility: Bool, screenCapture: Bool, image: Bool) throws {
    guard accessibility else { try reject("ACCESSIBILITY_REQUIRED", "尚未获得辅助功能权限") }
    if image && !screenCapture { try reject("SCREEN_PERMISSION_REQUIRED", "尚未获得屏幕录制权限") }
}
