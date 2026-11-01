const sensitiveKey =
  /cookie|authorization|password|passwd|secret|token|api[-_]?key|credential|ciphertext|private[-_]?key|二维码|sessionStorage|localStorage/i;
export function sensitiveMarker(text: string) {
  return /(?:Bearer\s+[A-Za-z0-9._~+/=-]{8,}|\bsk-[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|(?:cookie|authorization|api[-_]?key|password|(?:access[-_]?)?token|secret|credential)["'\s]*[:=]["'\s]*[^\s"',;}\]]{6,})/i.test(
    text,
  );
}
export function redactExport(root: string, value: unknown) {
  let redactions = 0,
    truncated = false,
    visited = 0;
  const text = (input: string) => {
    if (input.includes(root)) redactions += input.split(root).length - 1;
    let result = input.split(root).join("<workspace>");
    result = result.replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw);
        if (url.username || url.password || url.search || url.hash) redactions++;
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.toString();
      } catch {
        redactions++;
        return "[已脱敏 URL]";
      }
    });
    result = result.replace(
      /(?:\/Users\/|\/home\/|\/private\/var\/folders\/|[A-Za-z]:\\Users\\)[^\s"'<>]*/g,
      () => {
        redactions++;
        return "<private-path>";
      },
    );
    if (sensitiveMarker(result)) {
      redactions++;
      return "[已脱敏文本]";
    }
    if (result.length > 8192) {
      truncated = true;
      return result.slice(0, 8192) + "[已截断]";
    }
    return result;
  };
  const walk = (input: unknown, depth: number): unknown => {
    if (++visited > 100000 || depth > 32) {
      truncated = true;
      return "[已省略]";
    }
    if (typeof input === "string") return text(input);
    if (!input || typeof input !== "object") return input;
    if (Array.isArray(input)) {
      if (input.length > 5000) truncated = true;
      return input.slice(0, 5000).map((entry) => walk(entry, depth + 1));
    }
    const object = input as Record<string, unknown>;
    const namedSecret = typeof object.name === "string" && sensitiveKey.test(object.name);
    const secretInput = object.type === "password" || object.secure === true;
    const entries = Object.entries(object);
    if (entries.length > 500) truncated = true;
    return Object.fromEntries(
      entries.slice(0, 500).map(([key, item]) => {
        if (sensitiveKey.test(key) || (key === "value" && (namedSecret || secretInput))) {
          redactions++;
          return [key, "[已脱敏]"];
        }
        return [key, walk(item, depth + 1)];
      }),
    );
  };
  return { value: walk(value, 0), redactions, truncated };
}
