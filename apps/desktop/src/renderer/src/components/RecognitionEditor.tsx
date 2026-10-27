import { useEffect, useRef, useState } from "react";
import { useService, useServiceState } from "@yeatz/app-framework/react";
import type { CoreInput, RecognitionFields } from "@media-marshal/contracts";
import { RecognitionEditsViewModel } from "../recognition-edits-model";
import { Button } from "./ui/button";
import { ErrorNotice } from "./shared";
const labels = { title: "解析标题", year: "年份", type: "媒体类型", season: "季号", episode: "起始集号", episodeEnd: "结束集号" };
type Field = keyof typeof labels;
function description(fields: RecognitionFields | null) { return fields ? `${fields.title ?? "未填写标题"} · ${fields.type === "MOVIE" ? "电影" : fields.type === "TV_SHOW" ? "剧集" : "未定类型"} · ${fields.year ?? "无年份"}${fields.type === "TV_SHOW" ? ` · S${fields.season ?? "?"} E${fields.episode ?? "?"}${fields.episodeEnd !== null ? `–${fields.episodeEnd}` : ""}` : ""}` : "无法读取"; }
export function RecognitionEditor({ taskIds, onClose, onSaved }: { taskIds: string[]; onClose(): void; onSaved(): void }) {
  const model = useService(RecognitionEditsViewModel), state = useServiceState(model, (value) => value), key = taskIds.join(","), initialized = useRef(""), heading = useRef<HTMLHeadingElement>(null);
  const [enabled, setEnabled] = useState<Partial<Record<Field, boolean>>>({}), [values, setValues] = useState<Record<Field, string>>({ title: "", year: "", type: "TV_SHOW", season: "1", episode: "1", episodeEnd: "" }), [sequence, setSequence] = useState(false), [start, setStart] = useState("1"), [direction, setDirection] = useState<"ASC" | "DESC">("ASC"), [error, setError] = useState<string | null>(null);
  useEffect(() => { void model.open(taskIds); heading.current?.focus(); return () => model.close(); }, [model, key]);
  useEffect(() => { if (!state.tasks.length || initialized.current === key) return; initialized.current = key; const parsed = state.tasks[0]!.parsed; setValues({ title: parsed?.title ?? "", year: parsed?.year == null ? "" : String(parsed.year), type: parsed?.type ?? "TV_SHOW", season: String(parsed?.season ?? 1), episode: String(parsed?.episode ?? 1), episodeEnd: parsed?.episodeEnd == null ? "" : String(parsed.episodeEnd) }); }, [state.tasks, key]);
  const busy = state.busy || state.loading, change = (work: () => void) => { work(); setError(null); model.invalidate(); };
  const input = (): CoreInput<"ingestion.preview-recognition-edit"> => {
    if (state.tasks.length !== taskIds.length) throw new Error("请先读取全部所选任务，读取失败时可重试");
    const patch: CoreInput<"ingestion.preview-recognition-edit">["patch"] = {};
    for (const field of Object.keys(labels) as Field[]) {
      if (!enabled[field]) continue;
      if (field === "title") { if (!values.title.trim()) throw new Error("解析标题不能为空"); patch.title = values.title.trim(); }
      else if (field === "type") patch.type = values.type as "MOVIE" | "TV_SHOW";
      else { const value = values[field].trim() ? Number(values[field]) : null, min = field === "season" ? 0 : 1, max = field === "year" ? 9999 : field === "season" ? 999 : 10000; if (value !== null && (!Number.isInteger(value) || value < min || value > max)) throw new Error(`${labels[field]}须为 ${min}～${max} 的整数，留空表示清除`); patch[field] = value; }
    }
    if (!Object.keys(patch).length && !sequence) throw new Error("请勾选至少一个要修改的字段，或开启顺序集号生成");
    if (sequence && (!Number.isInteger(Number(start)) || Number(start) < 1 || Number(start) > 10000)) throw new Error("顺序起始集号须为 1～10000 的整数");
    return { items: state.tasks.map((task) => ({ taskId: task.taskId, expectedRevision: task.revision ?? 0 })), patch, ...(sequence ? { sequence: { start: Number(start), direction } } : {}) };
  };
  const preview = () => { try { void model.preview(input()); } catch (failure) { setError((failure as Error).message); } };
  const save = async (rematch: boolean) => { try { if (await model.save(input(), rematch)) onSaved(); } catch (failure) { setError((failure as Error).message); } };
  return <section className="panel recognition-editor" aria-label="编辑识别信息"><div className="cloud-browser-toolbar"><h2 ref={heading} tabIndex={-1}>编辑识别信息 · {taskIds.length} 项</h2><Button variant="ghost" disabled={busy} onClick={onClose}>关闭识别编辑</Button></div>
    <p className="cloud-hint">只修改勾选的字段，其余保持每个文件的原值。此处不执行文件整理；目录和分值摘要不能代替逐文件确认。</p>
    <ErrorNotice message={error ?? state.error} />{state.loading && <p role="status">正在读取所选任务…</p>}{state.notice && <p className="notice" role="status">{state.notice}</p>}
    {!state.loading && !state.tasks.length && <Button variant="outline" onClick={() => { void model.open(taskIds); }}>重试读取所选任务</Button>}
    <fieldset disabled={busy || !state.tasks.length} className="recognition-edit-fields"><div className="form-grid">{(Object.keys(labels) as Field[]).map((field) => <div className="recognition-edit-field" key={field}><label className="check-label"><input type="checkbox" aria-label={`修改${labels[field]}`} checked={!!enabled[field]} onChange={(event) => change(() => setEnabled({ ...enabled, [field]: event.target.checked }))} />修改{labels[field]}</label>{field === "type" ? <select aria-label={`新${labels[field]}`} disabled={!enabled[field]} value={values[field]} onChange={(event) => change(() => setValues({ ...values, [field]: event.target.value }))}><option value="MOVIE">电影</option><option value="TV_SHOW">剧集</option></select> : <input aria-label={`新${labels[field]}`} disabled={!enabled[field]} type={field === "title" ? "text" : "number"} maxLength={field === "title" ? 500 : undefined} value={values[field]} onChange={(event) => change(() => setValues({ ...values, [field]: event.target.value }))} placeholder={field === "title" ? "填写作品标题" : "留空表示清除"} />}</div>)}</div>
      <label className="check-label"><input type="checkbox" aria-label="按自然文件名生成集号" checked={sequence} onChange={(event) => change(() => setSequence(event.target.checked))} />按自然文件名生成集号</label>{sequence && <div className="form-grid"><label>顺序起始集号<input aria-label="顺序起始集号" type="number" min={1} max={10000} value={start} onChange={(event) => change(() => setStart(event.target.value))} /></label><label>文件名顺序<select aria-label="文件名顺序" value={direction} onChange={(event) => change(() => setDirection(event.target.value as "ASC" | "DESC"))}><option value="ASC">正序：1、2、10</option><option value="DESC">倒序：10、2、1</option></select></label></div>}
      <p className="cloud-hint">顺序生成仅用于单集剧集文件。合并多集请单独填写范围；保存字段不会验证 TMDB 分集存在性，整理预览时会重新校验。</p><Button variant="outline" onClick={preview}>预览识别字段变化</Button>
    </fieldset>
    {state.preview && <div className="recognition-edit-preview"><h3>逐项变化预览</h3>{state.preview.warnings.map((warning) => <p className="cloud-hint" key={warning}>{warning}</p>)}{state.preview.items.map((row, index) => <article className="recognition-edit-item" key={`${row.taskId}:${index}`}><strong className="path">{row.sourcePath}</strong><p>原值：{description(row.before)}</p><p>新值：{description(row.after)}</p>{row.blockers.map((blocker, i) => <p className="recognition-edit-error" role="alert" key={i}>{blocker}</p>)}</article>)}{!state.preview.canApply && <p role="alert">存在阻断项。请修改字段，或关闭编辑后取消选择冲突文件，再重新预览。</p>}<div className="form-actions"><Button variant="outline" disabled={busy || !state.preview.canApply} onClick={() => { void save(false); }}>仅保存识别信息</Button><Button disabled={busy || !state.preview.canApply} onClick={() => { void save(true); }}>保存并重新匹配</Button></div></div>}
  </section>;
}
