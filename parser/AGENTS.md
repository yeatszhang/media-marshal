# 旧 HTTP Parser 维护约定

仅适用于 `parser/` 的 FastAPI 服务；不适用于 `tools/desktop-parser/` 的冻结 stdio 工具。项目边界见根目录 `AGENTS.md`。

- 仅封装 guessit 文件名解析，输入名称文本、输出结构化 JSON；无业务匹配、数据库或持久化职责。
- 保持 `GET /parse?filename=...` 与 `GET /health` 契约；解析结果直接返回 guessit dict，字段语义与上游一致。
- 修改响应需同步核对 `backend/src/main/java/com/mediamarshal/model/dto/ParseResult.java` 的 `@JsonProperty` 映射及 `GuessitParserClient` 的消费和错误处理。
- 解析异常返回 HTTP 500 与 detail；空 filename 的 HTTP 400 及参数缺失的校验响应按实际 FastAPI 契约保留，不能一律改为成功或同一错误。日志和可展示详情遵循[错误反馈约定](../docs/development/error-feedback.md)，不泄露内部敏感内容。
- `requirements.txt` 固定具体版本，不改为 `>=` 浮动依赖。验证解析、健康检查、异常和 Java 消费者兼容性；未实际运行的检查不得描述为已通过。
- 新变更及验收记录归 OpenSpec 和当前维护文档，旧快照只用于行为对照。
