# 旧 Java 后端维护约定

仅适用于 `backend/`；当前桌面 TypeScript Core 不使用这些 Spring/JPA 约定。先读根目录 `AGENTS.md`，按需对照[旧 API 快照](../docs/legacy/api-contracts.md)与[旧 ADR](../docs/legacy/design-decisions.md)，实际行为须核对源码和测试。

## 结构与接口

- Java 21、Spring Boot、Maven，包名 `com.mediamarshal`；Controller 保持薄层，仅校验参数并调用 service。入参和出参使用 DTO，不直接暴露 JPA 实体，响应沿用 `ApiResponse<T>`。
- `config/` 放 Spring 配置；`service/pipeline/` 编排处理；`service/matcher/` 放 `MetadataMatcher` 实现；`service/rename/` 放 `FileOperationStrategy`；实体时间戳沿用 `@PrePersist` / `@PreUpdate`。
- 运行时业务配置统一通过 `SettingsService.get()` 读取，不直接用 `@Value` 或环境变量绕过优先级；TMDB 密钥和代理的特殊优先级需核对该服务及对应测试。旧规则允许 debug 注入的示例不作为绕过此约束的理由。
- 新文件操作沿用策略注册与能力预检；新增元数据来源实现 `MetadataMatcher` 的现有契约，不改动无关策略或默认为所有场景可用。
- 实时通知通过 `websocket/EventPublisher`，不在业务代码直接调用 `SimpMessagingTemplate`。

## 日志、反馈与验证

- 使用 Lombok `@Slf4j`，不使用 `System.out.println`；业务节点用 info、非致命异常用 warn、故障用 error 并把异常放最后保留堆栈。
- debug 输出遵循现有 debug 配置与日志级别；按需记录解析、匹配评分、文件操作和事件上下文，敏感字段脱敏，不默认输出完整第三方响应或用户路径。
- 响应、任务和事件保留可信错误类别、对象及可展示原因，遵循[错误反馈约定](../docs/development/error-feedback.md)，不能只写日志或泛化为失败。
- 注释解释职责、关键取舍、参数语义和异常边界，不复述代码动作。
- 按改动在本目录执行 `mvn test` 或定向测试；接口变更核对 DTO、控制器及旧前端调用，更新对应 OpenSpec 与当前维护文档。历史实施日志冻结，不要求追加或先经旧 PM 流程。
