import { useEffect } from "react";
import { HashRouter, NavLink, Route, Routes } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useService, useServiceState } from "@yeatz/app-framework/react";
import {
  ArrowRight,
  ChevronRight,
  Clapperboard,
  Cloud,
  Download,
  Folder,
  LayoutDashboard,
  ListTodo,
  LoaderCircle,
  Settings,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { SourceDraftProvider } from "./source-draft-context";
import { RecognitionDraftProvider } from "./recognition-draft-context";
import { RecognitionPage } from "./pages/Recognition";
import { SyncDraftProvider } from "./sync-draft-context";
import { SourceConfigurationRedirect } from "./pages/SourceConfigurationRedirect";
import { SyncSources } from "./pages/SyncSources";
import { RuntimeViewModel, DesktopClient } from "./services";
import { Button, cn } from "./components/ui/button";
import { ErrorNotice, Empty } from "./components/shared";
import { Overview } from "./pages/Overview";
import { Sources } from "./pages/Sources";
import { Tasks } from "./pages/Tasks";
import { CorrectionBatchDraftPage, CorrectionBatchPage, CorrectionBatchJobsPage } from "./pages/CorrectionBatches";
import { CorrectionPage, CorrectionJobsPage } from "./pages/Corrections";
import { Ingestion } from "./pages/Ingestion";
import { SettingsPage } from "./pages/SettingsPage";
import { CloudDrives } from "./pages/CloudDrives";
import { Downloads } from "./pages/Downloads";
import { Subscriptions } from "./pages/Subscriptions";
import i18n from "./i18n";

function Shell() {
  const { t } = useTranslation();
  const model = useService(RuntimeViewModel);
  const { runtime, error, restarting } = useServiceState(model, (state) => state);
  useEffect(() => model.watch(), [model]);
  const ready = runtime?.core === "ready";
  const client = useService(DesktopClient);
  useEffect(() => {
    if (!ready) return;
    let active = true;
    void client
      .getSettings()
      .then((settings) => {
        if (active) return i18n.changeLanguage(settings.language);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [client, ready]);
  const links = [
    { to: "/", name: "overview", Icon: LayoutDashboard },
    { to: "/tasks", name: "tasks", Icon: Clapperboard },
    { to: "/review", name: "review", Icon: ListTodo },
    { to: "/sources", name: "sources", Icon: Folder },
    { to: "/recognition", name: "recognitionMapping", Icon: ListTodo },
    { to: "/cloud", name: "cloud.title", Icon: Cloud },
    { to: "/downloads", name: "cloud.downloads", Icon: Download },
    { to: "/settings", name: "settings", Icon: Settings },
  ];
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-icon">
            <Clapperboard size={21} />
          </div>
          <div>
            <strong>Media Marshal</strong>
            <span>{t("local")}</span>
          </div>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <nav aria-label="主导航">
          {links.map(({ to, name, Icon }) => (
            <NavLink key={to} to={to} end={to === "/"}>
              <Icon size={18} />
              <span>{t(name)}</span>
              <ChevronRight size={13} />
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <ShieldCheck size={16} />
          <span>{t("localOnly")}</span>
          <span className="version">v{runtime?.appVersion ?? "0.1.0"}</span>
        </div>
      </aside>
      <div className="main-area">
        <header className="topbar">
          <span className="breadcrumb">
            Media Marshal<span>/</span>
            {t("independent")}
          </span>
          <div className={cn("connection", ready ? "connected" : "")}>
            <i />
            {t(ready ? "running" : (runtime?.core ?? "starting"))}
          </div>
        </header>
        <main>
          <ErrorNotice
            message={error || runtime?.detail || null}
            retry={() => {
              void model.restart();
            }}
          />
          <div className="notice migration-notice">
            <span className="notice-marker" />
            <div>
              <strong>{t("stageTitle")}</strong>
              <p>{t("stageHelp")}</p>
            </div>
          </div>
          {ready ? (
            <Routes>
              <Route path="/" element={<Overview />} />
              <Route path="/sources" element={<SyncSources />} />
              <Route path="/sources/resolve" element={<SourceConfigurationRedirect />} />
              <Route path="/sources/legacy" element={<Sources legacyOnly />} />
              <Route path="/recognition" element={<RecognitionPage />} />
              <Route path="/cloud" element={<CloudDrives />} />
              <Route path="/downloads" element={<Downloads />} />
              <Route path="/subscriptions" element={<Subscriptions />} />
              <Route path="/subscriptions/:id" element={<Subscriptions />} />
              <Route path="/tasks" element={<Tasks />} />
              <Route path="/tasks/:taskId/correction" element={<CorrectionPage />} />
              <Route path="/tasks/:taskId/correction/batch" element={<CorrectionBatchDraftPage />} />
              <Route path="/corrections/batches" element={<CorrectionBatchJobsPage />} />
              <Route path="/corrections/batches/:batchId" element={<CorrectionBatchPage />} />
              <Route path="/corrections" element={<CorrectionJobsPage />} />
              <Route path="/review" element={<Ingestion />} />
              <Route path="/settings" element={<SettingsPage />} />
            </Routes>
          ) : (
            <section className="panel">
              <Empty
                icon={
                  runtime?.core === "failed" ? (
                    <TriangleAlert size={28} />
                  ) : (
                    <LoaderCircle className="spin" size={28} />
                  )
                }
                title={t(runtime?.core === "failed" ? "failed" : "starting")}
                description={t("coreDetail")}
              >
                <Button
                  variant="outline"
                  disabled={restarting}
                  onClick={() => {
                    void model.restart();
                  }}
                >
                  {t("retry")}
                </Button>
              </Empty>
            </section>
          )}
        </main>
      </div>
    </div>
  );
}
export function App() {
  return (
    <SourceDraftProvider><SyncDraftProvider><RecognitionDraftProvider><HashRouter>
      <Shell />
    </HashRouter></RecognitionDraftProvider></SyncDraftProvider></SourceDraftProvider>
  );
}
