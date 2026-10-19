import { useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { useService, useServiceState } from "@yeatz/app-framework/react";
import {
  Plus,
  Folder,
  FolderPlus,
  ShieldCheck,
  Check,
  LoaderCircle,
  Pause,
  Play,
  ArrowRight,
  HardDrive,
} from "lucide-react";
import type { SourceDraft } from "@media-marshal/contracts";
import { SourcesViewModel } from "../services";
import { Header, Empty, ErrorNotice } from "../components/shared";
import { Button, cn } from "../components/ui/button";

export function Sources() {
  const { t } = useTranslation();
  const model = useService(SourcesViewModel);
  const state = useServiceState(model, (state) => state);
  const [editing, setEditing] = useState(false),
    [busy, setBusy] = useState(false),
    [localError, setLocalError] = useState<string | null>(null);
  const [draft, setDraft] = useState<SourceDraft>({
    name: "",
    kind: "quark",
    sourcePath: "",
    targetPath: "",
    mediaType: "AUTO",
    operation: "COPY",
    automatic: false,
  });
  const addRef = useRef<HTMLButtonElement>(null),
    nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void model.refresh();
  }, [model]);
  useEffect(() => {
    if (editing) nameRef.current?.focus();
  }, [editing]);
  const close = () => {
    setEditing(false);
    requestAnimationFrame(() => addRef.current?.focus());
  };
  const choose = async (purpose: "source" | "target") => {
    try {
      const path = await model.client.chooseDirectory(purpose);
      if (path)
        setDraft((value) => ({
          ...value,
          [purpose === "source" ? "sourcePath" : "targetPath"]: path,
        }));
    } catch (error) {
      setLocalError(
        error instanceof Error ? error.message : t("operationFailed"),
      );
    }
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!draft.name.trim() || !draft.sourcePath || !draft.targetPath) {
      setLocalError(t("required"));
      return;
    }
    setBusy(true);
    setLocalError(null);
    try {
      await model.save(draft);
      close();
      setDraft({
        name: "",
        kind: "quark",
        sourcePath: "",
        targetPath: "",
        mediaType: "AUTO",
        operation: "COPY",
        automatic: false,
      });
    } catch {
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Header title={t("sources")} description={t("sourceHelp")}>
        <Button
          ref={addRef}
          onClick={() => setEditing(true)}
          disabled={editing}
        >
          <Plus size={16} />
          {t("addSource")}
        </Button>
      </Header>
      <ErrorNotice
        message={state.error}
        retry={() => {
          void model.refresh();
        }}
      />
      {editing && (
        <form
          className="panel source-form"
          onSubmit={submit}
          onKeyDown={(event) => {
            if (event.key === "Escape" && !busy) close();
          }}
        >
          <h2>{t("addSource")}</h2>
          <div className="form-grid">
            <label>
              {t("sourceName")}
              <input
                ref={nameRef}
                value={draft.name}
                maxLength={100}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label>
              {t("sourceKind")}
              <select
                value={draft.kind}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    kind: e.target.value as SourceDraft["kind"],
                  })
                }
              >
                {(["quark", "baidu", "alipan", "custom"] as const).map(
                  (kind) => (
                    <option key={kind} value={kind}>
                      {t(kind)}
                    </option>
                  ),
                )}
              </select>
            </label>
          </div>
          {(["source", "target"] as const).map((purpose) => (
            <div className="folder-field" key={purpose}>
              <span>
                {t(purpose === "source" ? "sourcePath" : "targetPath")}
              </span>
              <div>
                <Folder size={17} />
                <span
                  className="path"
                  title={
                    draft[purpose === "source" ? "sourcePath" : "targetPath"]
                  }
                >
                  {draft[purpose === "source" ? "sourcePath" : "targetPath"] ||
                    "—"}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    void choose(purpose);
                  }}
                >
                  {t("choose")}
                </Button>
              </div>
            </div>
          ))}
          <div className="notice">
            <ShieldCheck size={17} />
            {t("copy")}
            <span>·</span>
            {t("manual")}
          </div>
          <ErrorNotice message={localError} />
          <div className="form-actions">
            <Button variant="ghost" disabled={busy} onClick={close}>
              {t("cancel")}
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? (
                <LoaderCircle className="spin" size={15} />
              ) : (
                <Check size={15} />
              )}{" "}
              {t(busy ? "saving" : "save")}
            </Button>
          </div>
        </form>
      )}
      {!state.loading && !state.items.length && !editing && (
        <section className="panel">
          <Empty
            icon={<FolderPlus size={28} />}
            title={t("emptySources")}
            description={t("startDetail")}
          />
        </section>
      )}
      {state.loading && (
        <div className="loading" role="status">
          {t("loading")}
        </div>
      )}
      <div className="source-list">
        {state.items.map((source) => (
          <article className="panel source-card" key={source.id}>
            <div className={cn("drive-icon", `drive-${source.kind}`)}>
              <HardDrive size={23} />
            </div>
            <div className="source-info">
              <h3>
                {source.name}
                <span className="badge">{t(source.kind)}</span>
                {source.paused && <span className="badge">{t("paused")}</span>}
              </h3>
              <div className="source-path">
                <span title={source.sourcePath}>{source.sourcePath}</span>
                <ArrowRight size={13} />
                <span title={source.targetPath}>{source.targetPath}</span>
              </div>
              <div className="source-meta">
                <span>{t("copy")}</span>
                <span>{t("unverified")}</span>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void model.pause(source.id, !source.paused);
              }}
            >
              {source.paused ? <Play size={15} /> : <Pause size={15} />}{" "}
              {t(source.paused ? "resume" : "pause")}
            </Button>
          </article>
        ))}
      </div>
    </>
  );
}
