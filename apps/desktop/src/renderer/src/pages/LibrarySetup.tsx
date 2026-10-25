import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useService, useServiceState } from "@yeatz/app-framework/react";
import { FolderOpen, Check, CircleHelp } from "lucide-react";
import { LibraryViewModel } from "../services";
import { Button } from "../components/ui/button";
import { ErrorNotice } from "../components/shared";

export function LibrarySetup() {
  const { t } = useTranslation();
  const model = useService(LibraryViewModel);
  const state = useServiceState(model, (value) => value);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  useEffect(() => model.watch(), [model]);
  useEffect(() => {
    setMapping({});
  }, [state.server?.serverId]);
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
          disabled={state.busy || !state.targets.length}
          onClick={() => {
            void model.readServer();
          }}
        >
          {t("ingestion.readLibraries")}
        </Button>
      </div>
      {state.server && (
        <div className="settings-body settings-rows settings-library-mapping">
          <p className="settings-description">Emby {state.server.version}</p>
          {state.targets.map((target) => (
            <div className="settings-row" key={target.targetId}>
              <label htmlFor={`settings-library-${target.targetId}`}>
                {target.mediaType === "AUTO"
                  ? "电影／剧集"
                  : t(
                      target.mediaType === "MOVIE"
                        ? "ingestion.movie"
                        : "ingestion.tv",
                    )}
              </label>
              <div className="settings-library-choice">
                <span className="settings-description settings-mapping-path">
                  {target.path}
                </span>
                <select
                  id={`settings-library-${target.targetId}`}
                  aria-label={`${t("ingestion.chooseLibrary")} · ${target.path}`}
                  disabled={state.busy}
                  value={mapping[target.targetId] ?? ""}
                  onChange={(event) =>
                    setMapping({
                      ...mapping,
                      [target.targetId]: event.target.value,
                    })
                  }
                >
                  <option value="">{t("ingestion.chooseLibrary")}</option>
                  {state.server!.libraries.flatMap((library) =>
                    library.paths.map((path) => (
                      <option
                        key={JSON.stringify([library.id, path])}
                        value={JSON.stringify([library.id, path])}
                      >
                        {library.name} · {path}
                      </option>
                    )),
                  )}
                </select>
              </div>
            </div>
          ))}
          <div className="settings-actions">
            <Button
              disabled={
                state.busy ||
                !state.targets.every((target) => !!mapping[target.targetId])
              }
              onClick={() => {
                const libraries = state.targets.map((target) => {
                  const [libraryId, libraryPath] = JSON.parse(
                    mapping[target.targetId]!,
                  ) as [string, string];
                  return { targetId: target.targetId, libraryId, libraryPath };
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
