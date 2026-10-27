import { z } from "zod";

// 固定的宿主生命周期握手，不接受路径、任意动作或 Renderer 错误原文。
export const RENDERER_PREPARE_RELOAD_CHANNEL = "media-marshal:renderer:prepare-reload:v1";
export const RENDERER_RELOAD_RESULT_CHANNEL = "media-marshal:renderer:reload-result:v1";
export const rendererPrepareReloadSchema = z.strictObject({ id: z.uuid() });
export const rendererReloadResultSchema = z.strictObject({ id: z.uuid(), state: z.enum(["prepared", "failed"]) });
