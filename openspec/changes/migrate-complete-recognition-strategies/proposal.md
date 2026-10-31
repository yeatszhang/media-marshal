# Proposal

## Why

桌面迁移遗漏了旧服务端已经调好的 Codex 聚类、别名查证、单文件兜底及目录重识别。用户要求完整迁移识别行为和原测试 case，避免纯数字、动漫累计集号及非正式目录名退化为人工猜测。

## What Changes

- 将旧 Codex 识别引擎及其全部 Python 回归迁入当前冻结运行资源，通过有界 stdio 调用，不依赖 Java、HTTP bridge 或系统 Python。
- 接通 GuessIt → 作品聚类 → TMDB／父目录增强 → 单文件低分兜底，以及单文件和同目录主动重识别。
- 保留共同身份缓存、unknown 冷却、跨季／新增单集复用、调用预算、用量统计及结构校验。
- 保留模型 90% 与 TMDB 默认 80% 双阈值、真实季集、合并集、重复及目标冲突校验；接入桌面已有的授权预览、持久 COPY 和恢复边界。
- 建立旧 Java／Python 用例逐项对照，迁入已有规则夹具未覆盖的识别与典型 case；增加冻结资源、IPC 和界面验证。

## Capabilities

### New Capabilities
- `codex-media-recognition`: Codex 作品建议、聚类、缓存预算、主动重识别和可查询诊断。

### Modified Capabilities
- `local-folder-ingestion`: 完整识别链路与规则回归对照，不再将 Codex 排除在桌面识别范围外。

## Impact

影响 tools/desktop-parser、media-core 识别编排、contracts、桌面设置及待处理入口和当前迁移说明。Codex 默认关闭，复用用户本机 CLI 登录；测试使用假模型、隔离文件与数据库。保留桌面目录授权、稳定观察、首次自动授权、复制与恢复约束，不迁入旧 Java 的文件操作缺陷。
