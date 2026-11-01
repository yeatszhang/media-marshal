/** 原测试输出和错误正文不进入汇总，只投影固定用例的结果元数据。 */
export default async function* reporter(source) {
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const value = event.data;
    if (value.details?.type === "suite") continue;
    if (event.type === "test:pass" && !Number.isInteger(value.line)) continue;
    const empty =
      event.type === "test:pass" &&
      value.name === value.file &&
      value.line === 1 &&
      value.column === 1;
    yield JSON.stringify({
      name: value.name,
      status: empty
        ? "empty"
        : value.skip
          ? "pending"
          : value.todo
            ? "todo"
            : event.type === "test:pass"
              ? "passed"
              : "failed",
      durationMs: Math.max(0, Number(value.details?.duration_ms) || 0),
      ...(Number.isInteger(value.line) && value.line > 0 ? { line: value.line } : {}),
      ...(Number.isInteger(value.column) && value.column > 0 ? { column: value.column } : {}),
    }) + "\n";
  }
}
