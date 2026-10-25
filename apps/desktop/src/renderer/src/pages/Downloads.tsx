import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useService, useServiceState } from "@yeatz/app-framework/react";
import { Download, FolderOpen, Pause, Play, RefreshCw, X } from "lucide-react";
import { DownloadsViewModel } from "../services";
import { Header, Empty, ErrorNotice } from "../components/shared";
import { Button } from "../components/ui/button";

const size = (value: number) => value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KiB` : value < 1024 ** 3 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : `${(value / 1024 ** 3).toFixed(2)} GiB`;
export function Downloads() {
  const { t } = useTranslation(), model = useService(DownloadsViewModel), state = useServiceState(model, (value) => value);
  useEffect(() => model.watch(), [model]);
  return <>
    <Header title={t("cloud.downloads")} description={t("cloud.restartDownload")}><Button variant="outline" disabled={state.changingPause || state.pausing} onClick={() => { void model.togglePause(); }}>{state.pausing ? "正在停止云端写入…" : state.paused ? "恢复全部云端下载" : "暂停全部云端下载"}</Button><Button variant="outline" onClick={() => { void model.refresh(); }}><RefreshCw size={15} />{t("reload")}</Button></Header>
    <ErrorNotice message={state.error} /><p className="cloud-hint">暂停全部云端下载会停止当前传输和新领取，订阅仍可扫描。本地整理的暂停状态独立保存。</p>
    {!state.items.length && !state.loading && <section className="panel"><Empty icon={<Download size={28} />} title={t("cloud.noDownloads")} description={t("cloud.noDownloadsHelp")} /></section>}
    <div className="download-queue">{state.items.map((job) => {
      const busy = state.busy.includes(job.id), pausable = ["QUEUED", "RUNNING", "VERIFYING", "COMMITTING", "RETRY_WAIT"].includes(job.state), resumable = job.state === "PAUSED", retryable = ["FAILED", "AUTH_REQUIRED", "BLOCKED_LOCAL"].includes(job.state), cancellable = !["COMPLETED", "CANCELLED", "CANCELLING", "RECONCILING"].includes(job.state), total = job.progress.totalBytes;
      return <article className="panel download-job" key={job.id} aria-label={job.name || job.id}><div className="cloud-browser-toolbar"><h2 title={job.name}>{job.name || job.id.slice(0, 8)}</h2><span className="badge">{t(`cloud.state${job.state}`)}</span></div>
        <p className="download-progress" role="status">{size(job.progress.bytes)} / {total === null ? t("cloud.unknownSize") : size(total)} · {size(job.progress.bytesPerSecond)}/s · {t("cloud.completedCount", { done: job.progress.completedItems, total: job.progress.totalItems ?? "—" })}</p>
        {total !== null && total > 0 && <progress aria-label={t("cloud.downloadProgress")} max={total} value={Math.min(job.progress.bytes, total)} />}
        {job.failure && <ErrorNotice message={job.failure.message} />}
        {(job.state === "RECONCILING" || job.state === "PAUSING") && <p className="cloud-hint">{t("cloud.writerWaiting")}</p>}
        {job.progress.completedItems > 0 && (job.ingestion ? <div className="notice" role="status"><span>{t("cloud.completedCount", { done: job.progress.completedItems, total: job.progress.totalItems ?? "—" })}</span><span>· {t("ingestion.fileDone")} {job.ingestion.organized}</span><span>· {t("ingestion.embyStatus")} {job.ingestion.collected}</span>{job.ingestion.pending > 0 && <span>· {t("ingestion.pendingCount", { count: job.ingestion.pending })}</span>}</div> : <p className="cloud-hint">{t("cloud.pendingIngestion")}</p>)}
        <div className="download-controls">{pausable && <Button variant="outline" size="sm" disabled={busy} onClick={() => { void model.control(job.id, "pause"); }}><Pause size={14} />{t("cloud.pauseDownload")}</Button>}{resumable && <Button variant="outline" size="sm" disabled={busy} onClick={() => { void model.control(job.id, "resume"); }}><Play size={14} />{t("cloud.resumeDownload")}</Button>}{retryable && <Button variant="outline" size="sm" disabled={busy} onClick={() => { void model.control(job.id, "retry"); }}><RefreshCw size={14} />{t("retry")}</Button>}{cancellable && <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void model.control(job.id, "cancel"); }}><X size={14} />{t("cloud.cancelDownload")}</Button>}{job.progress.completedItems > 0 && <Button variant="ghost" size="sm" onClick={() => { void model.open(job.id); }}><FolderOpen size={14} />{t("cloud.openCompleted")}</Button>}</div>
      </article>;
    })}</div>
    <div className="download-pagination"><Button variant="outline" size="sm" disabled={state.page <= 1} onClick={() => { void model.refresh(state.page - 1); }}>{t("cloud.previousPage")}</Button><span>{t("cloud.pageCount", { page: state.page, total: state.total })}</span><Button variant="outline" size="sm" disabled={state.page * 25 >= state.total} onClick={() => { void model.refresh(state.page + 1); }}>{t("cloud.nextPage")}</Button></div>
  </>;
}
