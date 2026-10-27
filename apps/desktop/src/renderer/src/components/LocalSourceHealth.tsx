import type { LocalDirectoryHealth, LocalSourceHealth, SourceRule } from "@media-marshal/contracts";
import { Button } from "./ui/button";
import { sourceDate } from "../source-format";

function DirectoryState({ label, health }: { label: string; health?: LocalDirectoryHealth }) {
  const state = health?.state ?? "UNVERIFIED";
  return <div className={`local-directory-health is-${state.toLowerCase()}`}><dt>{label}</dt><dd><strong>{state === "AVAILABLE" ? "原目录已核验" : state === "UNAVAILABLE" ? "原目录不可用" : "尚未核验"}</strong>
    {health?.state === "UNAVAILABLE" && <p>{health.reason === "PERMISSION_DENIED" ? "目录访问权限不足。输入目录需要可读，整理目标需要可写；请恢复系统权限后重新检查。" : "原卷、目录身份或访问状态未通过检查。请连接原磁盘、恢复原目录并检查权限。若磁盘已重新挂载，请编辑来源，重新选择原目录并预览确认；不会接管同名替代目录。"}</p>}
    {health?.state === "UNVERIFIED" && <p>{health.reason === "CONFIGURATION_REVIEW_REQUIRED" ? "来源关联尚未确认，请编辑来源，核对目录后重新预览并确认。" : health.reason === "RECHECK_REQUIRED" ? "目录授权已更新，请重新检查。" : "等待原目录授权恢复。若持续未核验，请连接原磁盘后重新预览并确认来源。"}</p>}</dd></div>;
}
export function LocalSourceHealthPanel({ row, health, busy, blocked, onCheck }: { row: SourceRule; health?: LocalSourceHealth; busy: boolean; blocked: boolean; onCheck(): void }) {
  const current = health?.version === row.version && health.lifecycleRevision === (row.lifecycleRevision ?? 0) ? health : undefined;
  if (!row.version) return <p className="cloud-hint">草稿尚未生效，预览并确认后才检查已授权目录。</p>;
  return <section className="local-source-health" aria-label={`本地目录健康 ${row.configuration?.name ?? row.draft.name}`}>
    <div className="local-source-health-heading"><h4>本地目录健康</h4><Button variant="outline" size="sm" disabled={blocked} onClick={onCheck}>重新检查目录</Button></div>
    <dl><DirectoryState label="输入目录" health={current?.input} /><DirectoryState label="整理目标" health={current?.target} /></dl>
    {current?.previous && <details><summary>上次目录检查 · {sourceDate(current.previous.checkedAt)}（历史结果）</summary><dl><DirectoryState label="上次输入目录" health={current.previous.input} /><DirectoryState label="上次整理目标" health={current.previous.target} /></dl><p className="cloud-hint">历史结果仅供排查，当前目录仍需重新核验。</p></details>}
    <p className="cloud-hint" role="status">{busy ? "正在核验当前来源的已授权目录…" : `最近检查 ${sourceDate(current?.checkedAt ?? null)}`} · 检查不扫描文件或提交整理</p>
    {!busy && blocked && <p className="cloud-hint">正在检查本页其他来源，请稍后再检查此项。</p>}
  </section>;
}
