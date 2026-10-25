import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useService, useServiceState } from "@yeatz/app-framework/react";
import { Cloud, Folder } from "lucide-react";
import { SourceRulesViewModel } from "../source-rules-model";
import { sourceClients, sourceSize } from "../source-format";
import { ErrorNotice } from "./shared";
import { Button } from "./ui/button";

export function SourceEditorForm({ onClose }: { onClose(): void }) {
  const model = useService(SourceRulesViewModel), state = useServiceState(model, (value) => value), nameRef = useRef<HTMLInputElement>(null), editor = state.editor, busy = !!state.pending, preview = state.preview;
  useEffect(() => { if (editor?.id) nameRef.current?.focus(); }, [editor?.id]);
  if (!editor) return null;
  const account = state.accounts.find((value) => value.id === editor.accountId), root = state.roots.find((value) => value.id === editor.downloadRootId);
  return <form className="panel source-form source-rule-editor" aria-label="来源配置草稿" onSubmit={(event) => { event.preventDefault(); void model.save(); }} onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.preventDefault(); if (state.picker) model.closePicker(); else onClose(); } }}>
    <div className="cloud-browser-toolbar"><h2>{editor.draftRevision ? "编辑来源" : "添加来源"}</h2><span className="badge">{editor.version ? `生效版本 v${editor.version}` : "尚未确认"}</span></div>
    <fieldset disabled={busy || state.picker} className="source-rule-fields">
      <div className="form-grid"><label>来源名称<input ref={nameRef} value={editor.name} maxLength={100} onChange={(event) => model.change({ name: event.target.value })} /></label><label>来源类型<select aria-label="来源类型" value={editor.type} disabled={editor.draftRevision > 0} onChange={(event) => model.change({ type: event.target.value as "cloud" | "local" })}><option value="cloud">网盘来源</option><option value="local">本地目录来源</option></select></label></div>
      {editor.type === "cloud" ? <>
        <label>网盘账号<select aria-label="网盘账号" value={editor.accountId} onChange={(event) => model.changeAccount(event.target.value)}><option value="">选择已连接账号</option>{state.accounts.map((value) => <option key={value.id} value={value.id}>{value.name}{value.status === "READY" ? "" : value.status === "RESELECT_REQUIRED" ? "（需重选范围）" : "（需检查连接）"}</option>)}</select></label>
        {!state.accounts.length && <p className="notice">还没有云端账号，请先连接夸克账号。当前来源草稿会保留。</p>}
        <Link className="source-inline-link" to="/cloud?returnTo=sources">{account && account.status !== "READY" ? "检查或重新连接账号" : "连接／管理账号"}</Link>
        <div className="folder-field"><span>远端文件或目录</span><div><Cloud size={17} /><span className="path" title={editor.remoteName}>{editor.remoteName || "尚未选择远端范围"}</span><Button data-source-remote="true" variant="outline" size="sm" disabled={!account?.rootRef || !["READY", "RESELECT_REQUIRED"].includes(account.status)} onClick={() => { void model.openPicker(); }}>选择远端范围</Button></div></div>
        {editor.remoteType === "file" && <p className="cloud-hint">当前选择单个文件，可以执行一次，不能启用目录周期扫描。</p>}
        <label>本地下载目录<select aria-label="本地下载目录" value={editor.downloadRootId} onChange={(event) => model.change({ downloadRootId: event.target.value })}><option value="">选择已授权下载目录</option>{state.roots.map((value) => <option key={value.id} value={value.id}>{value.path}{value.state === "AVAILABLE" ? "" : "（原磁盘不可用）"}</option>)}</select></label>
        <Button variant="outline" onClick={() => { void model.choose("download"); }}><Folder size={15} />选择下载目录</Button>
        {root && <p className="cloud-hint">{root.state === "AVAILABLE" ? `原目录可用 · 可用空间 ${sourceSize(root.availableBytes)}` : "原磁盘或目录尚未恢复，请核对原卷授权。"}</p>}
        <div className="form-grid"><label>扩展名过滤（逗号分隔，留空为全部）<input aria-label="扩展名过滤" value={editor.extensions} onChange={(event) => model.change({ extensions: event.target.value })} placeholder="mp4,mkv" /></label><label>精确文件名过滤（每行一个，留空为全部）<textarea aria-label="精确文件名过滤" rows={2} value={editor.names} onChange={(event) => model.change({ names: event.target.value })} /></label></div>
        <label className="cloud-checkbox"><input type="checkbox" checked={editor.periodic} disabled={editor.remoteType === "file"} onChange={(event) => model.change({ periodic: event.target.checked })} />定期扫描目录</label>
        {editor.periodic && <label>扫描间隔<select aria-label="扫描间隔" value={editor.intervalSeconds} onChange={(event) => model.change({ intervalSeconds: Number(event.target.value) })}>{[...new Set([60, 300, 900, 3600, 86400, editor.intervalSeconds])].sort((a, b) => a - b).map((seconds) => <option value={seconds} key={seconds}>{seconds < 3600 ? `${seconds / 60} 分钟` : `${seconds / 3600} 小时`}</option>)}</select></label>}
        <p className="cloud-hint">执行一次不会开启周期扫描。周期扫描仅在应用运行时执行，退出期间的漏过周期在重启后合并补扫；源端删除不会删除本地成果。</p>
        <p className="cloud-hint">当前夸克采用路径身份和弱版本比较，同尺寸内容替换可能无法识别。</p>
        <label className="cloud-checkbox"><input type="checkbox" checked={editor.organize} onChange={(event) => model.change({ organize: event.target.checked })} />下载后接入整理</label>
        {!editor.organize && <p className="cloud-hint">仅下载到本地，无需 TMDB、媒体目标或 Emby 配置。</p>}
      </> : <>
        <label>外部下载客户端<select aria-label="外部下载客户端" value={editor.client} onChange={(event) => model.change({ client: event.target.value as typeof editor.client })}>{Object.entries(sourceClients).filter(([key]) => key === "quark" || key === "custom" || (editor.draftRevision > 0 && key === editor.client)).map(([key, label]) => <option key={key} value={key}>{label}{key === "quark" || key === "custom" ? "" : "（历史标签）"}</option>)}</select></label>
        <div className="folder-field"><span>本地输入目录</span><div><Folder size={17} /><span className="path" title={editor.sourcePath}>{editor.sourcePath || "尚未选择本地输入目录"}</span><Button variant="outline" size="sm" onClick={() => { void model.choose("source"); }}>选择本地输入目录</Button></div></div>
        <p className="cloud-hint">客户端标签只描述本地目录来源，不代表网盘账号授权。</p>
        <label>本地忽略规则<select aria-label="本地忽略规则" value={editor.ignoreMode} onChange={(event) => model.change({ ignoreMode: event.target.value as typeof editor.ignoreMode })}><option value="default">使用默认规则</option><option value="none">关闭可配置忽略</option><option value="custom">自定义规则</option></select></label>
        {editor.ignoreMode === "custom" && <label>忽略文件名或目录（每行一条）<textarea aria-label="忽略文件名或目录" rows={3} value={editor.ignoredFilePatterns} onChange={(event) => model.change({ ignoredFilePatterns: event.target.value })} placeholder={"*.tmp\ncache/"} /></label>}
        <p className="cloud-hint">默认忽略隐藏项、常见临时文件、系统索引和 sample／samples 目录。自定义规则替换默认规则，文件名支持通配符，目录名以 / 结尾；关闭忽略也不会跳过文件就绪检查或接入应用私有暂存区。</p>
        {editor.client !== "quark" && editor.client !== "custom" && <p className="notice">此历史客户端行为未验证，按普通本地目录接入并保留原标签；不会转换为夸克账号，整理仍需人工确认。</p>}
      </>}
      {(editor.type === "local" || editor.organize) && <>
        <div className="folder-field"><span>整理目标媒体目录</span><div><Folder size={17} /><span className="path" title={editor.targetPath}>{editor.targetPath || "尚未选择整理目标"}</span><Button variant="outline" size="sm" onClick={() => { void model.choose("target"); }}>选择整理目标目录</Button></div></div>
        <label>媒体类型<select aria-label="媒体类型" value={editor.mediaType} onChange={(event) => model.change({ mediaType: event.target.value as typeof editor.mediaType })}><option value="AUTO">自动识别电影／剧集</option><option value="MOVIE">电影</option><option value="TV_SHOW">剧集</option></select></label>
        <p className="notice">保留来源文件，仅 COPY。文件稳定观察后仍需识别与人工确认；下载范围的确认不会直接复制媒体或标为 Emby 已收录。</p>
      </>}
      <p className="cloud-hint">保存草稿不启动任务；影响范围的变更须重新预览并确认，生效前继续使用原配置。</p>
      <div className="form-actions"><Button variant="ghost" onClick={onClose}>取消编辑</Button><Button type="submit" variant="outline">保存草稿</Button><Button onClick={() => { void model.preview(); }}>{preview && preview.state !== "APPLIED" ? "重新预览" : "预览配置"}</Button></div>
    </fieldset>
    {state.pending && <p role="status">{state.pending === "native" ? "等待系统目录选择…" : state.pending === "apply" ? "正在确认配置…" : state.pending === "save" ? "正在保存草稿…" : "正在建立范围预览…"}</p>}
    {preview && <section className="cloud-preview" aria-label="来源配置预览">
      <h3>配置预览</h3>
      {preview.state === "BUILDING" && <p role="status">正在完整枚举范围，当前计数尚未确定。</p>}
      {preview.download && <><p>{preview.download.complete ? "完整范围" : "范围尚未完整"}：{preview.download.files} 项 · {sourceSize(preview.download.bytes)}</p><p>可复用 {preview.download.reuseFiles} 项 · 目标冲突 {preview.download.conflicts} 项</p><p className="cloud-root-path">完成目录：{state.roots.find((value) => value.id === preview.download!.targetGrantId)?.path}/{preview.download.destinationPrefix}/{preview.download.selectionPath}</p>{preview.download.weakComparison && <p className="cloud-hint">夸克使用弱版本比较，同尺寸内容替换可能无法识别；本地摘要不等于远端端到端摘要。</p>}{preview.download.failure && <ErrorNotice message={preview.download.failure.message} />}</>}
      {preview.configuration.type === "local" && <p className="cloud-root-path">{preview.configuration.sourcePath} → {preview.configuration.organization.targetPath} · COPY · 人工确认</p>}
      {preview.configuration.type === "local" && <p>忽略规则：{preview.configuration.ignoredFilePatterns == null ? "系统默认" : preview.configuration.ignoredFilePatterns.length ? preview.configuration.ignoredFilePatterns.join("、") : "已关闭可配置忽略"}</p>}
      {!!preview.organizationConflicts.length && <div className="notice" role="alert">整理策略与已有来源冲突：{preview.organizationConflicts.map((value) => <Link key={value.sourceId} to={`/sources?source=${value.sourceId}`}>{value.name}</Link>)}。请调整范围、过滤或整理目标。</div>}
      {preview.state === "EXPIRED" && <p role="alert">预览已过期或配置已变化，请重新预览。</p>}
      {preview.state === "FAILED" && !preview.organizationConflicts.length && !preview.download?.failure && <p role="alert">范围不完整或存在冲突，请处理后重新预览。</p>}
      {preview.state === "APPLIED" ? <p role="status">该配置已生效，后续可在来源列表执行一次或控制扫描。</p> : <div className="form-actions"><Button disabled={busy || state.dirty || preview.state !== "READY"} onClick={() => { void model.confirm(false); }}>{preview.configuration.type === "cloud" && preview.configuration.periodic.enabled ? "确认启用并扫描" : "确认配置生效"}</Button>{preview.configuration.type === "cloud" && !preview.configuration.periodic.enabled && <Button variant="outline" disabled={busy || state.dirty || preview.state !== "READY"} onClick={() => { void model.confirm(true); }}>确认并执行一次</Button>}</div>}
    </section>}
  </form>;
}
