import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useService, useServiceState } from "@yeatz/app-framework/react";
import type { CloudSubscription } from "@media-marshal/contracts";
import { CloudViewModel, SubscriptionsViewModel } from "../services";
import { Header, Empty, ErrorNotice } from "../components/shared";
import { Button } from "../components/ui/button";

const labels: Record<CloudSubscription["state"], string> = { IDLE: "等待下次扫描", SCANNING: "正在扫描", RETRY_WAIT: "等待重试", PAUSED: "已暂停", AUTH_REQUIRED: "需要重新授权", BLOCKED_LOCAL: "原磁盘不可用", RESELECT_REQUIRED: "需要重新选择目录", FAILED: "扫描失败", CANCELLED: "已取消" };
const date = (value: string | null) => value ? new Date(value).toLocaleString() : "—";
export function Subscriptions() {
  const model = useService(SubscriptionsViewModel), cloud = useService(CloudViewModel), state = useServiceState(model, (value) => value), navigate = useNavigate();
  useEffect(() => model.watch(), [model]);
  return <>
    <Header title="目录订阅" description="应用运行时定期扫描；退出期间不下载，再启动合并补扫一次。"><Button onClick={() => navigate("/cloud")}>添加目录订阅</Button></Header>
    <ErrorNotice message={state.error} />
    <div className="notice">暂停订阅会暂停该订阅的扫描和下载需求。暂停本地整理不影响云端下载；源端删除不会删除本地成果。</div>
    <p className="cloud-hint">夸克使用弱版本比较，同尺寸内容替换可能无法识别。发现冲突时保留原成果，可从网盘选择强制重下到独立目录。</p>
    {!state.items.length && <section className="panel"><Empty icon={null} title="还没有目录订阅" description="从云端网盘选择目录，完成范围预览并确认启用。" /></section>}
    <div className="download-queue">{state.items.map((sub) => <article key={sub.id} className="panel download-job" aria-label={sub.name}>
      <div className="cloud-browser-toolbar"><h2 title={sub.name}>{sub.name}</h2><span className="badge">{labels[sub.state]}</span></div>
      <p>配置 v{sub.configurationVersion} · 每 {sub.intervalSeconds / 60} 分钟扫描 · 扩展名 {sub.filters.extensions.join(", ") || "全部"}</p>
      {!!sub.filters.names.length && <p className="cloud-root-path">精确文件名：{sub.filters.names.join("；")}</p>}
      <p>最近扫描：{date(sub.lastScanAt)} · 下次运行：{date(sub.nextScanAt)}</p>
      {sub.lastResult && <p role="status">{sub.lastResult.complete ? "完整扫描" : "扫描未完成"}：{sub.lastResult.files} 项 · 复用 {sub.lastResult.reused} 项 · 冲突 {sub.lastResult.conflicts} 项。下载进度请查看云端下载。</p>}
      {sub.failure && <ErrorNotice message={sub.failure.message} />}
      {sub.state !== "CANCELLED" && <div className="download-controls">
        {sub.enabled ? <><Button size="sm" variant="outline" disabled={state.busy.includes(sub.id)} onClick={() => { void model.control(sub.id, "scan"); }}>立即扫描</Button><Button size="sm" variant="outline" disabled={state.busy.includes(sub.id)} onClick={() => { void model.control(sub.id, "pause"); }}>暂停订阅</Button></> : <Button size="sm" variant="outline" disabled={state.busy.includes(sub.id) || sub.state === "RESELECT_REQUIRED"} onClick={() => { void model.control(sub.id, "resume"); }}>恢复订阅</Button>}
        <Button size="sm" variant="outline" onClick={() => { void cloud.editSubscription(sub).then(() => navigate("/cloud")); }}>修改范围并预览</Button>
        <Button size="sm" variant="ghost" disabled={state.busy.includes(sub.id)} onClick={() => { void model.control(sub.id, "cancel"); }}>取消订阅</Button>
      </div>}
    </article>)}</div>
    <div className="download-pagination"><Button variant="outline" size="sm" disabled={state.page <= 1} onClick={() => { void model.refresh(state.page - 1); }}>上一页</Button><span>第 {state.page} 页 · 共 {state.total} 个订阅</span><Button variant="outline" size="sm" disabled={state.page * 25 >= state.total} onClick={() => { void model.refresh(state.page + 1); }}>下一页</Button></div>
  </>;
}
