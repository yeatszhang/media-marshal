import { useEffect, useRef } from "react";
import { ChevronRight, File, Folder } from "lucide-react";
import { useSourceRules } from "../source-draft-context";
import { sourceSize } from "../source-format";
import { ErrorNotice } from "./shared";
import { Button } from "./ui/button";

export function SourceRemotePicker() {
  const { model, state } = useSourceRules(), ref = useRef<HTMLElement>(null);
  useEffect(() => { ref.current?.querySelector<HTMLButtonElement>("button")?.focus(); return () => { requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('[data-source-remote="true"]')?.focus()); }; }, []);
  return <section className="panel cloud-browser source-remote-picker" aria-label="选择远端文件或目录" ref={ref} onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); model.closePicker(); } }}>
    <div className="cloud-browser-toolbar"><h2>选择远端文件或目录</h2><Button variant="ghost" onClick={() => model.closePicker()}>取消选择远端范围</Button></div>
    <nav className="cloud-breadcrumbs" aria-label="远端目录层级">{state.trail.map((value, index) => <span key={value.ref}><Button variant="ghost" size="sm" title={value.name} onClick={() => { void model.goTo(index); }}>{index === 0 ? "网盘根目录" : value.name}</Button>{index < state.trail.length - 1 && <ChevronRight size={12} />}</span>)}</nav>
    <ErrorNotice message={state.browserError} />
    <p className="cloud-page-count" role="status">已显示 {state.entries.length} 项 · {state.total === null ? "总数未知" : `共 ${state.total} 项`}{state.browsing ? " · 正在读取目录" : ""}</p>
    {!state.complete && !state.browsing && <p className="cloud-hint">当前结果不完整，请重试或继续加载；不会将未返回条目视为删除。</p>}
    <div className="download-controls"><Button variant="outline" disabled={state.browsing || !state.trail.length} onClick={() => { void model.selectRemote(state.trail.at(-1)!); }}>选择当前目录</Button><Button variant="ghost" disabled={state.browsing} onClick={() => { void model.browse(); }}>刷新远端目录</Button></div>
    <table className="cloud-files"><thead><tr><th>文件或目录</th><th>大小</th><th>操作</th></tr></thead><tbody>{state.entries.map((entry) => <tr key={entry.ref}><td><div className="cloud-file-name">{entry.type === "directory" ? <Folder size={16} /> : <File size={16} />}<span title={entry.name}>{entry.name}</span></div></td><td>{entry.type === "directory" ? "目录" : sourceSize(entry.size)}</td><td><div className="cloud-file-actions">{entry.type === "directory" && <Button size="sm" variant="ghost" aria-label={`打开目录 ${entry.name}`} disabled={state.browsing} onClick={() => { void model.enter(entry); }}>打开</Button>}<Button size="sm" variant="ghost" aria-label={`选择范围 ${entry.name}`} disabled={state.browsing} onClick={() => { void model.selectRemote(entry); }}>选择</Button></div></td></tr>)}</tbody></table>
    {!state.entries.length && state.complete && <p>此目录为空，可选择当前目录。</p>}
    {state.cursor && <Button variant="outline" disabled={state.browsing} onClick={() => { void model.browse(true); }}>加载更多</Button>}
  </section>;
}
