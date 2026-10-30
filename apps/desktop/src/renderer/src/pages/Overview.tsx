import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useServiceState } from "@yeatz/app-framework/react";
import { ArrowRight, Check, Folder, ListTodo, Clapperboard, ShieldCheck } from "lucide-react";
import { RuntimeViewModel } from "../services";
import { Header, Empty } from "../components/shared";

export function Overview() {
  const { t, i18n } = useTranslation();
  const status = useServiceState(RuntimeViewModel, (state) => state.runtime?.status);
  const metrics = [
    { key: "sourceCount", count: status?.sourceCount, help: "sourceMetricHelp", to: "/sources", Icon: Folder },
    { key: "recognitionCount", count: status?.recognitionCount, help: "recognitionMetricHelp", to: "/recognition", Icon: ListTodo },
    { key: "taskCount", count: status?.taskCount, help: "taskMetricHelp", to: "/tasks", Icon: Clapperboard },
  ];
  const steps = [
    { title: "flowSource", help: "flowSourceHelp", to: "/sources", configured: (status?.sourceCount ?? 0) > 0 },
    { title: "flowRecognition", help: "flowRecognitionHelp", to: "/recognition", configured: (status?.recognitionCount ?? 0) > 0 },
    { title: "flowReview", help: "flowReviewHelp", to: "/review", configured: false },
  ];
  return (
    <>
      <Header title={t("greeting")} description={t("subtitle")}>
        <Link className="button button-primary" to={(status?.recognitionCount ?? 0) > 0 ? "/review" : "/sources"}>
          {t((status?.recognitionCount ?? 0) > 0 ? "flowReviewAction" : "addSource")}<ArrowRight size={16} />
        </Link>
      </Header>
      <div className="stats">
        {metrics.map(({ key, count, help, to, Icon }) => (
          <Link className="stat" key={key} to={to}>
            <div className="stat-label">{t(key)}<Icon size={18} aria-hidden="true" /></div>
            <strong>{count === undefined ? "—" : new Intl.NumberFormat(i18n.language).format(count)}</strong>
            <span>{t(help)}<ArrowRight size={14} aria-hidden="true" /></span>
          </Link>
        ))}
      </div>
      <section className="panel overview-setup" aria-labelledby="overview-flow-title">
        <div className="overview-section-heading">
          <h2 id="overview-flow-title">{t("overviewFlow")}</h2>
          <p>{t("overviewFlowHelp")}</p>
        </div>
        <ol className="setup-steps">
          {steps.map(({ title, help, to, configured }, index) => (
            <li key={title}>
              <span className={`setup-step-index${configured ? " is-configured" : ""}`} aria-hidden="true">{configured ? <Check size={18} /> : index + 1}</span>
              <div><h3>{t(title)}</h3><p>{t(help)}</p></div>
              <Link to={to}>{t(configured ? "flowConfigured" : index === 2 ? "flowReviewAction" : "flowConfigure")}<ArrowRight size={15} aria-hidden="true" /></Link>
            </li>
          ))}
        </ol>
      </section>
      <section className="panel overview-activity" aria-labelledby="overview-activity-title">
        <div className="section-title">
          <h2 id="overview-activity-title">{t("activityTitle")}</h2>
          <Link to="/tasks">{t("allTasks")}<ArrowRight size={15} /></Link>
        </div>
        {!status ? <p className="overview-status" role="status">{t("statusUnavailable")}</p> : status.taskCount > 0 ? (
          <div className="activity-summary">
            <Clapperboard size={26} aria-hidden="true" />
            <div><h3>{t("activityRecords", { count: status.taskCount })}</h3><p>{t("activityHelp")}</p></div>
          </div>
        ) : (
          <Empty icon={<ListTodo size={24} />} title={t("noTasks")} description={t("noTasksDetail")}>
            <Link className="button button-outline" to="/recognition">{t("flowRecognition")}<ArrowRight size={15} /></Link>
          </Empty>
        )}
      </section>
      <div className="privacy-note"><ShieldCheck size={15} />{t("copy")}<span>·</span>{t("localOnly")}</div>
    </>
  );
}
