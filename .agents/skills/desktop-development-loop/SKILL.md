---
name: desktop-development-loop
description: 在 Media Marshal 桌面工作区开发或排障时，通过统一 CLI 的隔离实例观察界面、日志和任务，保存修复前后证据并验证改动；用于真实桌面开发闭环，不用于纯文档或旧 Java 工程。
---

执行本仓库的“复现 → 观察 → 定位 → 修改 → 同场景复验 → 回归 → 提交”闭环。共享工程规则以 [AGENTS.md](../../../AGENTS.md) 为准；本 Skill 不扩大当前任务范围或操作授权。

## 入口

- [CLI 协议、场景与证据](../../../tools/desktop-agent/README.md)：命令参数、身份、异步收据、导出与清理。
- [桌面构建和进程边界](../../../docs/architecture/desktop-development.md)：按任务查询对应业务架构，避免把问题全部归到 GUI。
- [实施及验收证据](../../../docs/development/desktop-refactor-validation.md)：当前平台、真实路径、替身与原生能力的已知范围；历史结果不能代替本轮验证。
- OpenSpec 任务存在时，接续对应变更的任务和行为断言，不因修复方便缩减规格。

## 建立当前复现

先核对 Git 工作区、目标行为与已有断言。命令统一使用：

```sh
npm run --silent desktop:agent -- <command> --json [--input 参数.json] [--request UUID] [--session UUID]
```

先运行 `help` 和 `doctor`。`build` 返回异步 jobId，以 `status` 的输入 `{"jobId":"原身份"}` 续查到终态；状态查询不带 --session。工具／桌面场景需要 development，目录包和性能需要 packaged。若两种都要验收，先构建 packaged、再构建 development：打包会重新生成共享原生资源，可能使之前的开发清单过期。每次使用前仍以实际构建核验为准，缺依赖只按 doctor 的修复建议处理，不自动修改系统权限。

通过 `scenario list` 选择现有场景；`start` 的输入如 `{"scenario":"empty","seed":"本轮复现标记","mode":"background","target":"development"}`。默认后台，userData 与个人实例隔离。业务故障走固定 `scenario mode=fault` 目录，不向运行中的数据库直接写夹具。保留 scenario／seed、buildId、sessionId、runId 和复现命令；只有新运行身份才能代表重跑。

默认先用 `logs`、`diagnose` 和基于 CDP 的 `observe` 语义快照、控件状态及动作后置条件定位与验证，不要求截图。只有视觉问题或日志／语义证据不足且确需视觉判断时才显式加 `image:true`；无法截图不阻断日志、CDP 和非视觉业务验证。需要原生菜单、面板或 OS 快捷键时，优先使用 AX 语义、动作收据与应用状态证据；DOM／后台替身不能代替 native，原生截图仍为可选能力。专门的视觉验收未运行时如实记录，不能用旧图或人工转述代替当前证据。

## 操作、定位与修复

- 基于最新 snapshotId 和唯一语义目标执行 `act`；图像坐标必须来自已查看的当前图片。操作带明确 after 条件，随后查询原动作收据和业务状态。旧引用／歧义先重新观察；确认操作超时为 unknown，先查原 jobId，不重放确认。
- `logs` 按 requestId／operationId 追踪，`diagnose` 查询只读状态；观察与输入发送成功不能证明持久任务或文件结果成功。关联源码位置和既有断言，提出可验证原因后修改最小逻辑单元。
- 首次失败先保留证据，必要时用 `collect` 选择 kinds 导出并固定；partial 仍可保留可用证据，明确缺失，不上传任意 userData。修复前记录、原断言和失败身份继续保留。
- 修改工具、契约或共享驱动后，先 stop 原控制器，再用当前构建新建会话；只修改应用时可按 CLI 身份核验使用 restart。新运行复用场景条件和 seed，比较 GUI、任务与文件后置条件，保留前后 buildId／runId。

## 验证和交付

`verify` 默认按真实 Git 差异生成带理由计划，changedFiles 仅补充提示；需要与分支基点比较时显式传入本地可解析的 baseRef。先审查检查范围，再用 `{"mode":"run","baseRef":"HEAD"}` 执行并续查结果。未知路径回退全量；空计划、跳过、缺失、源码变化和构建过期不算通过。性能选项 `benchmark:true` 仅补充当前设备样本，不代表性能达标。

若同时修改测试、驱动、场景、基线或架构规则，单列标准变化及原因，运行相应工具回归；不删测、不削弱断言、不自动接受截图差异、不扩大架构例外来换取成功。按实际结果记录 passed／failed／blocked／not-run，业务失败不能被视觉正常覆盖。

同一失败连续三轮且没有新证据或可验证假设时，停止该失败的盲试，报告复现身份、具体失败、已排除原因和需要的输入或环境变化；可继续不依赖该阻碍的任务。检查通过后按仓库规则提交完整逻辑单元，报告 commit、范围和证据，停止本轮自有会话。证据回收先用 gc dryRun 核对；不清空个人数据、不修改全局 Codex 配置、不自动 push、合并或发布。
