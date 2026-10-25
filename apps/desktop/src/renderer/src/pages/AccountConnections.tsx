import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useService, useServiceState } from "@yeatz/app-framework/react";
import { Cloud, Plus, QrCode, RefreshCw, ShieldCheck } from "lucide-react";
import type { CloudAccount } from "@media-marshal/contracts";
import { CloudAccountsViewModel } from "../cloud-accounts-model";
import { Header, Empty, ErrorNotice } from "../components/shared";
import { Button } from "../components/ui/button";

const statusKey: Record<CloudAccount["status"], string> = { UNCONFIGURED: "unconfigured", READY: "ready", AUTH_REQUIRED: "authRequired", RESELECT_REQUIRED: "reselect", DISCONNECTED: "disconnected", UNAVAILABLE: "unavailable" };
export function AccountConnections() {
  const { t } = useTranslation(), model = useService(CloudAccountsViewModel), state = useServiceState(model, (value) => value), navigate = useNavigate(), [query] = useSearchParams();
  const [editing, setEditing] = useState(false), [name, setName] = useState(""), [cookie, setCookie] = useState(""), [accountId, setAccountId] = useState<string | undefined>(), [localError, setLocalError] = useState<string | null>(null), [submitting, setSubmitting] = useState(false), [disconnectId, setDisconnectId] = useState<string | null>(null), [method, setMethod] = useState<"scan" | "cookie">("scan");
  const addRef = useRef<HTMLButtonElement>(null), nameRef = useRef<HTMLInputElement>(null), previousSuccess = useRef(state.authorization?.state === "SUCCEEDED" ? state.authorization.id : null);
  const returning = query.get("returnTo") === "sources";
  useEffect(() => model.watch(), [model]);
  useEffect(() => { if (editing) nameRef.current?.focus(); }, [editing]);
  useEffect(() => { if (returning && state.authorization?.state === "SUCCEEDED" && state.authorization.id !== previousSuccess.current) navigate("/sources", { replace: true }); }, [navigate, returning, state.authorization]);
  const close = () => { setCookie(""); setName(""); setEditing(false); setLocalError(null); requestAnimationFrame(() => addRef.current?.focus()); };
  const edit = (account?: CloudAccount) => { setCookie(""); setName(account?.name ?? ""); setAccountId(account?.id); setMethod("scan"); setLocalError(null); setEditing(true); };
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (submitting || state.authorizing || state.loggingIn) return;
    if (method === "scan") { if (!name.trim()) { setLocalError(t("cloud.scanNameRequired")); return; } setLocalError(null); if (await model.login(name, accountId)) close(); return; }
    if (!name.trim() || !cookie.trim()) { setLocalError(t("cloud.nameRequired")); return; }
    const draft = { name, accountId, cookie, requestKey: crypto.randomUUID() }; setCookie(""); setSubmitting(true); setLocalError(null);
    try { await model.authorize(draft); close(); } catch (error) { setLocalError(error instanceof Error ? error.message : t("operationFailed")); } finally { setSubmitting(false); }
  };
  return <>
    <Header title="网盘账号" description="连接和管理自己的夸克账号。远端范围、下载位置和整理策略在来源配置中设置。">
      {returning && <Button variant="outline" onClick={() => navigate("/sources")}>返回来源草稿</Button>}
      <Button ref={addRef} disabled={editing || state.authorizing || state.loggingIn} onClick={() => edit()}><Plus size={16} />{t("cloud.add")}</Button>
    </Header>
    <ErrorNotice message={state.error} />
    <p className="cloud-hint">连接账号不会创建来源、开启扫描或启动下载。<Link to="/sources">前往来源配置</Link></p>
    {state.authorizing && <p className="notice" role="status">{t("cloud.authorizing")}</p>}
    {state.authorization?.state === "SUCCEEDED" && !state.authorizing && <p className="notice" role="status"><ShieldCheck size={16} />{t("cloud.authorizationSucceeded")}</p>}
    {editing && <form className="panel source-form cloud-credential-form" onSubmit={submit} onKeyDown={(event) => { if (event.key === "Escape" && !submitting) { if (state.loggingIn) void model.cancelLogin(); else close(); } }}>
      <h2>{t(accountId ? "cloud.reauthorize" : "cloud.add")}</h2>
      <div className="cloud-login-methods" role="group" aria-label={t("cloud.loginMethod")}><Button variant={method === "scan" ? "default" : "outline"} aria-pressed={method === "scan"} disabled={submitting || state.loggingIn} onClick={() => { setMethod("scan"); setCookie(""); setLocalError(null); }}><QrCode size={16} />{t("cloud.scanMethod")}</Button><Button variant={method === "cookie" ? "default" : "outline"} disabled={submitting || state.loggingIn} aria-pressed={method === "cookie"} onClick={() => { setMethod("cookie"); setLocalError(null); }}>{t("cloud.cookieMethod")}</Button></div>
      <label>{t("cloud.accountName")}<input ref={nameRef} value={name} maxLength={100} disabled={submitting || state.loggingIn} onChange={(event) => setName(event.target.value)} /></label>
      {method === "cookie" ? <><label>{t("cloud.cookie")}<input type="password" autoComplete="off" spellCheck={false} value={cookie} maxLength={32768} onChange={(event) => setCookie(event.target.value)} /></label><p className="cloud-hint">{t("cloud.cookieHelp")}</p></> : <p className="cloud-hint">{t("cloud.scanHelp")}</p>}
      {state.loggingIn && <p className="notice" role="status">{t("cloud.scanWaiting")}</p>}
      <p className="cloud-hint">{t("cloud.privacy")}</p><ErrorNotice message={localError} />
      <div className="form-actions"><Button variant="ghost" disabled={submitting} onClick={() => { if (state.loggingIn) void model.cancelLogin(); else close(); }}>{state.loggingIn ? t("cloud.cancelScan") : t("cancel")}</Button><Button type="submit" disabled={submitting || state.authorizing || state.loggingIn}>{t(method === "scan" ? "cloud.scanSubmit" : "cloud.submit")}</Button></div>
    </form>}
    {!state.loadingAccounts && !state.accounts.length && !editing && <section className="panel"><Empty icon={<Cloud size={28} />} title={t("cloud.emptyTitle")} description="连接账号后，在来源页选择需要下载的远端范围。" /></section>}
    <div className="source-list">{state.accounts.map((account) => <article className="panel cloud-account" key={account.id} aria-label={`账号 ${account.name}`}>
      <div className="cloud-browser-toolbar"><h2>{account.name}</h2><span className="badge">{t(`cloud.${statusKey[account.status]}`)}</span></div>
      {account.status === "RESELECT_REQUIRED" && <p className="cloud-hint">账号已恢复，部分来源的远端范围需在来源配置中重新选择并预览。</p>}
      <div className="cloud-account-actions"><Button variant="outline" size="sm" disabled={editing || state.authorizing || state.loggingIn || submitting} onClick={() => edit(account)}>{t("cloud.reauthorize")}</Button>{account.status !== "DISCONNECTED" && <Button variant="ghost" size="sm" disabled={state.authorizing || state.loggingIn} onClick={() => setDisconnectId(account.id)}>{t("cloud.disconnect")}</Button>}<Link className="source-inline-link" to="/sources">配置来源</Link></div>
      {disconnectId === account.id && <div className="cloud-disconnect"><p>{t("cloud.disconnectHelp")}</p><Button variant="ghost" size="sm" onClick={() => setDisconnectId(null)}>{t("cancel")}</Button><Button size="sm" onClick={() => { setDisconnectId(null); void model.disconnect(account.id); }}>{t("cloud.confirmDisconnect")}</Button></div>}
    </article>)}</div>
    <Button variant="ghost" size="sm" onClick={() => { void model.restore(); }}><RefreshCw size={14} />{t("cloud.restore")}</Button>
  </>;
}
