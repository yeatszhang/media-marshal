import { useEffect } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useService, useServiceState } from "@yeatz/app-framework/react";
import { ShieldCheck, ListTodo } from "lucide-react";
import { TasksViewModel } from "../services";
import { Header, Empty, ErrorNotice } from "../components/shared";
import { Button } from "../components/ui/button";
import { taskStatusSchema } from "@media-marshal/contracts";

export function Tasks({ review = false }: { review?: boolean }) {
  const { t } = useTranslation();
  const model = useService(TasksViewModel);
  const navigate = useNavigate();
  const { data, loading, error, queryError, filter, busy } = useServiceState(model, (state) => state);
  useEffect(() => model.watch(review ? "AWAITING_CONFIRMATION" : undefined), [model, review]);
  return (
    <>
      <Header
        title={t(review ? "review" : "tasks")}
        description={t(review ? "reviewHelp" : "tasksHelp")}
      >
        <Button
          variant="outline"
          onClick={() => {
            void model.refresh();
          }}
        >
          {t("reload")}
        </Button>
      </Header>
      <ErrorNotice
        message={error ?? queryError}
        retry={() => {
          void model.refresh();
        }}
      />
      <section className="panel">
        {!review && <label className="task-filter">文件状态<select aria-label="筛选任务状态" value={filter} onChange={(event) => { void model.refresh(1, event.target.value ? taskStatusSchema.parse(event.target.value) : ""); }}><option value="">全部文件状态</option>{taskStatusSchema.options.map((status) => <option key={status} value={status}>{t(status)}</option>)}</select></label>}
        {loading ? (
          <div className="loading" role="status">
            {t("loading")}
          </div>
        ) : data.items.length ? (
          <>
            <table>
              <thead>
                <tr>
                  <th>{t("file")}</th>
                  <th>{t("status")}</th>
                  <th>{t("delivery")}</th>
                  <th>{t("ingestion.action")}</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((task) => (
                  <tr key={task.id}>
                    <td className="table-file" title={task.sourcePath}>
                      {task.title || task.sourcePath}
                      <small><Link to={`/sources?source=${task.sourceId}`}>来源配置</Link></small>
                    </td>
                    <td>{t(task.status)}</td>
                    <td>{t(task.deliveryStatus)}</td>
                    <td><div className="download-controls"><Button variant="outline" size="sm" onClick={() => navigate("/review", { state: { taskId: task.id } })}>{t("ingestion.inspect")}</Button>{task.status === "DONE" && (task.deliveryStatus === "COLLECTED" ? <Button variant="outline" size="sm" disabled={busy.includes(task.id)} onClick={() => { void model.delivery(task.id, true); }}>{t("ingestion.openEmby")}</Button> : <Button variant="outline" size="sm" disabled={busy.includes(task.id)} onClick={() => { void model.delivery(task.id); }}>{t("ingestion.deliveryRetry")}</Button>)}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="pagination">
              <span>{t("page", { page: data.page, total: data.total })}</span>
              <Button
                variant="outline"
                size="sm"
                disabled={data.page <= 1}
                onClick={() => {
                  void model.refresh(data.page - 1);
                }}
              >
                {t("previous")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={data.page * data.pageSize >= data.total}
                onClick={() => {
                  void model.refresh(data.page + 1);
                }}
              >
                {t("next")}
              </Button>
            </div>
          </>
        ) : (
          <Empty
            icon={review ? <ShieldCheck size={28} /> : <ListTodo size={28} />}
            title={t(review ? "noReview" : "noTasks")}
            description={t(review ? "noReviewDetail" : "noTasksDetail")}
          />
        )}
      </section>
    </>
  );
}
