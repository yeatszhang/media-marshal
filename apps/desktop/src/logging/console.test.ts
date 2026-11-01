import { afterEach, describe, expect, it, vi } from "vitest";
import { createConsoleDestination } from "./console";
import { createProcessLogger } from "./node";
import { createLogReceiver } from "./receiver";

afterEach(() => vi.unstubAllEnvs());

function fixture(isTTY: boolean) {
  let output = "";
  const logger = createProcessLogger("main", createConsoleDestination({ isTTY, write(chunk) { output += chunk; } }), "trace");
  return { logger, output: () => output };
}

describe("终端日志格式", () => {
  it("TTY 中各级别颜色不同，重定向默认不输出 ANSI", () => {
    vi.stubEnv("FORCE_COLOR", undefined); vi.stubEnv("NO_COLOR", undefined);
    const terminal = fixture(true);
    for (const level of ["trace", "debug", "info", "warn", "error", "fatal"] as const) terminal.logger[level]("级别探针");
    for (const [code, label] of [[90, "TRACE"], [34, "DEBUG"], [32, "INFO"], [33, "WARN"], [31, "ERROR"], [41, "FATAL"]]) {
      expect(terminal.output()).toContain(`\u001b[${code}m${label}`);
    }
    const redirected = fixture(false); redirected.logger.info("重定向探针");
    expect(redirected.output()).toContain("INFO: [main] 重定向探针");
    expect(redirected.output()).not.toContain("\u001b[");
  });

  it("支持强制着色和禁用颜色", () => {
    vi.stubEnv("NO_COLOR", undefined); vi.stubEnv("FORCE_COLOR", "1");
    const forced = fixture(false); forced.logger.warn("强制颜色");
    expect(forced.output()).toContain("\u001b[33mWARN");
    vi.stubEnv("FORCE_COLOR", "0");
    const disabled = fixture(true); disabled.logger.warn("禁用颜色");
    expect(disabled.output()).not.toContain("\u001b[");
    vi.stubEnv("FORCE_COLOR", "1"); vi.stubEnv("NO_COLOR", "1");
    const noColor = fixture(true); noColor.logger.error("无颜色");
    expect(noColor.output()).not.toContain("\u001b[");
  });

  it("转发 Core 异常后保留模块、请求上下文和多行堆栈", () => {
    vi.stubEnv("FORCE_COLOR", "0");
    const f = fixture(false);
    const core = createProcessLogger("core", { write(chunk) { createLogReceiver(f.logger, "core").line(chunk); } });
    core.child({ scope: "requests" }).error({ action: "runtime.get", requestId: "request-1", durationMs: 12, error: new TypeError("原始远端秘密") }, "核心请求失败");
    expect(f.output()).toContain("ERROR: [core/requests] 核心请求失败 action=runtime.get requestId=request-1 durationMs=12");
    expect(f.output()).toContain("error: type=TypeError\n");
    expect(f.output()).toMatch(/\n\s+at .*console\.test\.ts/);
    expect(f.output()).not.toContain("原始远端秘密");
    expect(f.output()).not.toContain('"level":');
    expect(f.output()).not.toContain("\\n");
  });
});
