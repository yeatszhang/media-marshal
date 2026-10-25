import { useEffect } from "react";
import { Link } from "react-router-dom";
import { useService, useServiceState } from "@yeatz/app-framework/react";
import type { SourceRule } from "@media-marshal/contracts";
import { SourceScansViewModel } from "../source-scans-model";
import { Button } from "./ui/button";
import { ErrorNotice } from "./shared";
const states = { PENDING: "等待补扫", RUNNING: "正在扫描", WAITING_SOURCE: "等待来源恢复", COMPLETED: "扫描完成", PARTIAL_FAILED: "部分文件未能核对", FAILED: "扫描未完成" };
export function SourceScansPanel({ sources }: { sources: SourceRule[] }) {
  const model = useService(SourceScansViewModel), state = useServiceState(model, (value) => value), detail = state.detail;
  useEffect(() => model.watch(), [model]);
  const available = sources.filter((source) => source.configuration?.organization);
  return <section className="panel source-scans-panel" aria-label="手动目录扫描">
    <h2>补扫本地文件</h2><p className="cloud-hint">提交后在后台扫描，离开页面仍会继续。只发现和观察文件；识别与 COPY 仍需在待处理核对并确认。</p>
    <div className="download-controls">{available.map((source) => <Button key={source.id} variant="outline" size="sm" disabled={state.pending || source.paused || source.reviewRequired} onClick={() => { void model.start(source.id); }}>扫描目录 · {source.configuration!.name}</Button>)}</div>
    {!available.length && <p className="cloud-hint">请先在来源页确认本地输入与整理目标，或为网盘来源开启整理。</p>}
    {available.some((source) => source.paused || source.reviewRequired) && <p className="cloud-hint">暂停或待核对的来源暂不能新增补扫，请先到 <Link to="/sources">来源页</Link> 恢复或重新预览；既有补扫会保留等待状态。</p>}
    <ErrorNotice message={state.error} /><ErrorNotice message={state.queryError} retry={() => { void model.refresh(); }} />
    {state.pending && <p role="status">正在登记扫描意图…</p>}
    <div className="source-scan-list">{state.items.map((job) => <article key={job.id} aria-label={`目录扫描 ${job.sourceName}`}>
      <div className="content-review-heading"><strong>{job.sourceName}</strong><span className="badge">{states[job.state]}</span></div>
      <p className="cloud-hint">作业 {job.id} · {new Date(job.updatedAt).toLocaleString()}</p>
      {["COMPLETED", "PARTIAL_FAILED"].includes(job.state) ? <p>本次核对媒体项 {job.discovered} · 未能核对 {job.failed}</p> : <p>完整枚举前数量尚未确定；中断前已发现的候选保留，恢复后重新补扫。</p>}
      {job.failure && <p className={job.state === "FAILED" || job.state === "PARTIAL_FAILED" ? "notice notice-error" : "notice"} role={job.state === "FAILED" || job.state === "PARTIAL_FAILED" ? "alert" : "status"}>{job.failure}</p>}
      <div className="download-controls">{!!job.failed && <Button variant="outline" size="sm" onClick={() => { void model.inspect(job.id); }}>查看扫描问题</Button>}<Link to={`/sources?source=${job.sourceId}`}>管理来源</Link>{["FAILED", "PARTIAL_FAILED", "COMPLETED"].includes(job.state) && available.some((source) => source.id === job.sourceId && !source.paused && !source.reviewRequired) && <Button variant="ghost" size="sm" disabled={state.pending} onClick={() => { void model.start(job.sourceId); }}>重新扫描</Button>}</div>
    </article>)}</div>
    {state.total > 25 && <div className="pagination"><Button variant="outline" size="sm" disabled={state.page <= 1} onClick={() => { void model.refresh(state.page - 1); }}>上一页扫描</Button><span>{state.page} / {Math.ceil(state.total / 25)}</span><Button variant="outline" size="sm" disabled={state.page * 25 >= state.total} onClick={() => { void model.refresh(state.page + 1); }}>下一页扫描</Button></div>}
    {detail && <section aria-label="目录扫描逐项问题" className="content-review-files"><div className="content-review-heading"><h3>{detail.job.sourceName} · 扫描问题</h3><Button variant="ghost" size="sm" onClick={() => model.closeDetail()}>收起扫描问题</Button></div>{detail.issues.map((issue) => <div key={issue.relativePath}><strong className="content-review-path">{issue.relativePath}</strong><p>{issue.failure}</p></div>)}{detail.total > 100 && <div className="pagination"><Button variant="outline" size="sm" disabled={detail.page <= 1} onClick={() => { void model.inspect(detail.job.id, detail.page - 1); }}>上一页扫描问题</Button><span>{detail.page} / {Math.ceil(detail.total / 100)}</span><Button variant="outline" size="sm" disabled={detail.page * 100 >= detail.total} onClick={() => { void model.inspect(detail.job.id, detail.page + 1); }}>下一页扫描问题</Button></div>}</section>}
  </section>;
}
