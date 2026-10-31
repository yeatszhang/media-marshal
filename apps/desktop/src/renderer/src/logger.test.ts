import { afterEach, expect, it, vi } from "vitest";
vi.mock("pino", async () => vi.importActual<typeof import("pino")>("pino/browser"));
import { logger } from "./logger";
import { RENDERER_LOG_PREFIX } from "../../logging/shared";

afterEach(() => vi.restoreAllMocks());
it("浏览器 Pino 输出可转发的 JSON，并在 Console 输出前脱敏异常和字段", () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  logger.error({ error: new Error("原始远端秘密"), credential: "凭据秘密" }, "界面异常");
  const output = error.mock.calls[0]![0] as string;
  expect(output.startsWith(RENDERER_LOG_PREFIX)).toBe(true);
  expect(output).not.toContain("原始远端秘密"); expect(output).not.toContain("凭据秘密");
  expect(JSON.parse(output.slice(RENDERER_LOG_PREFIX.length))).toMatchObject({ level: 50, scope: "renderer", msg: "界面异常", error: { type: "Error" } });
});
