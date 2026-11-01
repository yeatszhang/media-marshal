import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useService, useServiceState } from "@yeatz/app-framework/react";
import { Link } from "react-router-dom";
import { CodexRecognitionViewModel } from "../codex-recognition-model";
import { Button } from "./ui/button";
import { ErrorNotice } from "./shared";
import "../codex-i18n";
import "./codex-recognition.css";

export function CodexRecognitionActions({ taskId, directory, compact = false }: { taskId?: string; directory?: { id: string; sourceId: string }; compact?: boolean }) {
  const { t } = useTranslation(), model = useService(CodexRecognitionViewModel), state = useServiceState(model, (value) => value);
  useEffect(() => model.watch(), [model]);
  const disabled = state.busy || state.enabled !== true || (!taskId && !directory);
  return <div className="codex-actions">
    <div className="download-controls">
      {taskId && <Button variant="outline" size={compact ? "sm" : "default"} disabled={disabled} onClick={() => { void model.rematch({ taskId, directory: false, organize: true }); }}>{t(state.busy ? "codex.submit" : "codex.single")}</Button>}
      {directory && <><Button variant="outline" size={compact ? "sm" : "default"} disabled={disabled} onClick={() => { void model.directory({ ...directory, organize: false }); }}>{t("codex.directory")}</Button><Button size={compact ? "sm" : "default"} disabled={disabled} onClick={() => { void model.directory({ ...directory, organize: true }); }}>{t(state.busy ? "codex.submit" : "codex.directoryOrganize")}</Button></>}
    </div>
    {state.enabled !== true ? <p className="cloud-hint">{t(state.enabled === null ? "codex.loading" : "codex.disabled")} <Link to="/settings#recognition-strategy">{t("codex.setup")}</Link></p> : directory ? <p className="cloud-hint">{t("codex.actionHelp")}</p> : null}
  </div>;
}

export function CodexRecognitionPanel({ onInspect }: { onInspect(taskId: string): void }) {
  const { t } = useTranslation(), model = useService(CodexRecognitionViewModel), state = useServiceState(model, (value) => value);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => model.watch(), [model]);
  return <section className="codex-history" aria-label={t("codex.history")}>
    <ErrorNotice message={state.error ?? state.queryError} retry={() => { void model.refresh(); }} />
    {state.notice && <p role="status" className="notice">{state.notice}</p>}
    {!expanded && <ErrorNotice message={state.jobs[0]?.failure ?? null} />}
    {!!state.total && <details open={expanded} onToggle={(event) => setExpanded(event.currentTarget.open)}><summary>{t("codex.history")}（{state.total}） · {state.jobs[0] && t(`codex.${state.jobs[0].state}`)}</summary>
      <div className="cloud-browser-toolbar"><p className="cloud-hint">{t("codex.historyHelp")}</p><Button variant="outline" size="sm" onClick={() => { void model.refresh(); }}>{t("codex.refresh")}</Button></div>
      {state.jobs.map((job) => <article className="codex-job" key={job.id}>
        <div className="codex-job-heading"><div><h3>{t(`codex.${job.state}`)}</h3><p className="cloud-hint">{new Date(job.createdAt).toLocaleString()} · {t("codex.summary", { total: job.items.length, updated: job.items.filter((item) => ["UPDATED", "SUBMITTED"].includes(item.state)).length, submitted: job.items.filter((item) => item.state === "SUBMITTED").length, review: job.items.filter((item) => item.failure || ["FAILED", "SKIPPED"].includes(item.state) || job.state === "FAILED" && item.state === "PENDING").length })}</p></div>{["PENDING", "RUNNING"].includes(job.state) && <Button variant="ghost" size="sm" disabled={state.busy} onClick={() => { void model.cancel(job.id); }}>{t("codex.stop")}</Button>}</div>
        <ErrorNotice message={job.failure} />
        <div className="recognition-table-scroll"><table><thead><tr><th>{t("codex.files")}</th><th>{t("codex.state")}</th><th>{t("codex.action")}</th></tr></thead><tbody>{job.items.map((item) => <tr key={item.taskId}><td className="directory-file" title={item.relativePath}>{item.relativePath.split("/").at(-1)}</td><td><span>{t(`codex.item${item.state}`)}</span>{item.failure && <p className="recognition-edit-error">{item.failure}</p>}</td><td><div className="download-controls"><Button variant="outline" size="sm" onClick={() => onInspect(item.taskId)}>{t("codex.inspect")}</Button>{!item.operationId && (item.failure || job.state === "FAILED" || job.state === "CANCELLED") && <Button variant="ghost" size="sm" disabled={state.busy || !state.enabled} onClick={() => { void model.rematch({ taskId: item.taskId, directory: false, organize: job.organize }); }}>{t("codex.retry")}</Button>}</div></td></tr>)}</tbody></table></div>
      </article>)}
      <div className="pagination"><Button variant="outline" size="sm" disabled={state.page <= 1} onClick={() => { void model.page(state.page - 1); }}>{t("codex.previous")}</Button><span>{t("codex.page", { page: state.page, total: state.total })}</span><Button variant="outline" size="sm" disabled={state.page * 25 >= state.total} onClick={() => { void model.page(state.page + 1); }}>{t("codex.next")}</Button></div>
    </details>}
  </section>;
}
