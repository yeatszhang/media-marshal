/** 对齐旧队列统计；已提交、待复核及失败分别计数，不将PROCESSING当作文件完成。 */
interface QueueRecognitionResponse {
  task: { status: string };
}

export function summarizeRecognitionResults(
  updated: QueueRecognitionResponse[],
  skipped: { taskId: string | number; reason: string }[],
) {
  return {
    automatic: updated.filter(({ task }) => task.status === "PROCESSING" || task.status === "DONE")
      .length,
    review: updated.filter(({ task }) => task.status === "AWAITING_CONFIRMATION").length,
    failed: skipped.length + updated.filter(({ task }) => task.status === "FAILED").length,
  };
}

interface MediaTask {
  status: string;
}

export function summarizeOrganizationTasks(tasks: MediaTask[]) {
  return {
    pending: tasks.filter((task) => task.status === "PENDING" || task.status === "PROCESSING")
      .length,
    done: tasks.filter((task) => task.status === "DONE" || task.status === "CORRECTED").length,
    blocked: tasks.filter(
      (task) =>
        task.status === "AWAITING_CONFIRMATION" ||
        task.status === "FAILED" ||
        task.status === "SKIPPED",
    ).length,
  };
}
