import { useEffect, useState } from "react";
import { useService, useServiceState } from "@yeatz/app-framework/react";
import { FolderDown } from "lucide-react";
import { ConfigurationViewModel } from "../configuration-model";
import { Button } from "./ui/button";
import { ErrorNotice } from "./shared";
export function DownloadDirectorySettings() {
  const model = useService(ConfigurationViewModel), state = useServiceState(model, (value) => value);
  const [selected, setSelected] = useState<string | null>(null), [dirty, setDirty] = useState(false), [saved, setSaved] = useState(false);
  useEffect(() => model.watch(), [model]);
  useEffect(() => { if (!dirty) setSelected(state.defaults?.directory?.id ?? null); }, [state.defaults, dirty]);
  const directory = state.directories.find((value) => value.id === selected);
  return <section className="panel settings-card" aria-labelledby="default-download-directory-title">
    <div className="settings-card-heading"><FolderDown size={19} aria-hidden="true" /><h2 id="default-download-directory-title">默认本地下载目录</h2></div>
    <div className="settings-body settings-rows">
      <p className="settings-description">新来源和识别规则可使用此默认目录。已生效配置、活动作业和历史保留原目录；更换默认值不会移动文件。</p>
      <ErrorNotice message={state.error ?? state.queryError} retry={() => { void model.refresh(true); }} />
      <div className="settings-row"><label htmlFor="default-download-directory">下载目录</label><div className="settings-library-choice">
        <select id="default-download-directory" value={selected ?? ""} disabled={state.busy} onChange={(event) => { setSelected(event.target.value || null); setDirty(true); setSaved(false); }}><option value="">未设置默认目录</option>{state.directories.filter((row) => row.kind === "managed").map((row) => <option key={row.id} value={row.id}>{row.path}{row.available ? "" : "（等待原目录授权恢复）"}</option>)}</select>
        {directory && <p className="settings-description settings-mapping-path">{directory.path}{!directory.available && " · 原目录暂不可用，请连接原磁盘后重新选择核验。"}</p>}
        <Button variant="outline" disabled={state.busy} onClick={() => { void model.choose("managed").then((value) => { if (value) { setSelected(value.id); setDirty(true); setSaved(false); } }); }}>选择本地下载目录</Button>
      </div></div>
      {!state.defaults && <p className="settings-description">等待读取当前默认目录版本后才能保存。</p>}
      {saved && <p className="notice" role="status">默认目录已保存，已有绑定和文件保持原位置。</p>}
    </div>
    <div className="settings-footer settings-utility"><p className="settings-description">{dirty ? "有未保存的目录选择，请明确保存后生效。" : "仅选择或取消目录不会更改默认设置。"}</p><Button disabled={state.busy || !state.defaults || !dirty} onClick={() => { void model.saveDefault(selected).then((ok) => { if (ok) { setDirty(false); setSaved(true); } }); }}>保存默认目录</Button></div>
  </section>;
}
