import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Plus, Folder, RefreshCw } from "lucide-react";
import type { SourceRule } from "@media-marshal/contracts";
import { useSourceRules } from "../source-draft-context";
import { sourceClients, sourceDate, sourceRunLabels, sourceScanLabels } from "../source-format";
import { SourceEditorForm } from "../components/SourceEditorForm";
import { SourceRemotePicker } from "../components/SourceRemotePicker";
import { SourceExecutionPreview } from "../components/SourceExecutionPreview";
import { SourceLifecycleDialog } from "../components/SourceLifecycleDialog";
import { Header, Empty, ErrorNotice } from "../components/shared";
import { Button } from "../components/ui/button";

export function Sources() {
  const { model, state } = useSourceRules(), [query, setQuery] = useSearchParams();
  const [page, setPage] = useState(1), addRef = useRef<HTMLButtonElement>(null), sourceId = query.get("source"), legacyJob = query.get("legacyJob"), busy = state.hasPending;
  const [archivedPage, setArchivedPage] = useState(1), [lifecycle, setLifecycle] = useState<{ row: SourceRule; operation: "remove" | "restore" } | null>(null);
  useEffect(() => model.watch(), [model]);
  useEffect(() => { if (sourceId) void model.openSource(sourceId); }, [model, sourceId]);
  useEffect(() => { if (!sourceId && legacyJob) void model.openLegacy("download-job", legacyJob); }, [model, sourceId, legacyJob]);
  const close = () => { model.closeEditor(); setQuery({}); requestAnimationFrame(() => { if (!document.querySelector("dialog[open]")) addRef.current?.focus(); }); };
  const open = (row: SourceRule) => { if (sourceId === row.id) void model.openSource(row.id); else setQuery({ source: row.id }); };
  const pages = Math.max(1, Math.ceil(state.sourceCount / 25)), visiblePage = Math.min(page, pages);
  const archivePages = Math.max(1, Math.ceil(state.archivedCount / 25)), visibleArchivePage = Math.min(archivedPage, archivePages);
  const requestLifecycle = (row: SourceRule, operation: "remove" | "restore") => { if (model.prepareLifecycle(row)) setLifecycle({ row, operation }); };
  return <>
    <Header title="来源配置" description="把网盘内容下载到本地，或整理已有本地文件。每个来源独立设置下载方式和媒体库目标。">
      <Button variant="outline" disabled={busy} onClick={() => { void model.toggleOrganizePause(); }}>{state.organizePaused ? "恢复全部整理" : "暂停全部整理"}</Button>
      <Button variant="outline" onClick={() => { void model.reload(); }} aria-label="刷新来源"><RefreshCw size={15} /></Button>
      <Button ref={addRef} data-source-add disabled={busy} onClick={() => { setQuery({}); model.newSource(); }}><Plus size={16} />添加来源</Button>
    </Header>
    <ErrorNotice message={state.error} retry={() => { void model.reload(); }} />
    {state.legacyNotice && <p className="notice" role="status">{state.legacyNotice} <Link to="/downloads">查看下载历史</Link></p>}
    {state.notice && <p className="notice" role="status">{state.notice}</p>}
    {state.organizePaused && <p className="notice">全部整理已暂停。恢复来源不会解除此暂停；云端下载与已提交文件的 Emby 交付仍独立处理。</p>}
    {state.editor && <SourceEditorForm onClose={close} />}
    {state.picker && <SourceRemotePicker />}
    {state.executionPreview && <SourceExecutionPreview />}
    {!state.items.length && !state.editor && <section className="panel"><Empty icon={<Folder size={28} />} title="还没有来源" description="添加网盘来源下载到本地，或接入现有本地目录进行识别与整理。" /></section>}
    <div className="source-list">{state.items.slice((visiblePage - 1) * 25, visiblePage * 25).map((row) => {
      const configuration = row.configuration ?? row.draft, subscription = state.subscriptions.find((value) => value.id === row.subscriptionId), rowBusy = busy || state.busy.includes(row.id), downloadRoot = configuration.type === "cloud" ? state.roots.find((value) => value.id === configuration.downloadRootId) : null;
      return <article className="panel source-rule-card" key={row.id} aria-label={`来源 ${configuration.name}`}>
        <div className="cloud-browser-toolbar"><h3 title={configuration.name}>{configuration.name}</h3><span className="badge">{row.type === "cloud" ? "网盘来源" : "本地来源"}</span></div>
        <p className="source-card-status">{row.version ? `生效版本 v${row.version}` : "草稿，尚未确认"}{row.paused && row.version > 0 ? " · 来源已暂停" : ""}{row.reviewRequired ? " · 归属待核对" : ""}</p>
        {configuration.type === "cloud" ? <><p className="cloud-root-path">{state.accounts.find((value) => value.id === configuration.accountId)?.name ?? "账号需核对"} · {row.remoteName ?? "远端范围需核对"} → {downloadRoot?.path ?? "下载目录待授权"}</p><p className="cloud-hint">{configuration.periodic.enabled ? `每 ${configuration.periodic.intervalSeconds / 60} 分钟扫描` : "仅手动执行，不开启周期扫描"} · {configuration.organization ? "下载后整理到媒体库" : "只下载，未启用整理"}</p></> : <p className="cloud-root-path">{sourceClients[configuration.client]} · {configuration.sourcePath}</p>}
        {configuration.organization && <p className="cloud-root-path">整理目标：{configuration.organization.targetPath} · COPY · 人工确认</p>}
        {row.version > 0 && JSON.stringify(row.draft) !== JSON.stringify(row.configuration) && <p className="notice">有尚未生效的草稿，执行仍沿用 v{row.version}。</p>}
        {subscription && <div className="cloud-hint"><p>{sourceScanLabels[subscription.state]} · 最近扫描 {sourceDate(subscription.lastScanAt)} · 下次运行 {sourceDate(subscription.nextScanAt)}</p>{subscription.lastResult && <p>{subscription.lastResult.complete ? "完整扫描" : "扫描未完成"}：{subscription.lastResult.files} 项，复用 {subscription.lastResult.reused} 项，冲突 {subscription.lastResult.conflicts} 项。</p>}{subscription.failure && <ErrorNotice message={subscription.failure.message} />}</div>}
        {row.lastRun && <p className="cloud-hint" role="status">最近一次{row.lastRun.forceRedownload ? "强制" : ""}执行：{sourceRunLabels[row.lastRun.state]}{row.lastRun.failure ? ` · ${row.lastRun.failure.message}` : ""} {row.lastRun.jobId && <Link to="/downloads">查看下载</Link>}</p>}
        <div className="download-controls"><Button variant="outline" size="sm" disabled={rowBusy} onClick={() => open(row)}>编辑并预览</Button>{row.version > 0 && <>
          {configuration.type === "cloud" && <Button data-source-execution-source={row.id} data-source-execution-force="false" variant="outline" size="sm" disabled={rowBusy || row.paused || row.reviewRequired} onClick={() => { void model.control(row, "once"); }}>执行一次</Button>}
          {configuration.type === "cloud" && <Button data-source-execution-source={row.id} data-source-execution-force="true" variant="ghost" size="sm" disabled={rowBusy || row.paused || row.reviewRequired} onClick={() => { void model.previewExecution(row, true); }}>强制重新下载…</Button>}
          {configuration.type === "cloud" && configuration.periodic.enabled && <Button variant="outline" size="sm" disabled={rowBusy || row.paused || row.reviewRequired} onClick={() => { void model.control(row, "scan"); }}>立即扫描</Button>}
          <Button variant="ghost" size="sm" disabled={rowBusy || (row.paused && row.reviewRequired)} onClick={() => { void model.control(row, row.paused ? "resume" : "pause"); }}>{row.paused ? "恢复来源" : "暂停来源"}</Button>
        </>}<Button variant="ghost" size="sm" disabled={rowBusy} onClick={() => requestLifecycle(row, "remove")}>删除来源…</Button></div>
      </article>;
    })}</div>
    {pages > 1 && <div className="download-pagination"><Button variant="outline" disabled={visiblePage <= 1} onClick={() => setPage(visiblePage - 1)}>上一页来源</Button><span>{visiblePage} / {pages}</span><Button variant="outline" disabled={visiblePage >= pages} onClick={() => setPage(visiblePage + 1)}>下一页来源</Button></div>}
    {!!state.archived.length && <details className="panel source-archive"><summary>已删除来源（{state.archived.length}）</summary><p className="cloud-hint">原文件、配置和任务历史保留。恢复后仍保持暂停。</p><div className="source-list">{state.archived.slice((visibleArchivePage - 1) * 25, visibleArchivePage * 25).map((row) => {
      const configuration = row.configuration ?? row.draft;
      return <article className="source-rule-card" key={row.id} aria-label={`已删除来源 ${configuration.name}`}><h3>{configuration.name}</h3><p className="cloud-root-path">{configuration.type === "local" ? configuration.sourcePath : state.roots.find((root) => root.id === configuration.downloadRootId)?.path ?? "原下载目录需核对"}</p><p className="cloud-hint">删除于 {sourceDate(row.deletedAt ?? null)} · {row.version ? `保留版本 v${row.version}` : "保留草稿"}</p><div className="download-controls"><Button variant="outline" size="sm" disabled={busy} onClick={() => open(row)}>查看保留配置</Button><Button variant="outline" size="sm" disabled={busy} onClick={() => requestLifecycle(row, "restore")}>恢复已删除来源…</Button></div></article>;
    })}</div>{archivePages > 1 && <div className="download-pagination"><Button variant="outline" disabled={visibleArchivePage <= 1} onClick={() => setArchivedPage(visibleArchivePage - 1)}>上一页已删除来源</Button><span>{visibleArchivePage} / {archivePages}</span><Button variant="outline" disabled={visibleArchivePage >= archivePages} onClick={() => setArchivedPage(visibleArchivePage + 1)}>下一页已删除来源</Button></div>}</details>}
    {lifecycle && <SourceLifecycleDialog {...lifecycle} onClose={() => { setLifecycle(null); if (!state.editor) setQuery({}); }} />}
    {!!state.legacy.length && <section className="panel"><h2>升级后待核对的旧配置</h2><p className="cloud-hint">保留原文件与历史，不按下载根推定整理归属。</p>{state.legacy.map((reference) => <div className="download-controls" key={`${reference.kind}:${reference.id}`}><span>{reference.kind === "subscription" ? "旧目录订阅" : reference.kind === "managed-binding" ? "旧整理绑定" : reference.kind === "download-job" ? "旧下载记录" : "旧本地来源"} · 归属或历史快照待核对</span><Button variant="ghost" size="sm" onClick={() => { void model.openLegacy(reference.kind, reference.id); }}>定位旧配置</Button></div>)}</section>}
    <p className="cloud-hint">暂停来源会停止其新扫描、下载需求与整理接入；仍被其他有效来源需要的共享文件继续处理。全局下载暂停与全局整理暂停各自独立，恢复来源不会解除它们。</p>
  </>;
}
