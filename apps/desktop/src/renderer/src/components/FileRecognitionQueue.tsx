import { useEffect, useState } from "react";
import { useService, useServiceState } from "@yeatz/app-framework/react";
import { useTranslation } from "react-i18next";
import { FileVideo, Search } from "lucide-react";
import { IngestionViewModel } from "../services";
import { DirectoriesViewModel } from "../directories-model";
import { Button } from "./ui/button";

export function FileRecognitionQueue({ selectedTasks, onSelection, onInspect, onEdit, onOrganize, directoryScope = false, onClearScope }: {
  directoryScope?: boolean;
  onClearScope(): void;
  selectedTasks: string[];
  onSelection(ids: string[]): void;
  onInspect(id: string): void;
  onEdit(ids: string[]): void;
  onOrganize(ids: string[]): void;
}) {
  const model = useService(IngestionViewModel), state = useServiceState(model, (value) => value), { t } = useTranslation();
  const directories = useService(DirectoriesViewModel), directoryState = useServiceState(directories, (value) => value);
  useEffect(() => { if (directoryScope) return directories.watch(); }, [directories, directoryScope]);
  const [search, setSearch] = useState(""), [pendingOnly, setPendingOnly] = useState(true);
  const candidates = directoryScope ? directoryState.detail?.items.map((item) => item.candidate) ?? [] : state.items;
  const items = candidates.filter((item) => (!pendingOnly || item.state === "READY" || item.state === "QUEUED" || item.state === "UNAVAILABLE") && item.relativePath.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  const page = directoryScope ? directoryState.memberPage : state.page, total = directoryScope ? directoryState.detail?.directory.total ?? 0 : state.total;
  const changePage = (page: number) => { onSelection([]); if (directoryScope && directoryState.selected) void directories.select(directoryState.selected, page); else void model.refresh(page); };
  return <section className="recognition-file-queue" aria-label={t("ingestion.fileQueue")}>
    <div className="recognition-queue-heading"><h2>{t("ingestion.fileQueue")}</h2><span>{t("ingestion.currentPageCount", { count: items.length })}</span></div>
    <p className="cloud-hint">{t("ingestion.fileQueueHelp")}</p>
    {directoryScope && <div className="recognition-queue-scope"><strong className="directory-file">{directoryState.selected?.relativePath}</strong><Button size="sm" variant="ghost" onClick={onClearScope}>{t("ingestion.allFiles")}</Button></div>}
    {directoryScope && directoryState.queryError && <p role="alert">{directoryState.queryError}</p>}
    <label className="recognition-search"><Search size={16} /><input aria-label={t("ingestion.searchFiles")} placeholder={t("ingestion.searchFiles")} value={search} onChange={(event) => setSearch(event.target.value)} /></label>
    <label className="check-label recognition-queue-filter"><input type="checkbox" checked={pendingOnly} onChange={(event) => setPendingOnly(event.target.checked)} />{t("ingestion.pendingOnly")}</label>
    <div className="recognition-file-list">
      {items.map((candidate) => <article key={candidate.id} className={`recognition-file-row${candidate.taskId && candidate.taskId === state.task?.taskId ? " is-selected" : ""}`}>
        {candidate.taskId && candidate.state === "QUEUED" ? <input type="checkbox" aria-label={`选择识别任务 ${candidate.relativePath}`} checked={selectedTasks.includes(candidate.taskId)} disabled={!selectedTasks.includes(candidate.taskId) && selectedTasks.length >= 100} onChange={(event) => onSelection(event.target.checked ? [...selectedTasks, candidate.taskId!] : selectedTasks.filter((id) => id !== candidate.taskId))} /> : <FileVideo size={17} />}
        <div><strong title={candidate.relativePath}>{candidate.relativePath.split("/").at(-1)}</strong><small className="recognition-file-parent">{candidate.relativePath.includes("/") ? candidate.relativePath.slice(0, candidate.relativePath.lastIndexOf("/")) : t("ingestion.rootDirectory")}</small><small>{t(`ingestion.${candidate.state}`)}</small>{candidate.reason && <p className="cloud-hint">{candidate.reason}</p>}{candidate.automation?.reason && <p className="cloud-hint">{candidate.automation.reason}</p>}
          {candidate.taskId ? <Button size="sm" variant="ghost" disabled={state.busy || state.selecting} aria-pressed={candidate.taskId === state.task?.taskId} onClick={() => onInspect(candidate.taskId!)}>{t("ingestion.inspect")}</Button> : candidate.state === "READY" ? <Button size="sm" variant="outline" disabled={state.busy || state.selecting} onClick={() => { void model.recognize(candidate.id).then((id) => { if (id) onInspect(id); }); }}>{t("ingestion.recognize")}</Button> : null}
        </div>
      </article>)}
      {!items.length && <p className="recognition-queue-empty">{search ? t("ingestion.noSearchResults") : t("ingestion.emptyQueue")}</p>}
    </div>
    <details className="recognition-bulk-actions" open={selectedTasks.length > 0}><summary>{t("ingestion.batchActions", { count: selectedTasks.length })}</summary><div className="download-controls"><Button size="sm" variant="outline" disabled={!selectedTasks.length || state.busy} onClick={() => onEdit([...selectedTasks])}>编辑选中识别（{selectedTasks.length}）</Button><Button size="sm" variant="outline" disabled={!selectedTasks.length || state.busy} onClick={() => onOrganize([...selectedTasks])}>预览所选文件整理（{selectedTasks.length}）</Button><Button size="sm" variant="ghost" disabled={!selectedTasks.length} onClick={() => onSelection([])}>{t("ingestion.clearSelection")}</Button></div></details>
    <div className="pagination"><Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => changePage(page - 1)}>{t("previous")}</Button><span>{page} / {Math.max(1, Math.ceil(total / 100))}</span><Button variant="ghost" size="sm" disabled={page * 100 >= total} onClick={() => changePage(page + 1)}>{t("next")}</Button></div>
  </section>;
}
