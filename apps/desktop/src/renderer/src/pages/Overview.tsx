import { Link } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useServiceState } from "@yeatz/app-framework/react";
import {
  Check,
  Folder,
  Clapperboard,
  FolderPlus,
  ListTodo,
  ArrowRight,
  ArrowUpRight,
  ShieldCheck,
} from "lucide-react";
import { RuntimeViewModel } from "../services";
import { Header, Empty } from "../components/shared";

export function Overview() {
  const { t } = useTranslation();
  const runtime = useServiceState(RuntimeViewModel, (state) => state.runtime);
  return (
    <>
      <Header title={t("greeting")} description={t("subtitle")} />
      <div className="stats">
        {[
          [
            "sourceCount",
            runtime?.status?.sourceCount ?? 0,
            <Folder size={19} />,
          ],
          [
            "taskCount",
            runtime?.status?.taskCount ?? 0,
            <Clapperboard size={19} />,
          ],
        ].map(([key, count, icon]) => (
          <div className="stat" key={String(key)}>
            <div className="stat-label">
              {t(String(key))}
              {icon}
            </div>
            <strong>{count}</strong>
            <span>
              {String(key) === "sourceCount" ? t("copy") : t("localOnly")}
            </span>
          </div>
        ))}
      </div>
      <section className="panel welcome">
        <div className="welcome-art">
          <FolderPlus size={48} strokeWidth={1.2} />
          <span className="art-check">
            <Check size={18} />
          </span>
        </div>
        <div>
          <span className="eyebrow">MEDIA MARSHAL</span>
          <h2>{t("getStarted")}</h2>
          <p>{t("startDetail")}</p>
          <Link className="button button-primary" to="/sources">
            {t("addSource")}
            <ArrowRight size={15} />
          </Link>
        </div>
      </section>
      <div className="section-title">
        <h2>{t("recent")}</h2>
        <Link to="/tasks">
          {t("allTasks")}
          <ArrowUpRight size={14} />
        </Link>
      </div>
      <section className="panel">
        <Empty
          icon={<ListTodo size={25} />}
          title={t("noTasks")}
          description={t("noTasksDetail")}
        />
      </section>
      <div className="privacy-note">
        <ShieldCheck size={15} />
        {t("independent")}
        <span>·</span>
        {t("noAccount")}
      </div>
    </>
  );
}
