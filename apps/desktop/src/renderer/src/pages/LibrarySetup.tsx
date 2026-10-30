import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useService, useServiceState } from "@yeatz/app-framework/react";
import { FolderOpen, Check, CircleHelp } from "lucide-react";
import type { CoreInput } from "@media-marshal/contracts";
import { LibraryViewModel } from "../services";
import { Button } from "../components/ui/button";
import { ErrorNotice } from "../components/shared";

export function LibrarySetup() {
  const { t } = useTranslation();
  const model = useService(LibraryViewModel);
  const state = useServiceState(model, (value) => value);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [conversions, setConversions] = useState<Record<string, { enabled: boolean; localRoot: string; serverRoot: string; serverPathStyle: "posix" | "win32" }>>({});
  const initialized = useRef(false);
  useEffect(() => model.watch(), [model]);
  useEffect(() => {
    if (!state.configuration || initialized.current) return;
    initialized.current = true;
    setConversions(Object.fromEntries(state.configuration.libraries.filter((row) => row.conversion).map((row) => [row.targetId, { enabled: true, ...row.conversion! }])));
  }, [state.configuration]);
  useEffect(() => {
    if (!state.discovery) return;
    setMapping(Object.fromEntries(state.discovery.targets.map((target) => [target.targetId, target.state === "MATCHED" ? JSON.stringify([target.matches[0]!.libraryId, target.matches[0]!.libraryPath]) : ""])));
  }, [state.discovery]);
  const conversionInput = (): CoreInput<"emby.discover"> => ({ conversions: state.targets.map((target) => { const value = conversions[target.targetId]; return { targetId: target.targetId, conversion: value?.enabled ? { localRoot: value.localRoot, serverRoot: value.serverRoot, serverPathStyle: value.serverPathStyle } : null }; }) });
  const changeConversion = (id: string, patch: Partial<{ enabled: boolean; localRoot: string; serverRoot: string; serverPathStyle: "posix" | "win32" }>) => { const target = state.targets.find((row) => row.targetId === id)!; setConversions((values) => ({ ...values, [id]: { enabled: false, localRoot: target.path, serverRoot: "", serverPathStyle: "posix", ...values[id], ...patch } })); setMapping({}); model.clearDiscovery(); };
  useEffect(() => {
    setMapping({});
  }, [state.server?.serverId]);
  const invalidConversion = state.targets.some((target) => { const value = conversions[target.targetId]; return value?.enabled && (!value.localRoot.trim() || !value.serverRoot.trim()); });
  return (
    <section
      className="panel settings-card"
      aria-labelledby="settings-library-title"
    >
      <div className="settings-card-heading">
        <FolderOpen size={19} aria-hidden="true" />
        <h2 id="settings-library-title">{t("ingestion.librarySetup")}</h2>
      </div>
      <div className="settings-body settings-rows">
        <p className="settings-description">{t("ingestion.libraryHelp")}</p>
        <ErrorNotice message={state.error ?? state.queryError} />
        {(["MOVIE", "TV_SHOW"] as const).map((type) => {
          const target = state.targets.find((row) => row.mediaType === type);
          return (
            <div className="settings-row" key={type}>
              <span
                id={`settings-directory-${type}`}
                className="settings-field-label"
              >
                {t(type === "MOVIE" ? "ingestion.movie" : "ingestion.tv")}
              </span>
              <div
                className="settings-directory"
                role="group"
                aria-labelledby={`settings-directory-${type}`}
              >
                <span
                  className={`settings-directory-path${target ? "" : " is-empty"}`}
                  title={target?.path}
                >
                  {target?.path ?? t("ingestion.unknown")}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={state.busy}
                  onClick={() => {
                    void model.choose(type);
                  }}
                >
                  {t(
                    type === "MOVIE"
                      ? "ingestion.chooseMovie"
                      : "ingestion.chooseTv",
                  )}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
      <div className="settings-footer settings-utility">
        <p className="settings-description">{t("ingestion.savedHint")}</p>
        <Button
          variant="outline"
          disabled={state.busy || !state.targets.length || invalidConversion}
          onClick={() => {
            void model.readServer(conversionInput());
          }}
        >
          {t("ingestion.readLibraries")}
        </Button>
      </div>
      {state.server && (
        <div className="settings-body settings-rows settings-library-mapping">
          <p className="settings-description">Emby {state.server.version}</p>
          {state.targets.map((target) => {
            const discovery = state.discovery?.targets.find((row) => row.targetId === target.targetId), conversion = conversions[target.targetId];
            const label = target.mediaType === "AUTO" ? "电影／剧集" : t(target.mediaType === "MOVIE" ? "ingestion.movie" : "ingestion.tv");
            return <div className="settings-library-choice" key={target.targetId}>
              <label htmlFor={`settings-library-${target.targetId}`}>{label} · {target.path}</label>
              <label className="settings-mapping-toggle"><input type="checkbox" aria-label={`配置路径转换 · ${target.path}`} checked={conversion?.enabled ?? false} disabled={state.busy} onChange={(event) => changeConversion(target.targetId, { enabled: event.target.checked })} /><span>本机与服务端使用不同路径</span></label>
              {conversion?.enabled && <div className="settings-rows">
                <label>本机根<input aria-label={`本机根 · ${target.path}`} value={conversion.localRoot} disabled={state.busy} onChange={(event) => changeConversion(target.targetId, { localRoot: event.target.value })} /></label>
                <label>服务端根<input aria-label={`服务端根 · ${target.path}`} value={conversion.serverRoot} disabled={state.busy} onChange={(event) => changeConversion(target.targetId, { serverRoot: event.target.value })} /></label>
                <label>服务端路径风格<select aria-label={`服务端路径风格 · ${target.path}`} value={conversion.serverPathStyle} disabled={state.busy} onChange={(event) => changeConversion(target.targetId, { serverPathStyle: event.target.value as "posix" | "win32" })}><option value="posix">POSIX / 容器</option><option value="win32">Windows</option></select></label>
              </div>}
              {conversion?.enabled && (!conversion.localRoot.trim() || !conversion.serverRoot.trim()) && <p className="notice notice-error" role="alert">请填写此目标的本机根和服务端根，再重新发现关联。</p>}
              <select id={`settings-library-${target.targetId}`} aria-label={`${t("ingestion.chooseLibrary")} · ${target.path}`} disabled={state.busy || !discovery?.matches.length} value={mapping[target.targetId] ?? ""} onChange={(event) => setMapping({ ...mapping, [target.targetId]: event.target.value })}>
                <option value="">暂不关联此目标</option>
                {discovery?.matches.map((match) => <option key={JSON.stringify([match.libraryId, match.libraryPath])} value={JSON.stringify([match.libraryId, match.libraryPath])}>{state.server!.libraries.find((row) => row.id === match.libraryId)?.name ?? match.libraryId} · {match.libraryPath}</option>)}
              </select>
              <p className="settings-description" role="status">{!discovery ? "路径配置已变化，请重新发现关联。" : discovery.state === "MATCHED" ? "发现唯一兼容库根，请验证并保存。" : discovery.state === "AMBIGUOUS" ? "匹配多个库根，请明确选择其中一个。" : discovery.state === "TYPE_CONFLICT" ? "路径匹配但媒体类型不兼容，请选择同类型库或核对目标类型。" : discovery.state === "UNAVAILABLE" ? discovery.reason : "没有匹配库根，请核对完整路径或配置显式转换；仍可独立整理文件。"}</p>
              {discovery?.matches.filter((match) => mapping[target.targetId] === JSON.stringify([match.libraryId, match.libraryPath])).map((match) => <p className="settings-description settings-mapping-path" key={match.serverPath}>本机目标：{target.path}<br />服务端目标：{match.serverPath}</p>)}
            </div>;
          })}
          <Button variant="outline" disabled={state.busy || invalidConversion} onClick={() => { setMapping({}); void model.discover(conversionInput()); }}>重新发现关联</Button>
          {!state.discovery && <p className="settings-description">请先发现关联并核对两侧完整目标，才能验证保存。</p>}
          <div className="settings-actions">
            <Button
              disabled={
                state.busy ||
                !state.targets.some((target) => !!mapping[target.targetId]) || !state.discovery
              }
              onClick={() => {
                const libraries = state.targets.filter((target) => mapping[target.targetId]).map((target) => {
                  const [libraryId, libraryPath] = JSON.parse(
                    mapping[target.targetId]!,
                  ) as [string, string];
                  const conversion = conversionInput().conversions!.find((row) => row.targetId === target.targetId)?.conversion;
                  return { targetId: target.targetId, libraryId, libraryPath, ...(conversion ? { conversion } : {}) };
                });
                void model.connect({
                  serverId: state.server!.serverId,
                  libraries,
                });
              }}
            >
              {t("ingestion.verify")}
            </Button>
          </div>
        </div>
      )}
      <div className="settings-footer">
        <p
          className={`settings-verification${state.configuration?.verified ? " is-verified" : ""}`}
          role="status"
        >
          {state.configuration?.verified ? (
            <Check size={15} aria-hidden="true" />
          ) : (
            <CircleHelp size={15} aria-hidden="true" />
          )}
          {t(
            state.configuration?.verified
              ? "ingestion.verified"
              : "ingestion.unverified",
          )}
        </p>
      </div>
    </section>
  );
}
