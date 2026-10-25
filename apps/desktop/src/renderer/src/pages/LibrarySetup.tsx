import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useService, useServiceState } from "@yeatz/app-framework/react";
import { LibraryViewModel } from "../services";
import { Button } from "../components/ui/button";
import { ErrorNotice } from "../components/shared";

export function LibrarySetup() {
  const { t } = useTranslation(), model = useService(LibraryViewModel), state = useServiceState(model, (value) => value);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  useEffect(() => model.watch(), [model]);
  useEffect(() => { setMapping({}); }, [state.server?.serverId]);
  return <section className="panel settings-form"><h2>{t("ingestion.librarySetup")}</h2><p>{t("ingestion.libraryHelp")}</p><ErrorNotice message={state.error ?? state.queryError} />
    {(["MOVIE", "TV_SHOW"] as const).map((type) => { const target = state.targets.find((row) => row.mediaType === type); return <div className="folder-field" key={type}><span>{t(type === "MOVIE" ? "ingestion.movie" : "ingestion.tv")}</span><div><span className="path" title={target?.path}>{target?.path ?? t("ingestion.unknown")}</span><Button variant="outline" size="sm" disabled={state.busy} onClick={() => { void model.choose(type); }}>{t(type === "MOVIE" ? "ingestion.chooseMovie" : "ingestion.chooseTv")}</Button></div></div>; })}
    <p>{t("ingestion.savedHint")}</p><Button variant="outline" disabled={state.busy || !state.targets.length} onClick={() => { void model.readServer(); }}>{t("ingestion.readLibraries")}</Button>
    {state.server && <><p>Emby {state.server.version}</p>{state.targets.map((target) => <label key={target.targetId}>{target.mediaType === "AUTO" ? "电影／剧集" : t(target.mediaType === "MOVIE" ? "ingestion.movie" : "ingestion.tv")} · {target.path}<select aria-label={`${t("ingestion.chooseLibrary")} · ${target.path}`} disabled={state.busy} value={mapping[target.targetId] ?? ""} onChange={(event) => setMapping({ ...mapping, [target.targetId]: event.target.value })}><option value="">{t("ingestion.chooseLibrary")}</option>{state.server!.libraries.flatMap((library) => library.paths.map((path) => <option key={JSON.stringify([library.id, path])} value={JSON.stringify([library.id, path])}>{library.name} · {path}</option>))}</select></label>)}<Button disabled={state.busy || !state.targets.every((target) => !!mapping[target.targetId])} onClick={() => { const libraries = state.targets.map((target) => { const [libraryId, libraryPath] = JSON.parse(mapping[target.targetId]!) as [string, string]; return { targetId: target.targetId, libraryId, libraryPath }; }); void model.connect({ serverId: state.server!.serverId, libraries }); }}>{t("ingestion.verify")}</Button></>}
    <p role="status">{t(state.configuration?.verified ? "ingestion.verified" : "ingestion.unverified")}</p>
  </section>;
}
