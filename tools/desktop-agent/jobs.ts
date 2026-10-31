import { createHash, randomUUID } from "node:crypto";
import { ToolError, failure, type Request } from "./protocol.ts";

export interface Receipt {
  jobId: string;
  requestId: string;
  status: "running" | "completed" | "failed" | "unknown";
  result?: unknown;
  error?: unknown;
}
/** 由会话监管进程持有；相同请求查询原作业，不能因等待超时重发写操作。 */
export class Jobs {
  private readonly receipts = new Map<
    string,
    { fingerprint: string; receipt: Receipt; controller: AbortController }
  >();
  private readonly maximum: number;
  constructor(maximum = 256) {
    this.maximum = maximum;
  }
  start(request: Request, work: (signal: AbortSignal) => Promise<unknown>): Receipt {
    const fingerprint = createHash("sha256")
      .update(JSON.stringify([request.command, request.sessionId, request.payload]))
      .digest("hex");
    const previous = this.receipts.get(request.requestId);
    if (previous) {
      if (previous.fingerprint !== fingerprint)
        throw new ToolError(
          "REQUEST_CONFLICT",
          "原请求标识已用于不同操作",
          "查询原请求结果，新操作使用新的请求标识",
        );
      return { ...previous.receipt };
    }
    if (this.receipts.size >= this.maximum)
      throw new ToolError(
        "RECEIPTS_FULL",
        "本会话请求收据已满",
        "采集证据后停止会话，再创建新的隔离会话",
      );
    const receipt: Receipt = {
        jobId: randomUUID(),
        requestId: request.requestId,
        status: "running",
      },
      controller = new AbortController();
    this.receipts.set(request.requestId, { fingerprint, receipt, controller });
    void Promise.resolve()
      .then(() => {
        if (controller.signal.aborted)
          throw new ToolError(
            "INTERRUPTED",
            "操作在开始前已取消",
            "查询原动作收据，不自动重发",
            "unknown",
          );
        return work(controller.signal);
      })
      .then(
        (value) => {
          receipt.status = "completed";
          receipt.result = value;
        },
        (error) => {
          receipt.status = controller.signal.aborted ? "unknown" : "failed";
          receipt.error = failure(error, request).error;
        },
      );
    return { ...receipt };
  }
  get(jobId: string): Receipt {
    const value = [...this.receipts.values()].find((item) => item.receipt.jobId === jobId);
    if (!value)
      throw new ToolError(
        "JOB_NOT_FOUND",
        "当前会话未找到请求收据",
        "确认会话代际并查看动作记录，不能据此重放写操作",
        "unknown",
      );
    return { ...value.receipt };
  }
  cancel(jobId: string): Receipt {
    const receipt = this.get(jobId);
    const value = this.receipts.get(receipt.requestId)!;
    value.controller.abort();
    if (value.receipt.status === "running") value.receipt.status = "unknown";
    return { ...value.receipt };
  }
}
