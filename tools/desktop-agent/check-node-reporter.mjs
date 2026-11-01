/** 原测试输出和错误正文不进入汇总，只投影固定用例的结果元数据。 */
export default async function* reporter(source) {
  for await (const event of source) {
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    const value = event.data;
    yield JSON.stringify({
      name: value.name,
      status: value.skip ? "pending" : event.type === "test:pass" ? "passed" : "failed",
      durationMs: Math.max(0, Number(value.details?.duration_ms) || 0),
      ...(Number.isInteger(value.line) && value.line > 0 ? { line: value.line } : {}),
      ...(Number.isInteger(value.column) && value.column > 0 ? { column: value.column } : {}),
    }) + "\n";
  }
}
