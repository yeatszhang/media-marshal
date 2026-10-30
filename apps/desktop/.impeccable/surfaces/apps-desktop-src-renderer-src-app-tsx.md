---
version: 1
slug: "apps-desktop-src-renderer-src-app-tsx"
primary_target: "apps/desktop/src/renderer/src/App.tsx"
related_targets: ["apps/desktop/src/renderer/src/pages/Overview.tsx","apps/desktop/src/renderer/src/styles.css"]
---

# 桌面工作台视觉改造

模式：Operate。用户已选择明显重做视觉风格，保留业务功能。范围为共享外壳、公共组件样式和总览。

## Direction contract

THESIS：让家庭媒体整理的下一步明确可见；用可操作的处理顺序取代装饰欢迎画面。

OWN-WORLD：深蓝 #172338 侧栏、钴蓝 #3458c0 操作、冷浅灰 #f7f8fa 背景与白色工作面。系统中文字体、清晰分组、细分隔线，文字不低于 12px 的公共密度。

STORY：先看当前配置数量，再从来源、识别映射和待处理进入工作，文件与 Emby 收录各自查证，不凭统计声称成功。

FIRST VIEWPORT：左侧 232px 分组导航，顶部 60px 当前位置与核心状态，主体标题右侧主动作，下方可点击统计和三步配置路径。920px 窗口侧栏 200px，行内动作换行，保留完整文字。

FORM：清晰媒体工作台。已运行方向探索 seed:2a634ccb23a42e1d；本次按用户的整体重设计授权直接实施代码方案，未举行视觉候选卡选择，不能将该形式宣称为用户已批准的独立方案；无 QUALITY BAR 图片或批准 comp。

FINISH：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
