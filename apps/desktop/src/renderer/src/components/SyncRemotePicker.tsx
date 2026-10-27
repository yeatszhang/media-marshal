import { useEffect, useId, useRef, useState } from "react";
import { useService } from "@yeatz/app-framework/react";
import type { CloudAccount, RemoteEntry, RemotePage } from "@media-marshal/contracts";
import { DesktopClient } from "../desktop-client";
import { Button } from "./ui/button";
import { ErrorNotice } from "./shared";
export function SyncRemotePicker({ account, onClose, onSelect }: { account: CloudAccount; onClose(): void; onSelect(entry: RemoteEntry): void }) {
  const client = useService(DesktopClient), dialog = useRef<HTMLDialogElement>(null), generation = useRef(0), title = useId();
  const [trail, setTrail] = useState([{ ref: account.rootRef!, name: "网盘根目录" }]), [page, setPage] = useState<RemotePage>({ items: [], nextCursor: null, complete: false, total: null }), [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const current = trail.at(-1)!;
  useEffect(() => { const element = dialog.current!, original = document.activeElement; element.showModal(); return () => { generation.current++; element.close(); requestAnimationFrame(() => { if (original instanceof HTMLElement && original.isConnected) original.focus(); }); }; }, []);
  const load = async (cursor: string | null = null) => { const token = ++generation.current; setBusy(true); setError(null); try { const result = await client.listRemote({ accountId: account.id, parentRef: current.ref, cursor, pageSize: 50, refresh: !cursor }); if (token === generation.current) setPage((old) => ({ ...result, items: cursor ? [...new Map([...old.items, ...result.items].map((entry) => [entry.ref, entry])).values()] : result.items })); } catch (error) { if (token === generation.current) setError(error instanceof Error ? error.message : "无法读取网盘范围，请检查连接后重试"); } finally { if (token === generation.current) setBusy(false); } };
  useEffect(() => { setPage({ items: [], nextCursor: null, total: null, complete: false }); void load(); return () => { generation.current++; }; }, [current.ref, account.id, account.rootRef]);
  const select = async (ref: string) => { const token = ++generation.current; setBusy(true); setError(null); try { const entry = await client.statRemote(account.id, ref); if (token === generation.current) onSelect(entry); } catch (error) { if (token === generation.current) setError(error instanceof Error ? error.message : "范围已失效，请重新连接并选择"); } finally { if (token === generation.current) setBusy(false); } };
  return <dialog ref={dialog} className="source-lifecycle-dialog sync-remote-dialog" aria-labelledby={title} onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <h2 id={title}>选择远端文件或目录</h2><Button variant="ghost" onClick={onClose}>取消选择远端范围</Button>
    <nav aria-label="远端目录层级">{trail.map((entry, index) => <Button variant="ghost" key={entry.ref} disabled={busy} onClick={() => setTrail(trail.slice(0, index + 1))}>{entry.name}</Button>)}</nav>
    <ErrorNotice message={error} retry={() => { void load(); }} /><p role="status">已显示 {page.items.length} 项 · {page.total === null ? "总数未知" : `共 ${page.total} 项`}{busy && " · 正在核对"}</p>
    <Button variant="outline" disabled={busy} onClick={() => { void select(current.ref); }}>选择当前目录</Button>
    <div className="sync-remote-list">{page.items.map((entry) => <div key={entry.ref}><span title={entry.name}>{entry.type === "directory" ? "目录" : "文件"} · {entry.name}</span><div>{entry.type === "directory" && <Button size="sm" variant="ghost" disabled={busy} onClick={() => setTrail([...trail, { ref: entry.ref, name: entry.name }])} aria-label={`打开目录 ${entry.name}`}>打开</Button>}<Button size="sm" variant="outline" disabled={busy} aria-label={`选择范围 ${entry.name}`} onClick={() => { void select(entry.ref); }}>选择</Button></div></div>)}</div>
    {!page.complete && <p className="cloud-hint">清单尚未完整；不把未返回条目视为删除。</p>}{page.nextCursor && <Button disabled={busy} variant="outline" onClick={() => { void load(page.nextCursor); }}>加载更多</Button>}
  </dialog>;
}
