import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Cloud, Folder, FolderOutput } from "lucide-react";
import { useSourceRules } from "../source-draft-context";
import { sourceClients, sourceSize } from "../source-format";
import { ErrorNotice } from "./shared";
import { Button } from "./ui/button";

function SourceStep({ number, title, description, children }: { number: number; title: string; description: string; children: ReactNode }) {
  const id = useId();
  return <section className="source-step" aria-labelledby={id}>
    <header className="source-step-heading"><span className="source-step-number" aria-hidden="true">{number}</span><div><h3 id={id}>{title}</h3><p>{description}</p></div></header>
    <div className="source-step-content">{children}</div>
  </section>;
}

function DownloadFilters({ configured, children }: { configured: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(configured);
  return <details className="source-filter-group" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary><strong>筛选下载内容 <span>可选</span></strong><small>{configured ? "已设置筛选，仅下载符合条件的文件" : "默认下载全部文件；需要限定格式或文件名时展开"}</small></summary>
    <div className="source-filter-content"><p className="source-field-help">留空表示不过滤。两项都填写时，文件需要同时满足两个条件。</p>{children}</div>
  </details>;
}

function SourceOptionTitle({ title, status }: { title: string; status: string }) {
  return <span className="source-option-heading"><strong>{title}</strong><span className="source-option-status" aria-hidden="true">{status}</span></span>;
}

export function SourceEditorForm({ onClose }: { onClose(): void }) {
  const { model, state } = useSourceRules(), nameRef = useRef<HTMLInputElement>(null), editor = state.editor, busy = !!state.pending, preview = state.preview;
  const [automaticAccepted, setAutomaticAccepted] = useState(false);
  useEffect(() => { setAutomaticAccepted(false); }, [preview?.id, preview?.configuration.organization?.automatic]);
  useEffect(() => { if (editor?.id) nameRef.current?.focus(); }, [editor?.id]);
  if (!editor) return null;
  const account = state.accounts.find((value) => value.id === editor.accountId), root = state.roots.find((value) => value.id === editor.downloadRootId);
  const organization = <>
    <div className="folder-field"><span>整理目标媒体目录</span><div><FolderOutput size={17} aria-hidden="true" /><span className="path" title={editor.targetPath}>{editor.targetPath || "尚未选择整理目标"}</span><Button variant="outline" size="sm" onClick={() => { void model.choose("target"); }}>选择整理目标目录</Button></div></div>
    <label>媒体类型<select aria-label="媒体类型" value={editor.mediaType} onChange={(event) => model.change({ mediaType: event.target.value as typeof editor.mediaType })}><option value="AUTO">自动识别电影／剧集</option><option value="MOVIE">电影</option><option value="TV_SHOW">剧集</option></select><small className="source-field-help">电影和剧集可分别选择对应来源与目标；混合内容选择自动识别。</small></label>
    <div className={`source-option${editor.automatic ? " is-enabled" : ""}`}><label className="source-option-label"><input type="checkbox" aria-label="自动整理满足条件的新文件" checked={editor.automatic} disabled={!editor.version} onChange={(event) => model.change({ automatic: event.target.checked })} /><span><SourceOptionTitle title="自动整理满足条件的新文件" status={editor.automatic ? "满足条件自动整理" : "逐项确认"} /><small>默认由你逐项确认。开启后，只有下载完整、作品和季集都能明确识别的新文件才自动复制；有疑问的文件仍等你核对。</small></span></label>
      {!editor.automatic && <p className="source-option-prerequisite">首次使用：先确认来源，在「待处理」核对一份整理预览，再回来开启自动整理。</p>}
      {editor.automatic && <div className="source-option-content"><p className="source-field-help">{editor.type === "local" ? "当前本地客户端行为尚未完整验证，本地来源仍需逐项确认。" : "无法确定下载完整或识别结果时，文件留在「待处理」并显示原因。"}修改这个选项后，需重新预览并确认配置；已经确认的整理会继续执行。</p></div>}
    </div>
    <div className="source-explanation"><strong>开启整理后，还需要哪些配置？</strong><dl><div><dt>TMDB · 必需</dt><dd>在 <Link className="source-inline-link" to="/settings">设置</Link> 配置密钥，用于识别作品和季集。</dd></div><div><dt>媒体库目录 · 必需</dt><dd>整理后的文件复制到上方目标，下载原文件保留。两个目录需要分开。</dd></div><div><dt>Emby · 可选</dt><dd>连接已有服务器后，复制完成会通知 Emby 更新，并检查是否收录；只整理文件无需连接。</dd></div></dl></div>
  </>;
  return <form className="panel source-form source-rule-editor" aria-label="来源配置草稿" onSubmit={(event) => { event.preventDefault(); void model.save(); }} onKeyDown={(event) => { if (event.key === "Escape" && !busy) { event.preventDefault(); if (state.picker) model.closePicker(); else onClose(); } }}>
    <div className="cloud-browser-toolbar"><h2>{editor.draftRevision ? "编辑来源" : "添加来源"}</h2><span className="badge">{editor.version ? `生效版本 v${editor.version}` : "尚未确认"}</span></div>
    <p className="source-editor-intro">{editor.type === "cloud" ? "先确定文件从哪里来、保存到哪里，再分别设置下载时间和下载后的处理方式。" : "从已有本地文件中识别作品，确认后复制到你的媒体库。"}</p>
    <ol className="source-flow" aria-label="文件处理流程">
      <li><span>{editor.type === "cloud" ? <Cloud size={16} aria-hidden="true" /> : <Folder size={16} aria-hidden="true" />}{editor.type === "cloud" ? "网盘内容" : "本地已有文件"}</span><strong title={editor.type === "cloud" ? editor.remoteName : editor.sourcePath}>{editor.type === "cloud" ? editor.remoteName || "选择文件或目录" : editor.sourcePath || "选择本地输入目录"}</strong></li>
      {editor.type === "cloud" && <li><span><Folder size={16} aria-hidden="true" />下载到本地</span><strong title={root?.path}>{root?.path || "选择下载目录"}</strong></li>}
      <li className={editor.type === "cloud" && !editor.organize ? "is-muted" : undefined}><span><FolderOutput size={16} aria-hidden="true" />{editor.type === "cloud" ? "可选：整理到媒体库" : "整理到媒体库"}</span><strong title={editor.type === "cloud" && !editor.organize ? undefined : editor.targetPath}>{editor.type === "cloud" && !editor.organize ? "未开启，仅保存下载文件" : editor.targetPath || "选择整理目标"}</strong></li>
    </ol>
    {editor.archived && <p className="notice" role="status">来源已删除，以下配置仅供查看；请先从「已删除来源」恢复后再编辑。</p>}
    <fieldset disabled={busy || state.picker || editor.archived} className="source-rule-fields">
      <div className="form-grid source-basics"><label>来源名称<input aria-label="来源名称" ref={nameRef} value={editor.name} maxLength={100} onChange={(event) => model.change({ name: event.target.value })} placeholder="例如：追剧下载、电影整理" /></label><label>来源类型<select aria-label="来源类型" value={editor.type} disabled={editor.draftRevision > 0} onChange={(event) => model.change({ type: event.target.value as "cloud" | "local" })}><option value="cloud">网盘来源</option><option value="local">本地目录来源</option></select></label></div>
      {editor.type === "cloud" ? <>
        <SourceStep number={1} title="从哪里下载" description="选择网盘账号，再选择要下载的文件或目录。">
          <div className="source-account-row"><label>网盘账号<select aria-label="网盘账号" value={editor.accountId} onChange={(event) => model.changeAccount(event.target.value)}><option value="">选择已连接账号</option>{state.accounts.map((value) => <option key={value.id} value={value.id}>{value.name}{value.status === "READY" ? "" : value.status === "RESELECT_REQUIRED" ? "（需重选范围）" : "（需检查连接）"}</option>)}</select></label><Link className="source-inline-link" to="/cloud?returnTo=sources">{account && account.status !== "READY" ? "检查或重新连接账号" : "连接／管理账号"}</Link></div>
          {!state.accounts.length && <p className="notice">还没有云端账号，请先连接夸克账号。当前来源草稿会保留。</p>}
          <div className="folder-field"><span>远端文件或目录</span><div><Cloud size={17} aria-hidden="true" /><span className="path" title={editor.remoteName}>{editor.remoteName || "尚未选择远端范围"}</span><Button data-source-remote="true" variant="outline" size="sm" disabled={!account?.rootRef || !["READY", "RESELECT_REQUIRED"].includes(account.status)} onClick={() => { void model.openPicker(); }}>选择远端范围</Button></div></div>
          <DownloadFilters key={editor.id} configured={!!(editor.extensions.trim() || editor.names.trim())}><div className="form-grid"><label>扩展名过滤<input aria-label="扩展名过滤" value={editor.extensions} onChange={(event) => model.change({ extensions: event.target.value })} placeholder="例如：mp4, mkv" /><small className="source-field-help">只下载这些格式，用逗号分隔。</small></label><label>精确文件名过滤<textarea aria-label="精确文件名过滤" rows={2} value={editor.names} onChange={(event) => model.change({ names: event.target.value })} placeholder={"例如：01.mp4\n02.mp4"} /><small className="source-field-help">每行一个完整文件名，包含扩展名。</small></label></div></DownloadFilters>
        </SourceStep>
        <SourceStep number={2} title="下载保存到哪里" description="网盘文件先保存到这里。开启整理后，会再复制一份到媒体库。">
          <div className="source-directory-picker"><label>本地下载目录<select aria-label="本地下载目录" value={editor.downloadRootId} onChange={(event) => model.change({ downloadRootId: event.target.value })}><option value="">选择已授权下载目录</option>{state.roots.map((value) => <option key={value.id} value={value.id}>{value.path}{value.state === "AVAILABLE" ? "" : "（原磁盘不可用）"}</option>)}</select></label><Button variant="outline" onClick={() => { void model.choose("download"); }}><Folder size={15} aria-hidden="true" />选择下载目录</Button></div>
          {root && <p className="source-location-status">{root.state === "AVAILABLE" ? `原目录可用 · 可用空间 ${sourceSize(root.availableBytes)}` : "原磁盘或目录尚未恢复，请核对原卷授权。"}</p>}
        </SourceStep>
        <SourceStep number={3} title="什么时候下载" description="定期检查只控制下载时间，与下方是否整理相互独立。">
          <div className={`source-option${editor.periodic ? " is-enabled" : ""}`}><label className="source-option-label"><input aria-label="定期检查网盘目录" type="checkbox" checked={editor.periodic} disabled={editor.remoteType === "file"} onChange={(event) => model.change({ periodic: event.target.checked })} /><span><SourceOptionTitle title="定期检查网盘目录" status={editor.periodic ? "定期检查" : "手动执行"} /><small>{editor.remoteType === "file" ? "当前选择的是单个文件，只能执行一次；周期扫描仅适用于目录。" : editor.periodic ? "配置确认后，按下方间隔检查网盘目录，下载符合筛选条件的新增或变化文件。" : "当前仅手动执行。确认配置时可以执行一次，也可稍后从来源列表执行。"}</small></span></label>
            {editor.periodic && <div className="source-option-content"><label>扫描间隔<select aria-label="扫描间隔" value={editor.intervalSeconds} onChange={(event) => model.change({ intervalSeconds: Number(event.target.value) })}>{[...new Set([60, 300, 900, 3600, 86400, editor.intervalSeconds])].sort((a, b) => a - b).map((seconds) => <option value={seconds} key={seconds}>{seconds < 3600 ? `${seconds / 60} 分钟` : `${seconds / 3600} 小时`}</option>)}</select></label><p className="source-field-help">应用运行时才扫描；退出期间漏过的周期在重启后合并补扫。网盘文件被删除，不会删除已下载文件。</p></div>}
          </div>
          <details className="source-behavior-note"><summary>哪些文件变化可能无法发现？</summary><p>夸克按路径、大小等信息比较文件。同尺寸内容替换可能无法识别，需要时可在来源列表选择「强制重新下载」。</p></details>
        </SourceStep>
        <SourceStep number={4} title="下载后做什么" description="默认只下载。开启整理后，再识别作品并复制到媒体库。">
          <div className={`source-option${editor.organize ? " is-enabled" : ""}`}><label className="source-option-label"><input aria-label="下载后整理到媒体库" type="checkbox" checked={editor.organize} onChange={(event) => model.change({ organize: event.target.checked })} /><span><SourceOptionTitle title="下载后整理到媒体库" status={editor.organize ? "下载并整理" : "只下载"} /><small>{!editor.organize ? "开启后，下载完成的文件才会进入识别与整理；可选择逐项确认，或在满足条件时自动整理。" : editor.automatic ? "完成文件先识别，满足自动条件后复制；证据不足的文件仍进入待处理。下载原文件保留。" : "下载完成的文件进入「待处理」。核对作品、季集和目标路径并确认后，才复制到媒体库；下载的原文件保留。"}</small></span></label>
            {editor.organize && <div className="source-option-content">{organization}</div>}
          </div>
          {!editor.organize && <p className="source-only-download">当前只下载到本地，无需 TMDB、媒体目标或 Emby 配置。</p>}
        </SourceStep>
      </> : <>
        <SourceStep number={1} title="选择本地输入目录" description="这里存放已经下载的文件；本地来源不需要登录网盘账号。">
          <div className="folder-field"><span>本地输入目录</span><div><Folder size={17} aria-hidden="true" /><span className="path" title={editor.sourcePath}>{editor.sourcePath || "尚未选择本地输入目录"}</span><Button variant="outline" size="sm" onClick={() => { void model.choose("source"); }}>选择本地输入目录</Button></div></div>
          <label>外部下载客户端<select aria-label="外部下载客户端" value={editor.client} onChange={(event) => model.change({ client: event.target.value as typeof editor.client })}>{Object.entries(sourceClients).filter(([key]) => key === "quark" || key === "custom" || (editor.draftRevision > 0 && key === editor.client)).map(([key, label]) => <option key={key} value={key}>{label}{key === "quark" || key === "custom" ? "" : "（历史标签）"}</option>)}</select><small className="source-field-help">仅描述文件来自哪个客户端，和网盘账号连接相互独立。</small></label>
          {editor.client === "quark" && <p className="source-field-help">请先用夸克官方客户端把文件下载到所选输入目录。这里只读取本地文件，接入后在待处理核对作品并确认整理。</p>}
          {editor.client !== "quark" && editor.client !== "custom" && <p className="notice">此历史客户端行为未验证，按普通本地目录接入并保留原标签；不会转换为夸克账号，整理仍需人工确认。</p>}
        </SourceStep>
        <SourceStep number={2} title="选择整理目标" description="确认后把识别的影片复制到这里，输入目录中的文件继续保留。">{organization}</SourceStep>
        <SourceStep number={3} title="设置本地忽略规则" description="决定哪些文件或子目录不进入识别和整理。">
          <label>本地忽略规则<select aria-label="本地忽略规则" value={editor.ignoreMode} onChange={(event) => model.change({ ignoreMode: event.target.value as typeof editor.ignoreMode })}><option value="default">使用默认规则</option><option value="none">关闭可配置忽略</option><option value="custom">自定义规则</option></select></label>
          {editor.ignoreMode === "custom" && <label>忽略文件名或目录（每行一条）<textarea aria-label="忽略文件名或目录" rows={3} value={editor.ignoredFilePatterns} onChange={(event) => model.change({ ignoredFilePatterns: event.target.value })} placeholder={"*.tmp\ncache/"} /></label>}
          <p className="source-field-help">默认忽略隐藏项、常见临时文件、系统索引和 sample／samples 目录。自定义规则替换默认规则，文件名支持通配符，目录名以 / 结尾；关闭忽略也不会跳过文件就绪检查或接入应用私有暂存区。</p>
        </SourceStep>
      </>}
      {editor.type === "cloud" && <aside className="source-behavior-summary" aria-label="当前配置的执行方式" aria-live="polite">
        <strong>当前配置会怎样运行</strong>
        <dl><div><dt>何时下载</dt><dd>{editor.periodic ? `确认启用后立即扫描，之后每 ${editor.intervalSeconds < 3600 ? `${editor.intervalSeconds / 60} 分钟` : `${editor.intervalSeconds / 3600} 小时`} 检查一次；应用需保持运行。` : "手动执行：预览并确认后可执行一次，之后由你从来源列表再次执行。"}</dd></div>
          <div><dt>下载完成后</dt><dd>{editor.organize ? editor.automatic ? "作品和季集识别明确、确认下载完整的新文件自动复制到媒体库，其余文件进入「待处理」等你确认。" : "进入「待处理」识别作品；你确认整理预览后，才复制到媒体库。连接 Emby 后再核对收录。" : "仅保存到本地下载目录。开启「下载后整理到媒体库」，才会接入识别与整理。"}</dd></div><div><dt>需要的配置</dt><dd>{editor.organize ? "媒体库目录和 TMDB 密钥；Emby 可选，不影响复制文件。" : "已连接的网盘账号和本地下载目录即可。"}</dd></div></dl>
      </aside>}
      <div className="source-editor-footer"><p>先预览，再确认生效。「保存草稿」只保留填写内容；「预览配置」查看将下载的文件及冲突，确认后才执行。</p><div className="form-actions"><Button variant="ghost" onClick={onClose}>取消编辑</Button><Button type="submit" variant="outline">保存草稿</Button><Button onClick={() => { void model.preview(); }}>{preview && preview.state !== "APPLIED" ? "重新预览" : "预览配置"}</Button></div></div>
    </fieldset>
    {editor.archived && <div className="form-actions"><Button variant="outline" onClick={onClose}>关闭配置查看</Button></div>}
    {state.pending && <p role="status">{state.pending === "native" ? "等待系统目录选择…" : state.pending === "apply" ? "正在确认配置…" : state.pending === "save" ? "正在保存草稿…" : "正在建立范围预览…"}</p>}
    {preview && <section className="cloud-preview" aria-label="来源配置预览">
      <h3>配置预览</h3>
      {preview.state === "BUILDING" && <p role="status">正在完整枚举范围，当前计数尚未确定。</p>}
      {preview.download && <><p>{preview.download.complete ? "完整范围" : "范围尚未完整"}：{preview.download.files} 项 · {sourceSize(preview.download.bytes)}</p><p>可复用 {preview.download.reuseFiles} 项 · 目标冲突 {preview.download.conflicts} 项</p>{!!preview.download.localRemovedFiles && <p className="notice" role="status">{preview.download.localRemovedFiles} 项已同步，本地已移除；普通同步会跳过同一源版本。需要重新获取时，在来源中预览并确认强制重新下载。</p>}<p className="cloud-root-path">完成目录：{state.roots.find((value) => value.id === preview.download!.targetGrantId)?.path}/{preview.download.destinationPrefix}/{preview.download.selectionPath}</p>{preview.download.weakComparison && <p className="cloud-hint">夸克使用弱版本比较，同尺寸内容替换可能无法识别；本地摘要不等于远端端到端摘要。</p>}{preview.download.failure && <ErrorNotice message={preview.download.failure.message} />}</>}
      {preview.configuration.type === "local" && <p className="cloud-root-path">{preview.configuration.sourcePath} → {preview.configuration.organization.targetPath} · COPY · {preview.configuration.organization.automatic ? "已选择自动策略，证据不足仍须人工确认" : "人工确认"}</p>}
      {preview.configuration.type === "local" && <p>忽略规则：{preview.configuration.ignoredFilePatterns == null ? "系统默认" : preview.configuration.ignoredFilePatterns.length ? preview.configuration.ignoredFilePatterns.join("、") : "已关闭可配置忽略"}</p>}
      {preview.automaticBlockedReason && <p role="alert" className="notice">{preview.automaticBlockedReason}</p>}
      {preview.configuration.organization?.automatic && preview.automaticSample && <div className="source-option"><div className="source-option-content"><strong>首次整理预览：{preview.automaticSample.title}</strong><p className="path">{preview.automaticSample.sourcePath} → {preview.automaticSample.targetPath} · {sourceSize(preview.automaticSample.size)}</p><p className="source-field-help">文件大小不再变化，也可能尚未下载完整。自动整理只处理确认下载完整且识别明确的新文件；其他项仍需你核对，原文件继续保留。</p></div>{preview.state !== "APPLIED" && <label className="source-option-label"><input type="checkbox" aria-label="已核对首次预览并了解自动整理局限" checked={automaticAccepted} disabled={busy} onChange={(event) => setAutomaticAccepted(event.target.checked)} /><span>我已核对首次整理预览，并了解自动整理的条件与局限</span></label>}</div>}
      {!!preview.organizationConflicts.length && <div className="notice" role="alert">整理策略与已有来源冲突：{preview.organizationConflicts.map((value) => <Link key={value.sourceId} to={`/sources?source=${value.sourceId}`}>{value.name}</Link>)}。请调整范围、过滤或整理目标。</div>}
      {preview.state === "EXPIRED" && <p role="alert">预览已过期或配置已变化，请重新预览。</p>}
      {preview.state === "FAILED" && !preview.automaticBlockedReason && !preview.organizationConflicts.length && !preview.download?.failure && <p role="alert">范围不完整或存在冲突，请处理后重新预览。</p>}
      {preview.state === "APPLIED" ? <p role="status">该配置已生效，后续可在来源列表执行一次或控制扫描。</p> : <div className="form-actions"><Button disabled={busy || state.dirty || preview.state !== "READY" || !!preview.configuration.organization?.automatic && !automaticAccepted} onClick={() => { void model.confirm(false, automaticAccepted); }}>{preview.configuration.type === "cloud" && preview.configuration.periodic.enabled ? "确认启用并扫描" : "确认配置生效"}</Button>{preview.configuration.type === "cloud" && !preview.configuration.periodic.enabled && <Button variant="outline" disabled={busy || state.dirty || preview.state !== "READY" || !!preview.configuration.organization?.automatic && !automaticAccepted} onClick={() => { void model.confirm(true, automaticAccepted); }}>确认并执行一次</Button>}</div>}
    </section>}
  </form>;
}
