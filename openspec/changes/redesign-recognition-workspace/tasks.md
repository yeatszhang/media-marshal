## 1. 工作台交互

- [x] 1.1 默认目录批量，两栏目录选择与当前目录范围，保留明确选择边界。
- [x] 1.2 文件队列与当前对象并排，目录内接续、搜索、连续处理及候选选中反馈。
- [x] 1.3 独立扫描问题和整理记录入口，生成批量预览后进入记录，取消回到队列。
- [x] 1.4 切换清理旧预览，读取失败不继续展示前项确认表单，提供中英文公共文案。

## 2. 验证

- [x] 2.1 定向组件回归、类型和依赖边界检查。
- [x] 2.2 当前 Electron 构建的目录、单文件、扫描问题交互与 1440／920 窗口检查。
- [x] 2.3 视觉复核与 OpenSpec 严格校验，记录真实证据和限制。


## 验证证据与边界

- 定向组件：`npm test -- apps/desktop/src/renderer/src/ingestion-review.test.tsx apps/desktop/src/renderer/src/directories.test.tsx apps/desktop/src/renderer/src/recognition-edits.test.tsx apps/desktop/src/renderer/src/organize-batches.test.tsx apps/desktop/src/renderer/src/seasons.test.tsx apps/desktop/src/renderer/src/source-scans.test.tsx`：6 个文件、30 项通过。覆盖默认目录、只读浏览、目录范围接续、切换清理预览、读取失败、慢查询退出和原批量确认边界。
- `npm run typecheck`、`npm run check:boundaries`、桌面构建通过；`openspec validate --all --strict` 为 9 项通过。
- 当前 Electron 识别工作台用例通过：目录内连续切换、候选选中反馈、扫描详情分离、1440／920 宽度无文档水平溢出；920 滚动到季集与预览按钮时逐项导航仍可直接点击，且浏览交互没有创建文件作业。全主导航在 1240／920 窗口检查通过。
- 视觉独立复核最初要求修复目录长路径行与滚动接续。修复后同路径重新截图，复核两项均为 resolved，最终 disposition 为 ship；此结论限定为已指出修复及其回归。
- 截图为隔离任务数据，不代表真实识别准确率。没有操作个人媒体或凭据，没有进行安装态、签名或第三方客户端下载验收。AI 不在本轮实现范围。

- 额外真实流水线回归：`npm run test:desktop -- desktop.spec.ts --grep '季集分组跨目录选择'`：1 项通过（2.5 分钟），覆盖生产 120 秒稳定观察、跨目录选择、重叠阻断、修正后重新预览、明确确认实际 COPY、重启保留原操作。首次运行的功能断言完成，但预留端口收到的探测连接导致 afterAll 超时；为测试夹具增加其自有连接清理后，完整复跑通过。
- 本地界面截图归档于 `test-results/desktop/recognition-final/`，为测试生成产物，不作为源代码提交。
