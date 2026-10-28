# 桌面工作台 UI 验收

日期：2026-10-28。范围：共享导航外壳、公共样式、总览与相关双语文案。用户选择明显重做视觉风格，保留业务功能。本轮不改变 IPC、核心服务、预览、授权或文件执行规则。

## Impeccable 项目安装

按 [Impeccable 官方安装入口](https://impeccable.style/#downloads)，在仓库根目录运行：

```sh
npx impeccable install --providers=codex --scope=project --yes
.agents/skills/impeccable/scripts/impeccable hooks on
```

本次安装 skill 4.8.0，校验引擎 0.1.18。技能源码及启动器在 `.agents/skills/impeccable`；平台二进制和个人信任配置不进入 Git。后续更新使用官方 `npx impeccable update`，审查变更后提交。

桌面产品上下文为 `apps/desktop/PRODUCT.md`；设计 tokens 为 `apps/desktop/DESIGN.md` 与 `apps/desktop/.impeccable/design.json`。在桌面目录执行 skill 时使用 `../../.agents/skills/impeccable/scripts/impeccable`，避免将旧工程当作当前产品。

项目已写入 `.codex/hooks.json` 和 `.impeccable/config.json`。自动 Hook 仍需用户在 Codex 的 Hooks 设置中首次信任 PostToolUse / Stop；本轮手动执行检查，不以配置文件存在作为自动执行已获信任的证据。

## 实现

- 深蓝分组导航，钴蓝操作色，浅灰工作区；当前位置跟随路由。
- 公共文字、按钮、表格、提示和空状态提高可读性；输入占位文本不再半透明。
- 总览统计提供直接入口；来源、识别映射、核对整理组成可操作流程。
- 统计未知显示「—」及提示，已有记录显示记录数，不显示虚假空状态；记录数不代表整理成功或 Emby 已收录。
- 发布说明折叠呈现；保留说明内容和展开入口。
- 提供跳至主内容、明确焦点、减少动态效果支持；小窗口允许长文案和动作换行，低高度侧栏减少空白。
- 本次公共新增文案提供中英文；没有宣称业务详情已完成全面国际化。

## 验证

```sh
npm run typecheck
npm run check:boundaries
npm test -- apps/desktop/src/renderer/src
npm run desktop:build
npm run test:desktop -- apps/desktop/tests/layout.spec.ts apps/desktop/tests/workspace-design.spec.ts
.agents/skills/impeccable/scripts/impeccable detect apps/desktop/src/renderer/src/App.tsx apps/desktop/src/renderer/src/pages/Overview.tsx apps/desktop/src/renderer/src/styles.css --json
```

Renderer 23 个文件、132 项测试通过，定向 Electron 4 项通过。类型、依赖边界与文档构建通过。定向 Electron 检查覆盖所有主导航、账号表单、长路径和规则编辑、来源生命周期、键盘入口、英文导航与减少动态效果。测试使用隔离临时目录，无个人媒体或凭据。

Impeccable 静态扫描在初版改造上返回空发现；随后独立人工审查补充了占位文本对比修复。修复后独立复核占位文本对白底为 5.77:1，两项审查意见均已解决；该复核不代表全部产品界面验收。不能将静态扫描解释为全部页面可访问性认证。

截图由上述 Electron 测试生成到 `test-results/desktop/`（忽略提交）：`layout-1240-overview.png`、`layout-920-overview.png`、各导航截图、`layout-sync-form-920.png` 和 `workspace-english-920.png`。

验证限于本机 macOS 开发构建及 1240/920 宽度；未执行安装包、Windows/Intel 或真实 Emby/网盘验收。设计过程使用了 Impeccable 上下文、方向探索、手动检测与独立审查，但未举行视觉候选卡选择或图像 comp 对比；不宣称通过该工具的完整创意流程认证。
