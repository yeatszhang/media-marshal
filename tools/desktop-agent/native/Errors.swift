import Foundation

struct ControlError: Error { let code: String; let message: String }
func reject(_ code: String, _ message: String) throws -> Never { throw ControlError(code: code, message: message) }
func encode(_ value: Any) throws -> Data { try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) }
func emit(_ value: Any) { if let bytes = try? encode(value) { FileHandle.standardOutput.write(bytes); print("") } }
