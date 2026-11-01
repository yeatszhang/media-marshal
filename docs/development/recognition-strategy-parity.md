# 完整识别迁移对照

本轮迁移以旧源码和原测试为基准：14 个 Java 测试文件 127 项方法、Python 30 项、Vue 18 项，共 175 项。它们通过 `openspec/changes/migrate-complete-recognition-strategies/legacy-test-inventory.json` 记录来源 SHA-256、原方法／用例名和当前验证定位；同类断言可以合并执行，清单条数不等于测试运行器报告的测试数。

## 承接方式

| 旧实现／用例 | 当前实现及验证 |
| --- | --- |
| 标题查询 16 方法、评分 12、真实季集 16 | `domain/fixtures/` 保留逐条旧输入和独立期望；`matching.test.ts`、`migration-fixtures.test.ts` 执行生产函数 |
| ParseResult、季号解析 | `domain/legacy-parse.test.ts`；保留单值、连续数组、非连续拒绝、文件名／目录季号与特别篇 |
| Codex 服务及编排 | `ingestion/codex-recognition.test.ts`、`recognition-strategies.test.ts`、`codex-pipeline.test.ts`；校验上下文、顺序、低分兜底、不降分、目录共享和在途修改 |
| TMDB 及缓存 | `infrastructure/legacy-tmdb-recognition.test.ts`、`tmdb.test.ts`；本地 HTTP、实际 SQLite、失败不缓存、共享请求、跨连接恢复、错误季和大分季响应 |
| 旧自动整理与重复检查 | `sources/recognition-rules.test.ts`、`domain/episode-feature.test.ts`；可信受管成果和真实隔离文件，验证90%模型门槛、低TMDB分、咒术回战13集累计48起、未入队哈希副本、重复双方、模板碰撞、第三方目标占用和安全子集继续 |
| 旧批量识别编辑 | `ingestion/recognition-edits.test.ts`、`pipeline.test.ts`；自然顺序、电影清空坐标、合并范围、失败保留编辑及原任务 |
| Python bridge 30 项 | `tools/desktop-parser/tests/test_codex_recognition.py` 直接保留原输入和断言，改为导入迁入的引擎；包含19文件、13集加6份哈希副本只调用一次、跨季／新增集缓存、上海预算和敏感输出保护 |
| Vue 目录、识别／整理统计14项 | `renderer/src/legacy-directory-rules.test.ts`、`legacy-recognition-results.test.ts`、`legacy-organization-results.test.ts` 保留原输入、名称和断言；目录季号及冲突规则接入整理草稿 |
| Vue 批量确认4项 | `ingestion/organize-batches.test.ts` 的25集、13集共同作品与累计集号，及已有部分失败、补记丢失幂等恢复；组件测试保证草稿不保存／不执行、明确预览和确认 |
| 新增桌面约束 | `codex-process.test.ts`、`codex-jobs.test.ts`、`codex-recognition.test.tsx`、`tests/codex-recognition.spec.ts`；stdio有界、查询不排在模型后、取消清理、持久作业、配置重载、未安装CLI、重启不重放 |

## 明确适配的旧机制

- 旧 HTTP bridge 和认证令牌由 Core 内部冻结子进程取代；Python 原 HTTP 兼容测试仍覆盖旧引擎，但桌面实际不启动 HTTP。
- 旧 JPA 将重复失败合并并删除临时任务。桌面沿唯一候选和原任务重试，逐次作业错误保留，不删除已存在的历史；两次失败不重复任务的集成断言单独覆盖。
- 旧前端逐项保存坐标后一次确认，桌面改为冻结共同作品及逐项坐标的不可变预览，再显式确认。草稿不隐式保存识别字段；成员版本变化时整批预览失效，部分执行失败和回执丢失分别记账。
- 原强制审批设置在旧最新实现中已失效：可靠模型沿自动策略推进。桌面仍要求当前规则首次样本授权、可信完成收据和原文件核验；高模型分或目录共同候选不能替代这些条件。
- 已有当前规格要求拒绝小数集号截断，并收紧弱文件名与强父目录仅同ID就加分的问题；旧输入与新期望仍在 `intentional-differences.json` 单独执行。ISO／蓝光在桌面发现入口即排除，不进入普通视频的父目录增强。

## 验证入口与范围

```sh
node scripts/check-recognition-parity.mjs
npm run typecheck
npm run check:boundaries
npm test
python3 -m unittest discover -s tools/desktop-parser/tests -p 'test_codex*.py'
npm run desktop:build
npm run test:desktop -- apps/desktop/tests/codex-recognition.spec.ts apps/desktop/tests/recognition-workspace.spec.ts
npm run docs:build
openspec validate --all --strict
```

`check-recognition-parity` 只核对旧测试清单完整、快照未变和验证位置存在；业务断言由 Node／Python／真实 Electron 测试分别执行。模型及 TMDB 结果使用可控替身或本地 HTTP，文件与 SQLite 使用隔离目录；窗口覆盖当前 macOS arm64 开发构建的920及1440宽度。未调用个人模型账号或真实媒体，不将此结果声明为真实联网识别质量、Windows或签名安装发行验收。

2026-11-01 本轮结果：全量 Node／组件／Core 为 **1299 passed／13 skipped**（131个测试文件通过、3个文件跳过）；Python 引擎及 stdio **34 项通过**，其中30项直接承接旧引擎；另将同一 stdio 测试对当前 arm64 冻结可执行文件运行，**4项通过**，包含假CLI成功返回、跨进程命中缓存和用量计数。真实 Electron 的 Codex 全流程及既有目录工作台 **2项通过**，查看920／1440截图并核对无页面横向溢出；类型、依赖边界、当前桌面构建、文档构建及全部 OpenSpec 严格检查通过。全量包含其他会话尚未提交的日志相关修改，此处只提交本轮识别内容。
