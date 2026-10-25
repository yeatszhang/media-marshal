import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useService, useServiceState } from "@yeatz/app-framework/react";
import { ListTodo, RefreshCw } from "lucide-react";
import { IngestionViewModel } from "../services";
import { Header, Empty, ErrorNotice } from "../components/shared";
import { Button } from "../components/ui/button";
import { SeasonQueuePanel } from "../components/SeasonQueuePanel";
import { DirectoryQueuePanel } from "../components/DirectoryQueuePanel";
import { RecognitionEditor } from "../components/RecognitionEditor";
import { OrganizeBatchEditor, OrganizeBatchPanel, type CommonWork } from "../components/OrganizeBatchPanel";
import { SourceScansPanel } from "../components/SourceScansPanel";
import { ContentReviewsPanel } from "../components/ContentReviewsPanel";

export function Ingestion() {
  const { t } = useTranslation(), model = useService(IngestionViewModel), state = useServiceState(model, (value) => value), location = useLocation();
  const [id, setId] = useState(""), [type, setType] = useState<"MOVIE" | "TV_SHOW">("MOVIE"), [season, setSeason] = useState("1"), [episode, setEpisode] = useState("1"), [end, setEnd] = useState(""), [template, setTemplate] = useState(""), [complete, setComplete] = useState(false), [includeAccessories, setIncludeAccessories] = useState(true);
  const [organizing, setOrganizing] = useState<{ taskIds: string[]; work?: CommonWork } | null>(null);
  const [view, setView] = useState<"files" | "directories" | "seasons">("files");
  const [selectedTasks, setSelectedTasks] = useState<string[]>([]), [editingTasks, setEditingTasks] = useState<string[] | null>(null);
  useEffect(() => model.watch(), [model]);
  useEffect(() => { const taskId = (location.state as { taskId?: string } | null)?.taskId; if (taskId) void model.select(taskId); }, [model, location.state]);
  useEffect(() => {
    setId(""); setTemplate(""); setComplete(false); setEnd(""); setIncludeAccessories(true);
  }, [state.task?.taskId]);
  useEffect(() => { const parsed = state.task?.parsed; if (parsed) { setType(parsed.type ?? "MOVIE"); setSeason(String(parsed.season ?? 1)); setEpisode(String(parsed.episode ?? 1)); setEnd(parsed.episodeEnd === null ? "" : String(parsed.episodeEnd)); } }, [state.task?.parsed?.season, state.task?.parsed?.episode, state.task?.taskId]);
  const change = (update: () => void) => { update(); model.clearPreview(); setComplete(false); };
  const openOrganize = (taskIds: string[], work?: CommonWork) => { model.clearPreview(); setComplete(false); setOrganizing({ taskIds, work }); };
  const previewExpired = !!state.preview && Date.now() >= state.preview.expiresAt;
  return <>
    <Header title={t("ingestion.title")} description={t("ingestion.help")}><Button variant="outline" onClick={() => { void model.refresh(); }}><RefreshCw size={15} />{t("reload")}</Button></Header>
    <ErrorNotice message={state.error} />
    <ContentReviewsPanel sources={state.sources} />
    <SourceScansPanel sources={state.sources} />
    {editingTasks && <RecognitionEditor key={editingTasks.join(",")} taskIds={editingTasks} onClose={() => setEditingTasks(null)} onSaved={() => { setSelectedTasks([]); model.clearPreview(); setComplete(false); void model.refresh(); }} />}
    {organizing && <OrganizeBatchEditor key={JSON.stringify(organizing)} {...organizing} onClose={() => setOrganizing(null)} />}
    <OrganizeBatchPanel draftOpen={!!organizing} onInspect={(id) => { void model.select(id); }} />
    <div className="download-controls"><Button variant={view === "files" ? "default" : "outline"} onClick={() => setView("files")}>按文件查看</Button><Button variant={view === "directories" ? "default" : "outline"} onClick={() => setView("directories")}>按目录查看</Button><Button variant={view === "seasons" ? "default" : "outline"} onClick={() => setView("seasons")}>按季集查看</Button></div>
    {view === "seasons" ? <SeasonQueuePanel onInspect={(id) => { void model.select(id); }} onEdit={setEditingTasks} onOrganize={openOrganize} /> : view === "directories" ? <DirectoryQueuePanel onInspect={(id) => { void model.select(id); }} onEdit={setEditingTasks} onOrganize={openOrganize} /> : <>
    <div className="download-controls"><Button variant="outline" disabled={!selectedTasks.length || state.busy} onClick={() => setEditingTasks([...selectedTasks])}>编辑选中识别（{selectedTasks.length}）</Button><Button variant="outline" disabled={!selectedTasks.length || state.busy} onClick={() => openOrganize([...selectedTasks])}>预览所选文件整理（{selectedTasks.length}）</Button><Button variant="ghost" disabled={!selectedTasks.length} onClick={() => setSelectedTasks([])}>清除任务选择</Button><span className="cloud-hint">勾选已有待确认任务可批量编辑，最多 100 项；编辑不执行整理。</span></div>
    <section className="panel ingestion-candidates">{state.items.length ? <><table><thead><tr><th>选择</th><th>{t("file")}</th><th>{t("status")}</th><th>{t("ingestion.action")}</th></tr></thead><tbody>{state.items.map((candidate) => <tr key={candidate.id}><td>{candidate.taskId && candidate.state === "QUEUED" ? <input type="checkbox" aria-label={`选择识别任务 ${candidate.relativePath}`} checked={selectedTasks.includes(candidate.taskId)} disabled={!selectedTasks.includes(candidate.taskId) && selectedTasks.length >= 100} onChange={(event) => setSelectedTasks(event.target.checked ? [...selectedTasks, candidate.taskId!] : selectedTasks.filter((id) => id !== candidate.taskId))} /> : "—"}</td><td className="table-file" title={candidate.relativePath}><strong>{candidate.relativePath}</strong><small>{candidate.size.toLocaleString()} {t("ingestion.bytes")}</small></td><td>{t(`ingestion.${candidate.state}`)}{candidate.reason && <small>{candidate.reason}</small>}</td><td>{candidate.taskId ? <Button size="sm" variant="outline" disabled={state.busy} onClick={() => { void model.select(candidate.taskId!); }}>{t("ingestion.inspect")}</Button> : candidate.state === "READY" ? <Button size="sm" disabled={state.busy} onClick={() => { void model.recognize(candidate.id); }}>{t("ingestion.recognize")}</Button> : "—"}</td></tr>)}</tbody></table><div className="pagination"><Button variant="outline" size="sm" disabled={state.page <= 1} onClick={() => { void model.refresh(state.page - 1); }}>{t("previous")}</Button><span>{t("page", { page: state.page, total: state.total })}</span><Button variant="outline" size="sm" disabled={state.page * 100 >= state.total} onClick={() => { void model.refresh(state.page + 1); }}>{t("next")}</Button></div></> : <Empty icon={<ListTodo size={28} />} title={t("ingestion.empty")} description={t("ingestion.emptyHelp")} />}</section>
    </>}
    {state.task && <section className="panel settings-form"><h2>{state.task.parsed?.title || t("ingestion.edit")}</h2><p role="status">{t(state.task.state)}</p><ErrorNotice message={state.task.failure} />
      {state.task.state === "PENDING" || state.task.state === "PROCESSING" ? <p>{t("ingestion.waiting")}</p> : null}
      {state.task.state === "FAILED" || (state.task.state === "AWAITING_CONFIRMATION" && !state.task.parsed) ? <Button variant="outline" disabled={state.busy} onClick={() => { void model.retry(state.task!.taskId); }}>{t("ingestion.retry")}</Button> : null}
      {!!state.task.accessories?.length && <div className="organize-preview"><h3>{t("ingestion.accessories")}</h3>{state.task.accessories.map((asset) => <div key={asset.id}><p className="path">{asset.targetPath}</p><span>{t(`ingestion.${asset.state}`)}</span>{asset.failure && <small> · {asset.failure}</small>}</div>)}{state.task.state === "DONE" && state.task.accessories.some((asset) => asset.state === "NEEDS_ATTENTION") && <Button variant="outline" disabled={state.busy} onClick={() => { void model.retry(state.task!.taskId); }}>{t("ingestion.retryAccessories")}</Button>}</div>}
      {state.task.state === "AWAITING_CONFIRMATION" && <Button variant="outline" disabled={state.busy} onClick={() => setEditingTasks([state.task!.taskId])}>编辑此项识别信息</Button>}
      {state.task.matchesStale && <p className="notice">这些 TMDB 候选来自编辑前的识别信息，请重新匹配或逐项核对后再预览整理。</p>}
      {state.task.state === "AWAITING_CONFIRMATION" && state.task.parsed && <>
        <div className="recognition-matches">{state.task.matches.map((match) => <article className="recognition-match" key={`${match.mediaType}:${match.tmdbId}`}><strong>{match.title} {match.year ?? ""}</strong><span>{Math.round(match.confidence * 100)}% · {t(`ingestion.${match.evidence}`)}</span><small>{match.explanation}</small><Button variant="outline" size="sm" disabled={state.busy} onClick={() => change(() => { setId(String(match.tmdbId)); setType(match.mediaType); })}>{t("ingestion.selected")}</Button></article>)}</div>
        <p>{t("ingestion.noMatch")}</p><div className="form-grid"><label>{t("ingestion.id")}<input type="number" min="1" value={id} disabled={state.busy} onChange={(event) => change(() => setId(event.target.value))} /></label><label>{t("ingestion.mediaType")}<select value={type} disabled={state.busy} onChange={(event) => change(() => setType(event.target.value as typeof type))}><option value="MOVIE">{t("ingestion.movie")}</option><option value="TV_SHOW">{t("ingestion.tv")}</option></select></label></div>
        {type === "TV_SHOW" && <div className="form-grid">{([{ key: "season", value: season, set: setSeason, min: 0 }, { key: "episode", value: episode, set: setEpisode, min: 1 }, { key: "end", value: end, set: setEnd, min: 1 }] as const).map((field) => <label key={field.key}>{t(`ingestion.${field.key}`)}<input type="number" min={field.min} value={field.value} disabled={state.busy} onChange={(event) => change(() => field.set(event.target.value))} /></label>)}</div>}
        <label>{t("ingestion.template")}<input value={template} disabled={state.busy} onChange={(event) => change(() => setTemplate(event.target.value))} /></label>
        <label className="check-label"><input type="checkbox" checked={includeAccessories} disabled={state.busy} onChange={(event) => change(() => setIncludeAccessories(event.target.checked))} />{t("ingestion.includeAccessories")}</label>
        <Button variant="outline" disabled={state.busy || !Number.isSafeInteger(Number(id)) || Number(id) <= 0 || (type === "TV_SHOW" && (!season || !episode))} onClick={() => { setComplete(false); void model.preview({ includeAccessories, selection: { tmdbId: Number(id), mediaType: type, season: type === "TV_SHOW" ? Number(season) : null, episode: type === "TV_SHOW" ? Number(episode) : null, episodeEnd: type === "TV_SHOW" && end ? Number(end) : null }, ...(template.trim() ? { template } : {}) }); }}>{t("ingestion.preview")}</Button>
        {state.preview && <div className="organize-preview"><h3>{state.preview.title}</h3><p className="path">{t("ingestion.source")}：{state.preview.sourcePath}</p><p className="path">{t("ingestion.target")}：{state.preview.targetPath}</p>{state.preview.mediaType === "TV_SHOW" && <p>S{state.preview.season} E{state.preview.episode}{state.preview.episodeEnd ? `–${state.preview.episodeEnd}` : ""}</p>}<div>{state.preview.accessories?.map((asset) => <p className="path" key={asset.targetPath}>{asset.sourcePath} → {asset.targetPath} · {asset.size} B</p>)}</div><p>{t("ingestion.proof")}</p><label className="check-label"><input type="checkbox" checked={complete} disabled={state.busy || previewExpired} onChange={(event) => setComplete(event.target.checked)} />{t("ingestion.completed")}</label>{previewExpired && <p role="alert" className="notice notice-error">整理预览已过期，请重新预览并核对文件完整性后确认；尚未提交 COPY。</p>}<Button disabled={state.busy || !complete || previewExpired} onClick={() => { void model.confirm(); }}>{t("ingestion.confirm")}</Button></div>}
      </>}
    </section>}
  </>;
}
