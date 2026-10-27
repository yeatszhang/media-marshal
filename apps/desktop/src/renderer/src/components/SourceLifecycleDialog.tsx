import { useEffect, useId, useRef } from "react";
import type { SourceRule } from "@media-marshal/contracts";
import { useSourceRules } from "../source-draft-context";
import { ErrorNotice } from "./shared";
import { Button } from "./ui/button";

export function SourceLifecycleDialog({ row, operation, onClose }: { row: SourceRule; operation: "remove" | "restore"; onClose(): void }) {
  const { model, state } = useSourceRules(), dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null), title = useId(), description = useId();
  const removing = operation === "remove", busy = !!state.pending, configuration = row.configuration ?? row.draft;
  useEffect(() => {
    const original = document.activeElement, element = dialog.current!;
    element.showModal(); cancel.current?.focus();
    return () => { element.close(); requestAnimationFrame(() => { if (document.querySelector("dialog[open]")) return; if (original instanceof HTMLElement && original.isConnected) original.focus(); else document.querySelector<HTMLButtonElement>("[data-source-add]")?.focus(); }); };
  }, []);
  return <dialog ref={dialog} className="source-lifecycle-dialog" aria-labelledby={title} aria-describedby={description} onCancel={(event) => { event.preventDefault(); if (!busy) onClose(); }}>
    <form onSubmit={(event) => { event.preventDefault(); void model.lifecycle(row, operation).then((saved) => { if (saved) onClose(); }); }}>
      <h2 id={title}>{removing ? "删除来源" : "恢复已删除来源"}？</h2>
      <p id={description}>{removing ? "停止此来源的新工作，移入「已删除来源」。文件、配置和任务历史都会保留，之后可以恢复。" : "恢复原配置和任务记录。来源保持暂停，核对原目录后，再手动恢复工作。"}</p>
      <dl><div><dt>来源名称</dt><dd>{configuration.name}</dd></div><div><dt>配置版本</dt><dd>{row.version ? `v${row.version}` : "未生效的草稿"}</dd></div><div><dt>{configuration.type === "local" ? "本地输入" : "本地下载"}</dt><dd>{configuration.type === "local" ? configuration.sourcePath : state.roots.find((root) => root.id === configuration.downloadRootId)?.path ?? "原下载目录需核对"}</dd></div>{configuration.organization && <div><dt>整理目标</dt><dd>{configuration.organization.targetPath}</dd></div>}</dl>
      <p className="cloud-hint">{removing ? "正在写入的任务需要先暂停并到达安全点；未完成计划保留。其他来源仍需要的共享文件会继续处理。" : "若原输入已被新来源接管，请先解决目录归属冲突。恢复不会解除全局下载或整理暂停。"}</p>
      <ErrorNotice message={state.error} />
      <div className="form-actions"><Button ref={cancel} variant="outline" disabled={busy} onClick={onClose}>取消</Button><Button type="submit" className={removing ? "source-remove-button" : undefined} disabled={busy}>{busy ? "正在处理…" : removing ? "确认删除来源" : "确认恢复来源"}</Button></div>
    </form>
  </dialog>;
}
