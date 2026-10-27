import { useEffect, useState } from "react";
import { useService, useServiceState } from "@yeatz/app-framework/react";
import type { ContentReview, SourceRule } from "@media-marshal/contracts";
import { ContentReviewsViewModel } from "../content-reviews-model";
import { Button } from "./ui/button";
import { ErrorNotice } from "./shared";

const states: Record<ContentReview["state"], string> = { PENDING: "等待枚举", RUNNING: "正在复核", WAITING_SOURCE: "等待来源恢复", COMPLETED: "复核完成", PARTIAL_FAILED: "部分文件未完成", FAILED: "复核未完成", CANCELLED: "已取消" };
const fileStates = { PENDING: "待复核", UNCHANGED: "内容未变", BASELINED: "已建立基线", CHANGED: "发现内容变化", FAILED: "未能复核" };
const active = (review: ContentReview) => ["PENDING", "RUNNING", "WAITING_SOURCE"].includes(review.state);
export function ContentReviewsPanel({ sources }: { sources: SourceRule[] }) {
  const model = useService(ContentReviewsViewModel), state = useServiceState(model, (value) => value), [selected, setSelected] = useState("");
  useEffect(() => model.watch(), [model]);
  const local = sources.filter((source) => source.configuration?.type === "local" && source.localSourceId), source = local.find((row) => row.id === selected) ?? local[0], detail = state.detail;
  if (!local.length && !state.items.length && !state.error && !state.queryError) return null;
  return <section className="panel content-reviews" aria-label="全量内容复核">
    <h2>全量内容复核</h2><p className="content-review-help">普通补扫比较文件属性。怀疑同尺寸文件被替换时，可完整读取本地视频内容进行复核；这会增加磁盘读取，发现新版本后仍需重新观察与人工确认。</p>
    <div className="content-review-start"><label>内容复核来源<select aria-label="内容复核来源" value={source?.id ?? ""} onChange={(event) => setSelected(event.target.value)}>{!local.length && <option value="">没有已确认的本地来源</option>}{local.map((row) => <option key={row.id} value={row.id}>{row.configuration?.name ?? row.draft.name}{row.paused ? "（已暂停）" : row.reviewRequired ? "（待核对）" : ""}</option>)}</select></label><Button variant="outline" disabled={!source || source.paused || source.reviewRequired || state.pending} onClick={() => { if (source) void model.start(source.id); }}>开始全量内容复核</Button></div>
    <p className="content-review-help">没有历史摘要的文件首次只建立内容基线；不能据此判断之前是否被替换。作业可取消，重启后继续未完成项，已完成的结果保留。</p>
    <ErrorNotice message={state.error ?? state.queryError} retry={() => { void model.refresh(); }} />
    <div className="content-review-jobs">{state.items.map((review) => <article key={review.id} aria-label={`内容复核 ${review.id}`}>
      <div className="content-review-heading"><strong>{sources.find((row) => row.id === review.sourceId || row.localSourceId === review.sourceId)?.configuration?.name ?? review.sourceId}</strong><span>{states[review.state]}</span></div>
      <p>已处理 {review.checked} / {review.total} · 内容变化 {review.changed} · 新建基线 {review.baselined} · 未能复核 {review.failed}</p>
      {active(review) && <><progress aria-label="内容复核进度" max={Math.max(1, review.total)} value={review.checked} />{review.currentPath && <p className="content-review-path">正在等待或读取：{review.currentPath}</p>}</>}
      {review.failure && <p className={review.state === "FAILED" || review.state === "PARTIAL_FAILED" ? "notice notice-error" : "notice"} role={review.state === "FAILED" || review.state === "PARTIAL_FAILED" ? "alert" : "status"}>{review.failure}</p>}
      <div className="download-controls"><Button variant="outline" size="sm" onClick={() => { void model.showFiles(review.id); }}>查看逐项结果</Button>{active(review) && <Button variant="ghost" size="sm" disabled={state.pending} onClick={() => { void model.cancel(review.id); }}>取消复核</Button>}</div>
    </article>)}</div>
    {state.total > 25 && <div className="pagination"><Button variant="outline" size="sm" disabled={state.page <= 1} onClick={() => { void model.refresh(state.page - 1); }}>上一页复核</Button><span>{state.page} / {Math.ceil(state.total / 25)}</span><Button variant="outline" size="sm" disabled={state.page * 25 >= state.total} onClick={() => { void model.refresh(state.page + 1); }}>下一页复核</Button></div>}
    {detail && <section aria-label="内容复核逐项结果" className="content-review-files"><div className="content-review-heading"><h3>逐项结果</h3><Button variant="ghost" size="sm" onClick={() => model.closeFiles()}>收起结果</Button></div><p className="content-review-help">作业 {detail.id}</p>{detail.items.map((file) => <div key={file.relativePath}><strong className="content-review-path">{file.relativePath}</strong><span>{fileStates[file.state]}</span>{file.failure && <p>{file.failure}</p>}</div>)}{detail.total > 100 && <div className="pagination"><Button variant="outline" size="sm" disabled={detail.page <= 1} onClick={() => { void model.showFiles(detail.id, detail.page - 1); }}>上一页文件</Button><span>{detail.page} / {Math.ceil(detail.total / 100)}</span><Button variant="outline" size="sm" disabled={detail.page * 100 >= detail.total} onClick={() => { void model.showFiles(detail.id, detail.page + 1); }}>下一页文件</Button></div>}</section>}
  </section>;
}
