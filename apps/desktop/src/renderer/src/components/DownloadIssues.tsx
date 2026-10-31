import { useCallback, useEffect, useRef, useState } from "react";
import { useService } from "@yeatz/app-framework/react";
import { useTranslation } from "react-i18next";
import type { DownloadItemIssue } from "@media-marshal/contracts";
import { DesktopClient } from "../desktop-client";
import { Button } from "./ui/button";
import { ErrorNotice } from "./shared";

const errorMessage = (error: unknown) => error instanceof Error ? error.message : "无法读取下载异常，请刷新后重试";

export function DownloadIssues({ jobId, count, transmitting, onResolved }: { jobId: string; count: number; transmitting: boolean; onResolved: () => Promise<void> }) {
  const client = useService(DesktopClient), { t } = useTranslation();
  const [open, setOpen] = useState(false), [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: DownloadItemIssue[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null), [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string[]>([]);
  const mounted = useRef(false), epoch = useRef(0), request = useRef(0), pending = useRef(new Set<string>());
  const load = useCallback(async () => {
    const serial = ++request.current;
    try {
      const result = await client.listDownloadIssues({ jobId, page, pageSize: 10 });
      if (!mounted.current || serial !== request.current) return;
      const last = Math.max(1, Math.ceil(result.total / 10));
      if (page > last) { setPage(last); return; }
      setData(result); setError(null);
      if (!result.total) await onResolved();
    } catch (cause) { if (mounted.current && serial === request.current) setError(errorMessage(cause)); }
  }, [client, jobId, page, onResolved]);
  useEffect(() => {
    mounted.current = true; let timer: ReturnType<typeof setTimeout> | undefined, active = true;
    const poll = async () => { await load(); if (active) timer = setTimeout(() => { void poll(); }, 2000); };
    if (open) void poll();
    return () => { active = false; mounted.current = false; ++epoch.current; ++request.current; clearTimeout(timer); };
  }, [load, open]);
  const reconcile = async (itemId: string) => {
    if (pending.current.has(itemId)) return;
    const generation = epoch.current;
    pending.current.add(itemId); setBusy([...pending.current]);
    setActionErrors((old) => { const next = { ...old }; delete next[itemId]; return next; });
    try { await client.reconcileDownload({ jobId, itemId }); if (mounted.current && generation === epoch.current) await load(); }
    catch (cause) { if (mounted.current && generation === epoch.current) setActionErrors((old) => ({ ...old, [itemId]: errorMessage(cause) })); }
    finally { pending.current.delete(itemId); if (mounted.current) setBusy([...pending.current]); }
  };
  return <details className="download-issues" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>{t(transmitting ? "cloud.issuesWhileTransmitting" : "cloud.issueCount", { count })}</summary>
    <p className="cloud-hint">{t("cloud.reconcileHelp")}</p>
    <ErrorNotice message={error} retry={() => { void load(); }} />
    {!data && !error && <p role="status">{t("cloud.loadingIssues")}</p>}
    <ul className="download-issue-list">{data?.items.map((item) => <li key={item.itemId} aria-label={item.relativePath}>
      <p className="download-issue-path">{item.relativePath}</p>
      <p className="cloud-hint">{t(`cloud.issueStage${item.stage}`)} · {t(`cloud.state${item.state}`)}</p>
      <p className="download-issue-reason">{item.failure.code === "CONFLICT" && item.stage === "COMMIT" ? t("cloud.unknownCommitConflict") : item.failure.message}</p>
      {item.checking ? <p role="status">{t("cloud.reconcilingFile")}</p> : <>
        {item.blockedReason && <p className="cloud-hint">{item.blockedReason}</p>}
        {item.stage === "COMMIT" && <Button variant="outline" size="sm" disabled={busy.includes(item.itemId) || !item.canReconcile} aria-label={`${t("cloud.reconcileFile")} ${item.relativePath}`} onClick={() => { void reconcile(item.itemId); }}>{busy.includes(item.itemId) ? t("cloud.submittingReconcile") : t("cloud.reconcileFile")}</Button>}
      </>}
      <ErrorNotice message={actionErrors[item.itemId] ?? null} />
    </li>)}</ul>
    {data && data.total > 10 && <div className="download-controls">
      <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => { setData(null); setPage(page - 1); }}>{t("cloud.previousIssues")}</Button>
      <span>{t("cloud.issuePage", { page, total: data.total })}</span>
      <Button variant="outline" size="sm" disabled={page * 10 >= data.total} onClick={() => { setData(null); setPage(page + 1); }}>{t("cloud.nextIssues")}</Button>
    </div>}
  </details>;
}
