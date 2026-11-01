import pino from "pino";
import { RENDERER_LOG_PREFIX, sanitizeLogValue } from "../../logging/shared";

export const logger = pino({
  level: import.meta.env.DEV ? "debug" : "info",
  browser: {
    serialize: false,
    write(record) {
      const message = RENDERER_LOG_PREFIX + JSON.stringify(sanitizeLogValue(record));
      const level = "level" in record && typeof record.level === "number" ? record.level : 30;
      if (level >= 50) console.error(message);
      else if (level >= 40) console.warn(message);
      else if (level <= 20) console.debug(message);
      else console.info(message);
    },
  },
}).child({ scope: "renderer" });
