import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useSourceRules } from "../source-draft-context";
import { sourceSize } from "../source-format";
import { ErrorNotice } from "./shared";
import { Button } from "./ui/button";

export function SourceExecutionPreview() {
  const { model, state } = useSourceRules(), preview = state.executionPreview, ref = useRef<HTMLElement>(null), busy = !!state.pending;
  useEffect(() => { if (preview?.id) { ref.current?.scrollIntoView?.({ block: "nearest" }); ref.current?.focus(); } return () => { if (preview) requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(`[data-source-execution-source="${preview.sourceId}"][data-source-execution-force="${preview.forceRedownload}"]`)?.focus()); }; }, [preview?.id]);
  if (!preview) return null;
  return <section ref={ref} tabIndex={-1} className="panel source-execution-preview" aria-label="来源执行预览" onKeyDown={(event) => { if (event.key === "Escape" && !busy) model.closeExecutionPreview(); }}>
    <h2>{preview.forceRedownload ? "强制重新下载预览" : "执行一次预览"}</h2><p>{preview.name} · 生效版本 v{preview.sourceVersion}</p><p className="cloud-hint">只执行当前生效版本，不修改来源草稿或周期扫描策略。</p>
    {preview.state === "BUILDING" && <p role="status">正在扫描本次范围，数量尚未完整确定。</p>}
    <p>{preview.download.complete ? "完整范围" : "范围尚未完整"}：{preview.download.files} 项 · {sourceSize(preview.download.bytes)} · 可复用 {preview.download.reuseFiles} 项 · 冲突 {preview.download.conflicts} 项</p>
    {!!preview.download.localRemovedFiles && <p className="notice" role="status">{preview.download.localRemovedFiles} 项已同步，本地已移除。本次会跳过同一源版本；需要重新获取时，请从来源选择强制重新下载并确认预览。</p>}
    <p className="cloud-root-path">完成目录：{state.roots.find((root) => root.id === preview.download.targetGrantId)?.path}/{preview.download.destinationPrefix}/{preview.download.selectionPath}</p>
    {preview.forceRedownload && <p className="notice">本次会重新传输到独立完成目录，保留原下载文件，不覆盖已有媒体成果。</p>}
    {preview.download.failure && <ErrorNotice message={preview.download.failure.message} />}
    {preview.state === "EXPIRED" && <p role="alert">执行预览已过期、来源暂停或配置变化，请重新预览。</p>}
    {preview.state === "FAILED" && !preview.download.failure && <p role="alert">本次范围不完整或存在冲突，请检查后重新预览。</p>}
    {preview.state === "APPLIED" ? <p role="status">已确认执行。<Link to="/downloads">查看云端下载</Link></p> : <div className="form-actions"><Button variant="outline" disabled={busy} onClick={() => { void model.retryExecutionPreview(); }}>重新预览本次执行</Button><Button disabled={busy || preview.state !== "READY"} onClick={() => { void model.confirmExecution(); }}>{preview.forceRedownload ? "确认强制下载到独立目录" : "确认执行一次"}</Button></div>}
    <Button variant="ghost" disabled={busy} onClick={() => model.closeExecutionPreview()}>关闭执行预览</Button>
  </section>;
}
