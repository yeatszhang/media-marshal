/** 宿主注入结构化 logger；业务核心不持有日志文件或 Electron 能力。 */
export interface CoreLogger {
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
}

export const silentLogger: CoreLogger = { debug() {}, info() {}, warn() {}, error() {} };

export function scopedLogger(logger: CoreLogger | undefined, scope: string): CoreLogger {
  const target = logger ?? silentLogger;
  return {
    debug: (fields, message) => target.debug({ ...fields, scope }, message),
    info: (fields, message) => target.info({ ...fields, scope }, message),
    warn: (fields, message) => target.warn({ ...fields, scope }, message),
    error: (fields, message) => target.error({ ...fields, scope }, message),
  };
}
