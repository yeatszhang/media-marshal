import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useService, useServiceState } from "@yeatz/app-framework/react";
import { Cloud, Folder, File, Plus, RefreshCw, ChevronRight, ShieldCheck } from "lucide-react";
import type { CloudAccount } from "@media-marshal/contracts";
import { CloudViewModel } from "../services";
import { Header, Empty, ErrorNotice } from "../components/shared";
import { Button, cn } from "../components/ui/button";

const statusKey: Record<CloudAccount["status"], string> = { UNCONFIGURED: "unconfigured", READY: "ready", AUTH_REQUIRED: "authRequired", RESELECT_REQUIRED: "reselect", DISCONNECTED: "disconnected", UNAVAILABLE: "unavailable" };
function size(value: number | null, unknown: string) { return value === null ? unknown : value < 1024 ? `${value} B` : value < 1024 ** 2 ? `${(value / 1024).toFixed(1)} KiB` : value < 1024 ** 3 ? `${(value / 1024 ** 2).toFixed(1)} MiB` : `${(value / 1024 ** 3).toFixed(2)} GiB`; }

export function CloudDrives() {
  const navigate = useNavigate();
  const { t } = useTranslation(), model = useService(CloudViewModel), state = useServiceState(model, (value) => value);
  const [editing, setEditing] = useState(false), [name, setName] = useState(""), [cookie, setCookie] = useState(""), [accountId, setAccountId] = useState<string | undefined>(), [localError, setLocalError] = useState<string | null>(null), [submitting, setSubmitting] = useState(false), [disconnectId, setDisconnectId] = useState<string | null>(null);
  const addRef = useRef<HTMLButtonElement>(null), nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => model.watch(), [model]);
  useEffect(() => { if (editing) nameRef.current?.focus(); }, [editing]);
  const close = () => { setCookie(""); setName(""); setEditing(false); setLocalError(null); requestAnimationFrame(() => addRef.current?.focus()); };
  const edit = (account?: CloudAccount) => { setCookie(""); setName(account?.name ?? ""); setAccountId(account?.id); setLocalError(null); setEditing(true); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !cookie.trim()) { setLocalError(t("cloud.nameRequired")); return; }
    const draft = { name, accountId, cookie, requestKey: crypto.randomUUID() };
    setCookie(""); setSubmitting(true); setLocalError(null);
    try { await model.authorize(draft); close(); }
    catch (error) { setLocalError(error instanceof Error ? error.message : t("operationFailed")); }
    finally { setSubmitting(false); }
  };
  const account = state.accounts.find((value) => value.id === state.accountId);
  return <>
    <Header title={t("cloud.title")} description={t("cloud.help")}>
      <Button ref={addRef} disabled={editing || state.authorizing} onClick={() => edit()}><Plus size={16} />{t("cloud.add")}</Button>
    </Header>
    <ErrorNotice message={state.error} />
    <section className="panel cloud-root" aria-label={t("cloud.downloadRoot")}><div className="cloud-browser-toolbar"><h2>{t("cloud.downloadRoot")}</h2><Button variant="outline" size="sm" disabled={state.selectingRoot} onClick={() => { void model.chooseRoot(); }}><Folder size={15} />{t("cloud.chooseRoot")}</Button></div><p className="cloud-hint">{t("cloud.rootHelp")}</p>{!state.roots.length ? <p>{t("cloud.noRoot")}</p> : state.roots.map((root) => <p key={root.id} className="cloud-root-path"><strong title={root.path}>{root.path}</strong><span>{root.state === "AVAILABLE" ? t("cloud.rootAvailable", { size: size(root.availableBytes, t("cloud.unknownSize")) }) : t("cloud.rootUnavailable")}</span></p>)}</section>
    {state.authorizing && <div className="notice" role="status">{t("cloud.authorizing")}</div>}
    {state.authorization?.state === "SUCCEEDED" && !state.authorizing && <div className="notice" role="status"><ShieldCheck size={16} />{t("cloud.authorizationSucceeded")}</div>}
    {editing && <form className="panel source-form cloud-credential-form" onSubmit={submit} onKeyDown={(event) => { if (event.key === "Escape" && !submitting) close(); }}>
      <h2>{t(accountId ? "cloud.reauthorize" : "cloud.add")}</h2>
      <label>{t("cloud.accountName")}<input ref={nameRef} value={name} maxLength={100} onChange={(event) => setName(event.target.value)} /></label>
      <label>{t("cloud.cookie")}<input type="password" autoComplete="off" spellCheck={false} value={cookie} maxLength={32768} onChange={(event) => setCookie(event.target.value)} /></label>
      <p className="cloud-hint">{t("cloud.cookieHelp")}</p><p className="cloud-hint">{t("cloud.privacy")}</p>
      <ErrorNotice message={localError} />
      <div className="form-actions"><Button variant="ghost" disabled={submitting} onClick={close}>{t("cancel")}</Button><Button type="submit" disabled={submitting || state.authorizing}>{t("cloud.submit")}</Button></div>
    </form>}
    {!state.loadingAccounts && !state.accounts.length && !editing && <section className="panel"><Empty icon={<Cloud size={28} />} title={t("cloud.emptyTitle")} description={t("cloud.emptyHelp")} /></section>}
    {!!state.accounts.length && <div className="cloud-layout">
      <section className="panel cloud-accounts" aria-label={t("cloud.title")}>
        {state.accounts.map((value) => <article key={value.id} className={cn("cloud-account", state.accountId === value.id && "selected")}>
          <button className="cloud-account-select" onClick={() => { setDisconnectId(null); void model.selectAccount(value.id); }}><Cloud size={18} /><span><strong>{value.name}</strong><small>{t(`cloud.${statusKey[value.status]}`)}</small></span></button>
          <div className="cloud-account-actions"><Button variant="ghost" size="sm" disabled={state.authorizing || submitting} onClick={() => edit(value)}>{t("cloud.reauthorize")}</Button>{value.status !== "DISCONNECTED" && <Button variant="ghost" size="sm" disabled={state.authorizing} onClick={() => setDisconnectId(value.id)}>{t("cloud.disconnect")}</Button>}</div>
          {disconnectId === value.id && <div className="cloud-disconnect"><p>{t("cloud.disconnectHelp")}</p><Button variant="ghost" size="sm" onClick={() => setDisconnectId(null)}>{t("cancel")}</Button><Button size="sm" onClick={() => { setDisconnectId(null); void model.disconnect(value.id); }}>{t("cloud.confirmDisconnect")}</Button></div>}
        </article>)}
        <Button variant="ghost" size="sm" onClick={() => { void model.restore(); }}><RefreshCw size={14} />{t("cloud.restore")}</Button>
      </section>
      <section className="panel cloud-browser" aria-label={t("cloud.browser")}>
        {!account || !state.trail.length ? <Empty icon={<Folder size={28} />} title={t("cloud.pickAccount")} description={t("cloud.pickAccountHelp")} /> : <>
          {account.status === "RESELECT_REQUIRED" && <div className="notice">{t("cloud.reselectHelp")}</div>}
          <div className="cloud-browser-toolbar"><nav className="cloud-breadcrumbs" aria-label={t("cloud.browser")}>{state.trail.map((entry, index) => <span key={entry.ref}><Button variant="ghost" size="sm" title={entry.name} onClick={() => { void model.goTo(index); }}>{index === 0 ? t("cloud.root") : entry.name}</Button>{index < state.trail.length - 1 && <ChevronRight size={12} />}</span>)}</nav><Button variant="ghost" size="sm" disabled={state.loading} onClick={() => { void model.browse(false); }} aria-label={t("cloud.refresh")}><RefreshCw size={15} /></Button></div>
          <div className="cloud-page-count" role="status"><span>{t("cloud.shown", { count: state.items.length })} · {state.total === null ? t("cloud.unknownTotal") : t("cloud.knownTotal", { count: state.total })}</span>{state.loading && <span>{t("cloud.loading")}</span>}</div>
          {!state.complete && !state.loading && <p className="cloud-hint">{t("cloud.partial")}</p>}
          {!state.loading && state.complete && !state.items.length && <Empty icon={<Folder size={24} />} title={t("cloud.folderEmpty")} description={t("cloud.folderEmptyHelp")} />}
          {!!state.items.length && <table className="cloud-files"><thead><tr><th>{t("cloud.fileName")}</th><th>{t("cloud.fileSize")}</th><th>{t("cloud.action")}</th></tr></thead><tbody>{state.items.map((entry) => <tr key={entry.ref}><td><div className="cloud-file-name">{entry.type === "directory" ? <Folder size={16} /> : <File size={16} />}<span title={entry.name}>{entry.name}</span></div></td><td>{entry.type === "directory" ? t("cloud.directory") : size(entry.size, t("cloud.unknownSize"))}</td><td><div className="cloud-file-actions">{entry.type === "directory" && <Button variant="ghost" size="sm" aria-label={`${t("cloud.open")} ${entry.name}`} onClick={() => { void model.enter(entry); }}>{t("cloud.open")}</Button>}<Button variant="ghost" size="sm" aria-label={`${t("cloud.preview")} ${entry.name}`} onClick={() => { void model.preview(entry); }}>{t("cloud.preview")}</Button></div></td></tr>)}</tbody></table>}
          {state.cursor && <Button variant="outline" size="sm" disabled={state.loading} onClick={() => { void model.browse(true); }}>{t("cloud.more")}</Button>}
          <section className="cloud-preview" aria-label={t("cloud.previewTitle")}><h2>{t("cloud.previewTitle")}</h2>{state.previewing ? <p role="status">{t("cloud.previewing")}</p> : state.selection ? <><strong className="cloud-selected-name">{state.selection.name}</strong><p>{state.selection.type === "directory" ? t("cloud.directoryScope") : size(state.selection.size, t("cloud.unknownSize"))}</p><p>{t("cloud.modified")}: {state.selection.modifiedAt ?? "—"}</p>{state.selection.version?.kind !== "hash" && state.selection.version?.kind !== "revision" && <p>{t("cloud.noVersion")}</p>}
            <div className="cloud-scope-options">
              {state.editingSubscription && <p role="status">正在修改订阅 v{state.editingSubscription.version}，需要重新预览并确认。<Button variant="ghost" size="sm" onClick={() => model.clearSubscriptionEdit()}>退出修改</Button></p>}
              <label>下载方式<select aria-label="下载方式" value={state.purpose} disabled={!!state.editingSubscription} onChange={(event) => model.setDownloadOptions({ purpose: event.target.value as "once" | "subscription", forceRedownload: false })}><option value="once">下载一次</option><option value="subscription" disabled={state.selection.type !== "directory"}>订阅目录</option></select></label>
              <label>扩展名过滤（逗号分隔，留空为全部）<input aria-label="扩展名过滤" value={state.extensions} onChange={(event) => model.setDownloadOptions({ extensions: event.target.value })} placeholder="mp4,mkv" /></label>
              <label>精确文件名过滤（每行一个，留空为全部）<textarea aria-label="精确文件名过滤" rows={2} value={state.names} onChange={(event) => model.setDownloadOptions({ names: event.target.value })} /></label>
              {state.purpose === "subscription" ? <><label>扫描间隔<select aria-label="扫描间隔" value={state.intervalSeconds} onChange={(event) => model.setDownloadOptions({ intervalSeconds: Number(event.target.value) })}>{[60, 300, 900, 3600, 86400].map((seconds) => <option value={seconds} key={seconds}>{seconds < 3600 ? `${seconds / 60} 分钟` : `${seconds / 3600} 小时`}</option>)}</select></label><p className="cloud-hint">应用运行时定期扫描；退出期间不下载，再次启动合并补扫一次。源端删除不会删除本地成果。</p></> : <label className="cloud-checkbox"><input type="checkbox" checked={state.forceRedownload} onChange={(event) => model.setDownloadOptions({ forceRedownload: event.target.checked })} />强制重新下载到独立目录，保留原成果</label>}
            </div>
            <div className="cloud-download-actions"><label>{t("cloud.downloadRoot")}<select value={state.targetRootId ?? ""} onChange={(event) => model.setDownloadRoot(event.target.value)}><option value="" disabled>{t("cloud.noRoot")}</option>{state.roots.map((root) => <option key={root.id} value={root.id} disabled={root.state !== "AVAILABLE"}>{root.path}</option>)}</select></label><Button variant="outline" disabled={!state.targetRootId || state.scanning || state.confirming} onClick={() => { void model.scanDownload(); }}>{t("cloud.scanDownload")}</Button></div>
            {state.scanning && <p role="status">{t("cloud.scanningDownload")}</p>}
            {state.downloadPreview && <div className="cloud-scope-summary"><p>{t(state.downloadPreview.complete ? "cloud.scopeComplete" : "cloud.scopePartial", { count: state.downloadPreview.files, size: size(state.downloadPreview.bytes, t("cloud.unknownSize")) })}</p><p>已核对可复用 {state.downloadPreview.reuseFiles} 项 · 目标冲突 {state.downloadPreview.conflicts} 项</p><p className="cloud-root-path">目标：{state.roots.find((root) => root.id === state.downloadPreview?.targetGrantId)?.path}/{state.downloadPreview.destinationPrefix}/{state.downloadPreview.selectionPath}</p>{state.downloadPreview.failure && <ErrorNotice message={state.downloadPreview.failure.message} />}<Button disabled={state.downloadPreview.state !== "READY" || !state.downloadPreview.complete || state.confirming} onClick={() => { void (state.purpose === "subscription" ? model.confirmSubscription() : model.confirmDownload()).then((id) => { if (id) navigate(state.purpose === "subscription" ? "/subscriptions" : "/downloads"); }); }}>{state.purpose === "subscription" ? state.editingSubscription ? "确认更新订阅" : "确认启用订阅" : t("cloud.confirmDownload")}</Button></div>}
          </> : <p>{t("cloud.previewEmpty")}</p>}<p className="cloud-hint">{t("cloud.weak")}</p><p className="cloud-hint">{t("cloud.restartDownload")}</p></section>
        </>}
      </section>
    </div>}
  </>;
}
