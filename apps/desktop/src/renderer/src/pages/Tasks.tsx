import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useService, useServiceState } from "@yeatz/app-framework/react";
import { ShieldCheck, ListTodo } from "lucide-react";
import { TasksViewModel } from "../services";
import { Header, Empty, ErrorNotice } from "../components/shared";
import { Button } from "../components/ui/button";

export function Tasks({ review = false }: { review?: boolean }) {
  const { t } = useTranslation();
  const model = useService(TasksViewModel);
  const { data, loading, error } = useServiceState(model, (state) => state);
  useEffect(() => {
    void model.refresh(1, review);
  }, [model, review]);
  return (
    <>
      <Header
        title={t(review ? "review" : "tasks")}
        description={t(review ? "reviewHelp" : "tasksHelp")}
      >
        <Button
          variant="outline"
          onClick={() => {
            void model.refresh(data.page, review);
          }}
        >
          {t("reload")}
        </Button>
      </Header>
      <ErrorNotice
        message={error}
        retry={() => {
          void model.refresh(data.page, review);
        }}
      />
      <section className="panel">
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
                </tr>
              </thead>
              <tbody>
                {data.items.map((task) => (
                  <tr key={task.id}>
                    <td className="table-file" title={task.sourcePath}>
                      {task.title || task.sourcePath}
                    </td>
                    <td>{t(task.status)}</td>
                    <td>{t(task.deliveryStatus)}</td>
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
                  void model.refresh(data.page - 1, review);
                }}
              >
                {t("previous")}
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={data.page * data.pageSize >= data.total}
                onClick={() => {
                  void model.refresh(data.page + 1, review);
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
