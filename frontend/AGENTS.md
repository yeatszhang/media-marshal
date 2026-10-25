# 旧 Vue 前端维护约定

仅适用于 `frontend/`，不约束 `apps/desktop/` 的 React 界面；桌面语言与版本范围以对应变更为准。根目录 `AGENTS.md` 提供当前工程导航。

## 组件与数据

- Vue 3 Composition API，使用 `<script setup lang="ts">`；页面放 `src/views/`，共享组件放 `src/components/`，沿用 Element Plus。
- 共享业务类型维护在 `src/types/index.ts`；避免 `any`，使用 `unknown` 并收窄。
- API 调用通过 `src/api/*.ts`，组件不直接使用 axios。阅读[旧 API 快照](../docs/legacy/api-contracts.md)后核对实际 DTO、控制器和调用点，不将快照凌驾于当前契约。
- 全局状态使用 Pinia，解构响应式状态用 `storeToRefs()`；WebSocket 使用 `onTaskEvent()`，在 `onUnmounted` 调用取消函数。
- 网络错误由 `http.ts` 统一提示，组件避免重复弹窗；字段、逐项和后台失败仍按[错误反馈约定](../docs/development/error-feedback.md)持久展示。反馈优先用现有 `ElMessage` / `ElMessageBox`；大表格按需要使用 `el-table-v2`。

## 语言、版本与发布说明

- 旧 Vue 产品保留已有中英文，用户可见文字通过 `t('模块.子键')`，枚举键沿用后端大写值；不要将此要求扩展到当前桌面变更。
- 旧产品展示版本来自根 `VERSION`，不直接展示 package.json 版本。支持 `vA.B.C` 与 `vA.B.C.D`；四段补丁需独立 ReleaseNote 分组，仅列该补丁变化，版本倒序，基础版本紧随其补丁。
- npm 元数据采用合法 SemVer，四段版本由 `scripts/sync-version.mjs` 映射为 `A.B.C+patch.D`；Java/parser 展示仍按原四段版本。版本变更时修改根 `VERSION`，在根目录执行 `node scripts/sync-version.mjs` 并核对差异。
- 用户可感知功能、修复、交互／性能／文案变化及影响前端的接口变化须更新发布说明：索引在 `src/meta/releaseNotes.ts`，中英文在 `src/i18n/releaseNotes/zh.ts`、`en.ts`；`AppVersionInfo.vue` 仅展示，不另拼条目。
- 每版按 feature、fix、optimization 排序，同类按用户影响排序；以用户视角描述结果，不堆内部类名或将历史条目复制进新版本。

## 验证与文档

本目录提供 `npm run type-check`、`npm run test:queue`、`npm run build`，按改动验证。新需求、接口差异与验证证据归对应 OpenSpec 和维护文档，不继续追加旧实施日志或等待旧 PM 角色协调。
