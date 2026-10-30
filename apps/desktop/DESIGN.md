---
name: Media Marshal
description: 深蓝导航与浅灰工作区构成的本地媒体工作台
colors:
  primary: "#3458c0"
  primary-hover: "#29469b"
  primary-foreground: "#fff"
  background: "#f7f8fa"
  foreground: "#262d3b"
  card: "#fff"
  border: "#dce2eb"
  muted-foreground: "#58677b"
  sidebar: "#172338"
  sidebar-foreground: "#d2dbea"
  sidebar-muted: "#aebed4"
  sidebar-active: "#304c7b"
  sidebar-hover: "#263a58"
  sidebar-focus: "#b9d0ff"
  ring: "#486bd3"
  outline-foreground: "#65727e"
  outline-hover: "#f5f7f7"
  ghost-hover: "#eaf0f8"
  badge-background: "#f4f5f6"
  badge-border: "#e9ecf0"
typography:
  body:
    fontFamily: 'Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif'
    fontSize: "14px"
    lineHeight: 1.5
  headline:
    fontSize: "27px"
    fontWeight: 650
    lineHeight: 1.35
    letterSpacing: "-0.7px"
  title:
    fontSize: "17px"
    fontWeight: 620
  subtitle:
    fontSize: "15px"
    fontWeight: 610
  label:
    fontSize: "13px"
    fontWeight: 550
  button:
    fontSize: "12px"
    fontWeight: 550
    lineHeight: 1.5
  metric:
    fontSize: "32px"
    fontWeight: 650
    lineHeight: 1
rounded:
  badge: "5px"
  control: "7px"
  step: "8px"
  panel: "10px"
spacing:
  compact: "8px"
  field: "12px"
  group: "16px"
  panel: "24px"
  workspace: "32px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.button}"
    rounded: "{rounded.control}"
    padding: "8px 13px"
  button-primary-hover:
    backgroundColor: "{colors.primary-hover}"
  button-outline:
    backgroundColor: "{colors.card}"
    textColor: "{colors.outline-foreground}"
    rounded: "{rounded.control}"
    padding: "8px 13px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.control}"
    padding: "8px 13px"
  input:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  navigation:
    textColor: "{colors.sidebar-foreground}"
    rounded: "{rounded.control}"
    padding: "10px 12px"
  badge:
    backgroundColor: "{colors.badge-background}"
    textColor: "{colors.muted-foreground}"
    rounded: "{rounded.badge}"
    padding: "3px 6px"
  panel:
    backgroundColor: "{colors.card}"
    rounded: "{rounded.panel}"
---

# Design System: Media Marshal

## Overview

**Creative North Star: "清晰媒体工作台"**

深蓝侧栏承载分组导航，浅灰工作区承载白色内容面，蓝色强调操作和当前路径。整体采用紧凑文字、细边框和明确分组，让目录、文件和处理状态保持可读。

本文记录当前共享外壳、公共控件和总览的实现事实；方向名称来自现有方向契约，不代表用户另行批准过视觉候选方案。系统字体是产品已有约束，不引入外部字体服务。

**Key Characteristics:**
- 深蓝导航、蓝色操作与浅灰工作区。
- 以细边框和背景层次组织内容。
- 清晰键盘焦点，文字状态与图标并用。

## Colors

### Primary

`primary` 用于主要按钮、操作链接和总览图标，`primary-hover` 用于主要按钮悬停；`ring` 用于工作区键盘焦点。

### Neutral

`background` 为工作区底色，`card` 为白色内容面，`border` 划分面板和列表；`foreground` 与 `muted-foreground` 分担主文和说明。输入占位文字使用 `muted-foreground`，不额外降低透明度。

深蓝 `sidebar` 与浅色 `sidebar-foreground` 构成独立导航区域；选中、悬停、辅助文案和焦点各有对应 token。状态颜色仍按具体业务语义使用，不把绿色配置标记解释为媒体交付成功。

## Typography

全局字体栈以本机可用的 Inter 开始，随后回退至系统和中文字体；代码没有要求在线加载字体。页面标题、正文与控件继承同一字体栈。这里记录应用内标题，不建立营销展示字体规则。

层级使用 frontmatter 中的 headline、title、subtitle、body、label 和 button。总览章节标题另有局部（18px）与（16px）字号，步骤标题为（14px）；这些局部差异不替代全局标题层级。统计数字使用 metric 和等宽数字特性。辅助信息与按钮通常为（12px），避免通过继续缩小字号挤进长路径或英文内容。

## Layout

固定左侧导航默认宽（232px），顶部位置与运行状态区域最小高（60px）。内容区最大宽（1440px），默认内边距（24px 32px 32px）。页面标题和动作允许换行。

在视口不超过（1040px）时，最终级联将侧栏缩为（200px），内容区同步偏移，主体内边距为（24px）；三步配置的操作移到说明下方。统计入口仍保持三列。产品桌面窗口下限为（920 × 640），CSS body 的最小宽度为（900px）；这不是移动端布局承诺。

视口高度不超过（700px）时，侧栏纵向收紧：上下内边距为（20px / 12px），导航链接上下内边距为（8px），组间距为（2px），保留导航完整文字。

总览使用可点击的三项统计入口和按来源、识别映射、待处理排列的配置路径；这属于当前总览构成，不要求每个页面复制。长路径与高密度业务表单沿用各自页面的换行、滚动和局部断点。

## Elevation & Depth

共享面板、按钮与导航不使用投影，通过浅灰底、白色内容面、细边框和深蓝导航建立层次。焦点轮廓是操作状态，不是面板阴影。

按钮背景和边框采用（140ms ease-out）过渡；按下时亮度为（.95）。加载旋转使用（1.2s linear infinite）；减少动态效果偏好会关闭动画和过渡。

## Shapes

公共控件使用 control 圆角，内容面使用 panel 圆角，状态标签使用 badge 圆角，配置步骤编号使用 step 圆角。业务页面另有局部圆角值，不将它们强行合并为同一种形状。普通分隔与控件边框宽（1px）。

## Components

### Buttons

主按钮为蓝底白字，描边按钮为白底灰字，ghost 按钮为透明底。默认最小高（36px），小尺寸最小高（32px）、内边距（6px 10px）。禁用按钮透明度（0.5）并恢复默认指针。所有按钮保留可见焦点；主要按钮、描边按钮和 ghost 各自使用对应悬停颜色。

### Inputs / Fields

文本框、选择框和多行输入共享白底、细边框、control 圆角，文字通常为（13px）。占位文字与说明文字共用可读颜色，透明度保持（1）。公共焦点轮廓为（3px），偏移（3px）；个别业务表单有局部覆盖。多行输入最小高（96px），允许纵向调整。

### Navigation

侧栏按业务分组展示完整文字与图标。当前项通过浅一层蓝底、白字、字重（600）和尾部箭头共同标示；悬停使用 sidebar-hover。焦点使用浅蓝轮廓。顶部提供当前位置及带文字的核心运行状态。跳过导航链接在键盘聚焦时显现并将焦点移入主体。

### Chips

公共标签使用浅灰底、细边框和辅助文字色，承载短状态或类型信息；它不是筛选按钮，不添加不存在的选中交互。

### Cards / Containers

公共面板只定义背景、边框和圆角，内部留白由页面决定。总览配置面板内边距（24px）；统计入口通过竖分隔线形成整体，悬停改变底色。未知统计显示破折号，不显示为零。

### 配置步骤

步骤编号容器为（32px），已配置的来源和识别映射使用勾号及对应操作文案；待处理入口不据此标成完成。配置数量只反映配置存在，文件整理与 Emby 收录状态仍需各自查证。

## Do's and Don'ts

### Do:
- **Do** 复用蓝色操作、深蓝导航和浅灰工作区的语义分工。
- **Do** 保留占位文字对比度、键盘焦点和减少动态效果支持。
- **Do** 让长文字换行，并保持动作和状态可辨认。

### Don't:
- **Don't** 仅凭颜色或统计数量表达处理成功。
- **Don't** 为新界面引入外部字体加载依赖。
- **Don't** 把总览三步配置布局作为所有业务页面的固定模板。

### 表单任务容器

| 场景 | 容器与完成方式 |
| --- | --- |
| 来源同步、识别与映射、旧来源配置的新增与编辑 | 右侧抽屉；列表保持位置，编辑期间背景不可操作。保存同步／识别草稿并生成预览后关闭抽屉，回到页面核对范围，仍须单独确认生效。 |
| 网盘账号连接与重新授权 | 居中弹窗；保留扫码与手动 Cookie 入口，登录等待时可取消扫码。 |
| 抽屉中的远端目录选择 | 独立模态选择器；取消只返回原草稿，保留已填字段与原范围。 |
| 设置、媒体库关联、待处理核对、单条／批量修正 | 保留页面内流程，便于对照服务状态、文件和预览；不为所有输入统一增加模态层。 |

共享 `EditorSurface` 使用原生 dialog 隔离焦点，打开聚焦首个可编辑字段，关闭后回到触发入口。取消和 Escape 使用同一关闭路径：存在未保存修改时，先提供「继续编辑／放弃修改」；提交期间不关闭。背景点击不丢弃草稿。目录授权与账号管理往返继续沿用已有草稿保存边界。

长表单标题和操作区随滚动保持可见；抽屉最大宽 760px，窄窗口为内容区宽度，字段采用单列。账号弹窗最大宽 560px，留出窗口边距并允许内部滚动。错误显示在当前模态内，保存失败不清空字段。共享关闭确认提供中英文文案。
