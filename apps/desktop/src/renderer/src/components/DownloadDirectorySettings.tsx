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
  const choose = () => { void model.choose("managed").then((value) => { if (value) { setSelected(value.id); setDirty(true); setSaved(false); } }); };
  const save = () => { void model.saveDefault(selected).then((ok) => { if (ok) { setDirty(false); setSaved(true); } }); };
  const retry = () => { if (state.busy) return; if (state.errorAction === "choose") choose(); else if (state.errorAction === "save") save(); else void model.refresh(true); };
  const directory = state.directories.find((value) => value.id === selected);
  return <section className="panel settings-card" aria-labelledby="default-download-directory-title">
    <div className="settings-card-heading"><FolderDown size={19} aria-hidden="true" /><h2 id="default-download-directory-title">本地下载目录</h2></div>
    <div className="settings-body settings-rows">
      <p className="settings-description">来源统一同步到此目录，识别规则从中读取已完成的文件。更换目录后新任务使用新目录，已受理任务保留原路径，不移动已有文件。</p>
      <ErrorNotice message={state.error ?? state.queryError} retry={retry} />
      <div className="settings-row"><span>下载目录</span><div className="settings-library-choice">
        <p id="default-download-directory" className="settings-description settings-mapping-path">{directory?.path ?? state.defaults?.directory?.path ?? "尚未设置本地下载目录"}{directory && !directory.available && " · 原目录暂不可用，请连接原磁盘后重新选择核验。"}</p>
        <Button variant="outline" disabled={state.busy} onClick={choose}>选择本地下载目录</Button>
      </div></div>
      {!state.defaults && <p className="settings-description">等待读取当前下载目录配置后才能保存。</p>}
      {saved && <p className="notice" role="status">下载目录已保存，新任务使用此目录，已受理任务和已有文件保留原路径。</p>}
    </div>
    <div className="settings-footer settings-utility"><p className="settings-description">{dirty ? "有未保存的目录选择，请明确保存后生效。" : "仅选择或取消目录不会更改下载目录设置。"}</p><Button disabled={state.busy || !state.defaults || !dirty || state.errorAction === "choose"} onClick={save}>保存下载目录</Button></div>
  </section>;
}
