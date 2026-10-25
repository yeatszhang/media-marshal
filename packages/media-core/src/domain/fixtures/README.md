# 桌面媒体规则的行为对照

`templates.json` 按 Java `TemplateRendererTest` 的方法名逐项记录输入与预期；范围错误、路径安全与资源上限另有 TS 测试。夹具仅含固定示例，不从用户数据库或媒体目录抽取。

运行命令不需要 Java：

```sh
npm test -- packages/media-core/src/domain/template.test.ts packages/media-core/src/domain/media.test.ts
```

`media.test.ts` 对照 `ParseResultTest`、`EpisodeSeasonResolverTest` 和 `TmdbEpisodeServiceTest`，验证连续集、最近季号线索、真实分集集合、唯一季映射及重复坐标。不保留 Java `Number.intValue` 对小数的静默截断，无法证明的范围不放行。自动、人工与修正入口应统一调用 `reconcileEpisodes` 和 `assertUniqueEpisodes`，不得自行按集数上限或偏移换算。

中文首字母继续采用单字首读音规则，固定字典生成过程及摘要见 `tools/desktop-parser/generate_initials.py`，声明及来源见 `apps/desktop/resources/pinyin4j-NOTICE.txt`。不引入运行时 Java 或上下文多音字推断。模板预览保留缺值的原占位符，执行路径另外拒绝未解析变量、越界及平台不支持名称。
