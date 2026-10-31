import pino, { type Bindings, type DestinationStream, type Logger, type LogFn } from "pino";
import { logLevel, sanitizeLogValue } from "./shared";

export function createProcessLogger(
  processName: string,
  destination: DestinationStream = pino.destination({ dest: 1, sync: true }),
  level = logLevel(process.env.MARSHAL_LOG_LEVEL, "debug"),
): Logger {
  const logger = pino(
    {
      level,
      base: { process: processName, pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
      formatters: { bindings: (bindings) => sanitizeLogValue(bindings) as Record<string, unknown> },
      hooks: {
        logMethod(args, method) {
          method.apply(this, args.map((value) => sanitizeLogValue(value)) as Parameters<LogFn>);
        },
      },
    },
    destination,
  );
  return protectBindings(logger);
}

function protectBindings<Levels extends string>(
  logger: Logger<Levels>,
  originalChild: Logger<Levels>["child"] = logger.child,
): Logger<Levels> {
  // Pino 的 child() 默认重置 bindings formatter，因此在绑定序列化之前处理。
  // bind() 的类型推导会丢失 child() 的泛型签名，显式保留以支持子日志选项。
  const child = originalChild.bind(logger) as Logger<Levels>["child"];
  logger.child = (bindings, options) => {
    const next = child(sanitizeLogValue(bindings) as Bindings, options);
    return protectBindings(next, originalChild as typeof next.child);
  };
  const setBindings = logger.setBindings;
  logger.setBindings = function (bindings) {
    setBindings.call(this, sanitizeLogValue(bindings) as Bindings);
  };
  return logger;
}

let root = createProcessLogger("main");
export function setRootLogger(logger: Logger): void {
  root = logger;
}
export function getLogger(scope: string): Logger {
  return root.child({ scope });
}
