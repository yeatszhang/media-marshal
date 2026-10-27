import { DesktopError } from "@media-marshal/contracts";
import { RecognitionError } from "../domain/media.js";
import { MediaNetworkError } from "../infrastructure/json-http.js";
/** 领域错误只包含受控名称规则；网络错误使用固定文案，不把原始响应传到 Renderer。 */
export function previewFailure(error: unknown) {
  if (error instanceof RecognitionError) return new DesktopError(error.code === "TEMPLATE_INVALID" ? "INVALID_REQUEST" : "CONFLICT", error.message.slice(0, 500), error.code === "METADATA_UNAVAILABLE");
  if (error instanceof MediaNetworkError) {
    const message = { AUTH_REQUIRED: "TMDB 密钥无效或权限不足，请在设置保存有效密钥后重新预览", RATE_LIMITED: "TMDB 请求受到限制，请稍后重新预览", NETWORK_UNAVAILABLE: "无法连接 TMDB，请核对网络和代理后重新预览", INVALID_RESPONSE: "TMDB 信息不完整或格式不受支持，请稍后重新预览并核对季集", INTERRUPTED: "预览已停止等待，请查询当前状态或重新预览", TIMEOUT: "TMDB 请求超时，请核对网络和代理后重新预览" }[error.code];
    return new DesktopError(error.code === "INVALID_RESPONSE" ? "UNSUPPORTED_CAPABILITY" : error.code, message, !["AUTH_REQUIRED", "INVALID_RESPONSE"].includes(error.code), error.retryAfterSeconds);
  }
  return error;
}
