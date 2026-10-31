---
version: 1
slug: "apps-desktop-src-renderer-src-pages-ingestion-tsx"
primary_target: "apps/desktop/src/renderer/src/pages/Ingestion.tsx"
related_targets:
  [
    "apps/desktop/src/renderer/src/pages/recognition-workspace.css",
    "apps/desktop/src/renderer/src/components/DirectoryQueuePanel.tsx",
    "apps/desktop/src/renderer/src/components/FileRecognitionQueue.tsx",
  ]
---

# 识别与人工确认工作台

模式：Operate。本记录描述已实现的局部布局和交互，需求范围以 [OpenSpec 变更设计](../../../../openspec/changes/redesign-recognition-workspace/design.md)及其规格为准，实施与验收证据见 [任务记录](../../../../openspec/changes/redesign-recognition-workspace/tasks.md)。产品上下文沿用 [PRODUCT.md](../../PRODUCT.md)，共享视觉系统沿用 [DESIGN.md](../../DESIGN.md)。

## Direction contract

THESIS：先按目录批量识别，再逐个核对剩余文件，让当前范围、识别依据与下一步动作在同一工作位置可见。

OWN-WORLD：继承深蓝导航、浅灰工作区、白色内容面、蓝色操作、系统字体及既有控件。通过细分隔线与选中状态组织队列和当前对象；本轮没有全局 token 变更。

STORY：选择目录及本页文件，核对共同作品；未解决项进入目录内文件队列，逐项明确选择作品并核对季集与目标，生成预览后再明确确认文件完整性。扫描问题与整理记录有独立入口。AI 不在本轮范围。

FIRST VIEWPORT：标题与刷新在上，操作原则和五个工作入口随后；默认左侧目录列表、右侧目录候选与成员。逐个处理时左侧文件队列、右侧当前文件，右栏顶部提供上一个／下一个与当前序号。920 × 640 保持两栏，动作换行，表格局部横向滚动，页面纵向滚动。

FORM：用户指定的目录批量与单文件接续工作台，继承既有视觉方向；本轮没有另选全局视觉方案，也没有生成新的方向 seed。

FINISH：unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## 局部布局与状态

- 主入口为「目录批量」「逐个处理」，次级入口为「季集辅助」「扫描与问题」「整理记录」。当前入口有文字、图标和选中底色。
- 工作区左栏为队列，右栏为当前对象；宽窗口左栏为 29% 且至少 230px，1100px 及以下为 220px。列表各自限制高度并可滚动，右栏内容随页面纵向滚动。
- 目录名与右栏目录标题最多显示两行，目录表格显示文件名，状态与原因分列保留；完整文件相对路径保留在标题提示中。文件队列将文件名与父目录分开显示，当前对象的完整来源路径可展开。
- 右栏逐项工具条随页面滚动保持在顶部；滚动到季集字段与预览动作后仍能接续切换文件。
- 候选卡片按作品、证据分数、解释与显式选择排列；被选候选增加蓝色边框及浅蓝底。高分不等于已选作品或可以直接整理。
- 命名与附属文件选项折叠呈现；批量编辑及批量整理草稿使用页面内专注任务，保留返回队列入口。

## 交互边界

- 默认只读选择首个可查询目录；目录选择不提交识别。批量识别与编辑均限定本页，目录成员每页最多 100 项，跨页重新选择。
- 从目录查看单项时，左栏保留该目录当前页队列并继续查询实际状态；可返回全部文件。搜索明确限定本页，上一项／下一项仅在当前页已有识别任务中接续。
- 切换文件先清空旧任务、目标及预览，再显示读取状态；迟到响应沿用请求序列隔离。读取失败显示错误，避免展示前一文件的确认表单。
- 修改作品、季集、目标或附属选项使原预览失效；确认完整性的勾选默认关闭。只有生成有效预览、明确勾选且预览未过期时才能确认 COPY。
- 批量预览生成后进入整理记录；取消草稿返回原队列。目录共同候选和识别提交数量均不表示整理成功。
- 扫描入口标记的是当前扫描记录页中的问题作业数量；详细问题仍分页查询，不将标记解释为全部问题文件总数。

## 收尾核对证据

已对照 Ingestion、DirectoryQueuePanel、FileRecognitionQueue、局部 CSS 与 OpenSpec 设计，并查看本轮六张本地截图：目录和单文件工作台的 1440／920 布局、920 滚动接续、920 扫描问题。截图为 `test-results/desktop/recognition-final/` 下的测试产物，不随源代码提交；复现入口及结果见 OpenSpec 任务记录。

布局、配色、字体与控件复用符合既有视觉系统；本次文档核对保留 DESIGN.md 与 design.json。组件回归和 Electron 交互结果引用上方任务记录，本次文档核对没有重复执行业务测试。独立 reviewer 的最终 verdict 为 **ship**，仅表示其指出的目录长路径行与滚动接续两项 material fixes 均为 resolved，并覆盖其回归，不扩大为整页无问题或正式发行验收。

截图来自隔离任务数据，只验证界面布局和交互；不证明真实识别准确率、120 秒文件就绪行为或安装态验收，也不表示 AI 已可用。
