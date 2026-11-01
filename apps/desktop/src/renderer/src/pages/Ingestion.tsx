import { useEffect, useRef, useState } from "react";
import type { SourceRule } from "@media-marshal/contracts";
import { Link, useLocation, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useService, useServiceState } from "@yeatz/app-framework/react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  FileCheck2,
  Folder,
  ListTodo,
  RefreshCw,
  ScanLine,
  History,
  Layers,
} from "lucide-react";
import { IngestionViewModel } from "../services";
import { Header, Empty, ErrorNotice } from "../components/shared";
import { Button } from "../components/ui/button";
import { SeasonQueuePanel } from "../components/SeasonQueuePanel";
import { DirectoryQueuePanel } from "../components/DirectoryQueuePanel";
import { RecognitionEditor } from "../components/RecognitionEditor";
import {
  OrganizeBatchEditor,
  OrganizeBatchPanel,
  type CommonWork,
} from "../components/OrganizeBatchPanel";
import { SourceScansPanel } from "../components/SourceScansPanel";
import { ContentReviewsPanel } from "../components/ContentReviewsPanel";
import { FileRecognitionQueue } from "../components/FileRecognitionQueue";
import {
  CodexRecognitionActions,
  CodexRecognitionPanel,
} from "../components/CodexRecognitionPanel";
import { DirectoriesViewModel } from "../directories-model";
import { RecognitionViewModel } from "../recognition-model";
import { SourceScansViewModel } from "../source-scans-model";
import "./recognition-workspace.css";
import { DownloadCleanupPanel, DownloadCleanupNotice } from "../components/DownloadCleanupPanel";

function RecognitionScans({ sources }: { sources: SourceRule[] }) {
  const rules = useService(RecognitionViewModel),
    state = useServiceState(rules, (value) => value);
  useEffect(() => rules.watch(), [rules]);
  return (
    <>
      <ErrorNotice
        message={state.queryError}
        retry={() => {
          void rules.refresh(true);
        }}
      />
      <SourceScansPanel sources={sources} recognitionRules={state.items} />
      <ContentReviewsPanel sources={sources} />
    </>
  );
}

export function Ingestion() {
  const { t } = useTranslation(),
    model = useService(IngestionViewModel),
    state = useServiceState(model, (value) => value),
    location = useLocation(),
    [query, setQuery] = useSearchParams();
  const [targetId, setTargetId] = useState("");
  const [id, setId] = useState(""),
    [type, setType] = useState<"MOVIE" | "TV_SHOW">("MOVIE"),
    [season, setSeason] = useState("1"),
    [episode, setEpisode] = useState("1"),
    [end, setEnd] = useState(""),
    [template, setTemplate] = useState(""),
    [complete, setComplete] = useState(false),
    [includeAccessories, setIncludeAccessories] = useState(true);
  const [organizing, setOrganizing] = useState<{ taskIds: string[]; work?: CommonWork } | null>(
    null,
  );
  const [view, setView] = useState<"files" | "directories" | "seasons" | "scans" | "history">(
    query.has("task") || (location.state as { taskId?: string } | null)?.taskId
      ? "files"
      : "directories",
  );
  const [selectedTasks, setSelectedTasks] = useState<string[]>([]),
    [editingTasks, setEditingTasks] = useState<string[] | null>(null);
  const directories = useService(DirectoriesViewModel),
    directoryState = useServiceState(directories, (value) => value),
    [directoryScope, setDirectoryScope] = useState(false);
  const scans = useService(SourceScansViewModel),
    scanState = useServiceState(scans, (value) => value);
  const requestedTask = useRef<string | null>(null);
  useEffect(() => {
    const release = model.watch();
    return () => {
      requestedTask.current = null;
      release();
    };
  }, [model]);
  useEffect(() => scans.watch(), [scans]);
  useEffect(() => {
    const taskId = query.get("task") ?? (location.state as { taskId?: string } | null)?.taskId;
    if (taskId) setView("files");
    if (taskId && taskId !== requestedTask.current) {
      requestedTask.current = taskId;
      void model.select(taskId);
    }
  }, [model, location.state, query.get("task")]);
  useEffect(() => {
    setTargetId("");
    setId("");
    setTemplate("");
    setComplete(false);
    setEnd("");
    setIncludeAccessories(true);
  }, [state.task?.taskId]);
  useEffect(() => {
    const parsed = state.task?.parsed;
    if (parsed) {
      setType(parsed.type ?? "MOVIE");
      setSeason(String(parsed.season ?? 1));
      setEpisode(String(parsed.episode ?? 1));
      setEnd(parsed.episodeEnd === null ? "" : String(parsed.episodeEnd));
    }
  }, [state.task?.parsed?.season, state.task?.parsed?.episode, state.task?.taskId]);
  const inspect = (taskId: string) => {
    requestedTask.current = taskId;
    setView("files");
    setEditingTasks(null);
    setOrganizing(null);
    setQuery({ task: taskId });
    void model.select(taskId);
  };
  const change = (update: () => void) => {
    update();
    model.clearPreview();
    setComplete(false);
  };
  const openOrganize = (taskIds: string[], work?: CommonWork) => {
    model.clearPreview();
    setComplete(false);
    setOrganizing({ taskIds, work });
  };
  const targets = state.targets?.targets.filter((target) => target.mediaType === type) ?? [];
  useEffect(() => {
    if (targetId && !targets.some((target) => target.id === targetId)) setTargetId("");
  }, [type, JSON.stringify(targets)]);
  const queue = (
      directoryScope
        ? (directoryState.detail?.items.map((item) => item.candidate) ?? [])
        : state.items
    ).filter((item) => item.taskId && item.state === "QUEUED"),
    position = queue.findIndex((item) => item.taskId === state.task?.taskId);
  const switchView = (next: typeof view) => {
    setView(next);
    setDirectoryScope(false);
    setEditingTasks(null);
    setOrganizing(null);
    setSelectedTasks([]);
    model.clearPreview();
    setComplete(false);
  };
  const scanIssues = scanState.items.filter(
    (job) => job.failed > 0 || job.state === "FAILED",
  ).length;
  const previewExpired = !!state.preview && Date.now() >= state.preview.expiresAt;
  return (
    <>
      <Header title={t("ingestion.title")} description={t("ingestion.help")}>
        <Button
          variant="outline"
          onClick={() => {
            void model.refresh();
          }}
        >
          <RefreshCw size={15} />
          {t("reload")}
        </Button>
      </Header>
      <ErrorNotice message={state.error} />
      <div className="recognition-policy">
        <span>
          <Folder size={16} />
          {t("ingestion.directoryFirst")}
        </span>
        <span>{t("ingestion.ruleFirst")}</span>
        <span>{t("ingestion.humanLast")}</span>
      </div>
      <nav className="recognition-tabs" aria-label={t("ingestion.workspaceNavigation")}>
        {(
          [
            { key: "directories", icon: Folder, label: "directoryTab" },
            { key: "files", icon: FileCheck2, label: "fileTab" },
            { key: "seasons", icon: Layers, label: "seasonTab" },
            { key: "scans", icon: ScanLine, label: "scanTab" },
            { key: "history", icon: History, label: "historyTab" },
          ] as const
        ).map(({ key, icon: Icon, label }) => (
          <Button
            key={key}
            variant="ghost"
            aria-current={view === key ? "page" : undefined}
            onClick={() => switchView(key)}
          >
            <Icon size={16} />
            {t(`ingestion.${label}`)}
            {key === "scans" && scanIssues > 0 && <span className="badge">{scanIssues}</span>}
          </Button>
        ))}
      </nav>
      {view === "scans" ? (
        <div className="recognition-support">
          <RecognitionScans sources={state.sources} />
        </div>
      ) : view === "history" ? (
        <div className="recognition-support">
          <OrganizeBatchPanel onInspect={inspect} />
          <p className="cloud-hint">
            {t("ingestion.historyHelp")} <Link to="/tasks">{t("nav.tasks")}</Link>
          </p>
        </div>
      ) : (
        <>
          {(editingTasks || organizing) && (
            <div className="recognition-focused-editor">
              <Button
                variant="ghost"
                disabled={state.busy}
                onClick={() => {
                  setEditingTasks(null);
                  setOrganizing(null);
                }}
              >
                <ArrowLeft size={16} />
                {t("ingestion.backToQueue")}
              </Button>
              {editingTasks && (
                <RecognitionEditor
                  key={editingTasks.join(",")}
                  taskIds={editingTasks}
                  onClose={() => setEditingTasks(null)}
                  onSaved={() => {
                    setSelectedTasks([]);
                    model.clearPreview();
                    setComplete(false);
                    void model.refresh();
                  }}
                />
              )}
              {organizing && (
                <OrganizeBatchEditor
                  key={JSON.stringify(organizing)}
                  {...organizing}
                  onClose={() => setOrganizing(null)}
                  onPreviewed={() => {
                    setOrganizing(null);
                    setView("history");
                  }}
                />
              )}
            </div>
          )}
          <CodexRecognitionPanel onInspect={inspect} />
          <div hidden={!!editingTasks || !!organizing}>
            {view === "directories" ? (
              <DirectoryQueuePanel
                onInspect={(id) => {
                  setDirectoryScope(true);
                  inspect(id);
                }}
                onEdit={setEditingTasks}
                onOrganize={openOrganize}
              />
            ) : view === "seasons" ? (
              <SeasonQueuePanel
                onInspect={inspect}
                onEdit={setEditingTasks}
                onOrganize={openOrganize}
              />
            ) : (
              <div className="recognition-file-workspace">
                <FileRecognitionQueue
                  directoryScope={directoryScope}
                  onClearScope={() => {
                    setDirectoryScope(false);
                    setSelectedTasks([]);
                  }}
                  selectedTasks={selectedTasks}
                  onSelection={setSelectedTasks}
                  onInspect={inspect}
                  onEdit={setEditingTasks}
                  onOrganize={openOrganize}
                />
                <div
                  className="recognition-inspector"
                  aria-label={t("ingestion.currentFile")}
                  aria-busy={state.selecting}
                >
                  <div className="recognition-inspector-toolbar">
                    <strong>{t("ingestion.fileTab")}</strong>
                    <div>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={state.busy || state.selecting || position <= 0}
                        onClick={() => inspect(queue[position - 1]!.taskId!)}
                        aria-label={t("ingestion.previousFile")}
                      >
                        <ChevronLeft size={16} />
                        {t("ingestion.previousFile")}
                      </Button>
                      <span>{position >= 0 ? `${position + 1} / ${queue.length}` : "—"}</span>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={
                          state.busy ||
                          state.selecting ||
                          position < 0 ||
                          position >= queue.length - 1
                        }
                        onClick={() => inspect(queue[position + 1]!.taskId!)}
                        aria-label={t("ingestion.nextFile")}
                      >
                        {t("ingestion.nextFile")}
                        <ChevronRight size={16} />
                      </Button>
                    </div>
                  </div>
                  {state.selecting ? (
                    <p className="recognition-loading" role="status">
                      {t("ingestion.loadingFile")}
                    </p>
                  ) : !state.task ? (
                    <Empty
                      icon={<ListTodo size={28} />}
                      title={t("ingestion.chooseFile")}
                      description={t("ingestion.chooseFileHelp")}
                    />
                  ) : (
                    <>
                      {state.task && (
                        <section className="settings-form recognition-task-form">
                          <details className="recognition-source-details">
                            <summary title={state.task.sourcePath ?? undefined}>
                              {t("ingestion.source")} · {state.task.sourcePath?.split("/").at(-1)}
                            </summary>
                            <p className="recognition-source-path">{state.task.sourcePath}</p>
                          </details>
                          <h2>{state.task.parsed?.title || t("ingestion.edit")}</h2>
                          <p role="status">{t(state.task.state)}</p>
                          <ErrorNotice message={state.task.failure} />
                          {state.task.state === "PENDING" || state.task.state === "PROCESSING" ? (
                            <p>{t("ingestion.waiting")}</p>
                          ) : null}
                          {state.task.state === "FAILED" ||
                          (state.task.state === "AWAITING_CONFIRMATION" && !state.task.parsed) ? (
                            <Button
                              variant="outline"
                              disabled={state.busy}
                              onClick={() => {
                                void model.retry(state.task!.taskId);
                              }}
                            >
                              {t("ingestion.retry")}
                            </Button>
                          ) : null}
                          {!!state.task.accessories?.length && (
                            <div className="organize-preview">
                              <h3>{t("ingestion.accessories")}</h3>
                              {state.task.accessories.map((asset) => (
                                <div key={asset.id}>
                                  <p className="path">{asset.targetPath}</p>
                                  <span>{t(`ingestion.${asset.state}`)}</span>
                                  {asset.failure && <small> · {asset.failure}</small>}
                                </div>
                              ))}
                              {state.task.state === "DONE" &&
                                state.task.accessories.some(
                                  (asset) => asset.state === "NEEDS_ATTENTION",
                                ) && (
                                  <Button
                                    variant="outline"
                                    disabled={state.busy}
                                    onClick={() => {
                                      void model.retry(state.task!.taskId);
                                    }}
                                  >
                                    {t("ingestion.retryAccessories")}
                                  </Button>
                                )}
                            </div>
                          )}
                          {state.task.state === "AWAITING_CONFIRMATION" && (
                            <>
                              <Button
                                variant="outline"
                                disabled={state.busy}
                                onClick={() => setEditingTasks([state.task!.taskId])}
                              >
                                编辑此项识别信息
                              </Button>
                              <CodexRecognitionActions taskId={state.task.taskId} compact />
                            </>
                          )}
                          {state.task.matchesStale && (
                            <p className="notice">
                              这些 TMDB 候选来自编辑前的识别信息，请重新匹配或逐项核对后再预览整理。
                            </p>
                          )}
                          {state.task.state === "AWAITING_CONFIRMATION" && state.task.parsed && (
                            <>
                              <section className="recognition-decision">
                                <h3>{t("ingestion.workCandidates")}</h3>
                                <p className="cloud-hint">{t("ingestion.candidateHelp")}</p>
                                <div className="recognition-matches">
                                  {state.task.matches.map((match) => (
                                    <article
                                      className={`recognition-match${id === String(match.tmdbId) && type === match.mediaType ? " is-selected" : ""}`}
                                      key={`${match.mediaType}:${match.tmdbId}`}
                                    >
                                      <strong>
                                        {match.title} {match.year ?? ""}
                                      </strong>
                                      <span>
                                        {Math.round(match.confidence * 100)}% ·{" "}
                                        {t(`ingestion.${match.evidence}`)}
                                      </span>
                                      <small>{match.explanation}</small>
                                      {match.mediaType === "TV_SHOW" && (
                                        <small>
                                          {match.episodeCheck?.state === "VALID"
                                            ? `季集预检：S${match.episodeCheck.season} E${match.episodeCheck.episode}${match.episodeCheck.episodeEnd !== null ? `–${match.episodeCheck.episodeEnd}` : ""}${match.episodeCheck.seasonChanged ? "（按真实分集唯一换季）" : ""}。整理预览仍会重新校验。`
                                            : match.episodeCheck?.state === "NEEDS_REVIEW"
                                              ? `季集待核对：${match.episodeCheck.reason}`
                                              : "季集尚未预检，整理预览时核对真实分集。"}
                                        </small>
                                      )}
                                      <Button
                                        variant="outline"
                                        size="sm"
                                        aria-pressed={
                                          id === String(match.tmdbId) && type === match.mediaType
                                        }
                                        disabled={state.busy}
                                        onClick={() =>
                                          change(() => {
                                            setId(String(match.tmdbId));
                                            setType(match.mediaType);
                                          })
                                        }
                                      >
                                        {t("ingestion.selected")}
                                      </Button>
                                    </article>
                                  ))}
                                </div>
                              </section>
                              <section className="recognition-decision">
                                <h3>{t("ingestion.checkMetadata")}</h3>
                                <p className="cloud-hint">{t("ingestion.noMatch")}</p>
                                <div className="form-grid">
                                  <label>
                                    {t("ingestion.id")}
                                    <input
                                      type="number"
                                      min="1"
                                      value={id}
                                      disabled={state.busy}
                                      onChange={(event) => change(() => setId(event.target.value))}
                                    />
                                  </label>
                                  <label>
                                    {t("ingestion.mediaType")}
                                    <select
                                      aria-label={t("ingestion.mediaType")}
                                      value={type}
                                      disabled={state.busy}
                                      onChange={(event) =>
                                        change(() => setType(event.target.value as typeof type))
                                      }
                                    >
                                      <option value="MOVIE">{t("ingestion.movie")}</option>
                                      <option value="TV_SHOW">{t("ingestion.tv")}</option>
                                    </select>
                                  </label>
                                </div>
                                {type === "TV_SHOW" && (
                                  <div className="form-grid">
                                    {(
                                      [
                                        { key: "season", value: season, set: setSeason, min: 0 },
                                        { key: "episode", value: episode, set: setEpisode, min: 1 },
                                        { key: "end", value: end, set: setEnd, min: 1 },
                                      ] as const
                                    ).map((field) => (
                                      <label key={field.key}>
                                        {t(`ingestion.${field.key}`)}
                                        <input
                                          type="number"
                                          min={field.min}
                                          value={field.value}
                                          disabled={state.busy}
                                          onChange={(event) =>
                                            change(() => field.set(event.target.value))
                                          }
                                        />
                                      </label>
                                    ))}
                                  </div>
                                )}
                                {state.targets?.ruleId && (
                                  <>
                                    <label>
                                      本次映射目标
                                      <select
                                        aria-label="本次映射目标"
                                        disabled={state.busy || state.selecting}
                                        value={targetId}
                                        onChange={(event) =>
                                          change(() => setTargetId(event.target.value))
                                        }
                                      >
                                        <option value="">
                                          {targets.length === 1
                                            ? "唯一目标自动匹配"
                                            : targets.length
                                              ? "请选择本次目标"
                                              : "尚无匹配类型目标"}
                                        </option>
                                        {targets.map((target) => (
                                          <option value={target.id} key={target.id}>
                                            {target.name} ·{" "}
                                            {target.mediaType === "MOVIE" ? "电影" : "剧集"}
                                          </option>
                                        ))}
                                      </select>
                                    </label>
                                    {targets.length !== 1 && !targetId && (
                                      <p className="notice">
                                        {targets.length
                                          ? "同类型存在多个目标，请明确选择后预览。"
                                          : "此媒体类型没有目标，请先补充配置再重新预览。"}{" "}
                                        <Link to={`/recognition?rule=${state.targets.ruleId}`}>
                                          配置识别映射
                                        </Link>
                                      </p>
                                    )}
                                  </>
                                )}
                                <details className="recognition-advanced">
                                  <summary>{t("ingestion.moreOptions")}</summary>
                                  <label>
                                    {t("ingestion.template")}
                                    <input
                                      value={template}
                                      disabled={state.busy}
                                      onChange={(event) =>
                                        change(() => setTemplate(event.target.value))
                                      }
                                    />
                                  </label>
                                  <label className="check-label">
                                    <input
                                      type="checkbox"
                                      checked={includeAccessories}
                                      disabled={state.busy}
                                      onChange={(event) =>
                                        change(() => setIncludeAccessories(event.target.checked))
                                      }
                                    />
                                    {t("ingestion.includeAccessories")}
                                  </label>
                                </details>
                                <Button
                                  variant="outline"
                                  disabled={
                                    state.busy ||
                                    state.selecting ||
                                    (!!state.targets?.ruleId &&
                                      targets.length !== 1 &&
                                      !targetId) ||
                                    !Number.isSafeInteger(Number(id)) ||
                                    Number(id) <= 0 ||
                                    (type === "TV_SHOW" && (!season || !episode))
                                  }
                                  onClick={() => {
                                    setComplete(false);
                                    void model.preview({
                                      includeAccessories,
                                      selection: {
                                        ...(targetId ? { targetId } : {}),
                                        tmdbId: Number(id),
                                        mediaType: type,
                                        season: type === "TV_SHOW" ? Number(season) : null,
                                        episode: type === "TV_SHOW" ? Number(episode) : null,
                                        episodeEnd: type === "TV_SHOW" && end ? Number(end) : null,
                                      },
                                      ...(template.trim() ? { template } : {}),
                                    });
                                  }}
                                >
                                  {t("ingestion.preview")}
                                </Button>
                              </section>
                              {state.preview && (
                                <div className="organize-preview">
                                  <h3>{state.preview.title}</h3>
                                  {state.targets?.ruleId && (
                                    <p className="cloud-hint">
                                      样本预览：{state.preview.id} ·{" "}
                                      <Link
                                        to={
                                          state.targets.automatic
                                            ? `/recognition?rule=${state.targets.ruleId}&sample=${state.preview.id}`
                                            : `/recognition?rule=${state.targets.ruleId}`
                                        }
                                      >
                                        {state.targets.automatic
                                          ? "核对本样本并授权自动策略"
                                          : "查看识别映射与策略"}
                                      </Link>
                                    </p>
                                  )}
                                  <p className="path">
                                    {t("ingestion.source")}：{state.preview.sourcePath}
                                  </p>
                                  <p className="path">
                                    {t("ingestion.target")}：{state.preview.targetPath}
                                  </p>
                                  {state.preview.mediaType === "TV_SHOW" && (
                                    <p>
                                      S{state.preview.season} E{state.preview.episode}
                                      {state.preview.episodeEnd
                                        ? `–${state.preview.episodeEnd}`
                                        : ""}
                                    </p>
                                  )}
                                  <div>
                                    {state.preview.accessories?.map((asset) => (
                                      <p className="path" key={asset.targetPath}>
                                        {asset.sourcePath} → {asset.targetPath} · {asset.size} B
                                      </p>
                                    ))}
                                  </div>
                                  <p>{t("ingestion.proof")}</p>
                                  <DownloadCleanupNotice />
                                  <label className="check-label">
                                    <input
                                      type="checkbox"
                                      checked={complete}
                                      disabled={state.busy || previewExpired}
                                      onChange={(event) => setComplete(event.target.checked)}
                                    />
                                    {t("ingestion.completed")}
                                  </label>
                                  {previewExpired && (
                                    <p role="alert" className="notice notice-error">
                                      整理预览已过期，请重新预览并核对文件完整性后确认；尚未提交
                                      COPY。
                                    </p>
                                  )}
                                  <Button
                                    disabled={state.busy || !complete || previewExpired}
                                    onClick={() => {
                                      void model.confirm();
                                    }}
                                  >
                                    {t("ingestion.confirm")}
                                  </Button>
                                </div>
                              )}
                            </>
                          )}
                        </section>
                      )}
                      {state.task && state.task.state === "DONE" && (
                        <DownloadCleanupPanel taskId={state.task.taskId} />
                      )}
                    </>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}
