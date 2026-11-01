import { verificationChanges } from "./verify-changes.ts";
import { verificationPlan } from "./verify-plan.ts";
import { ToolError, type Request, type Input } from "./protocol.ts";
export async function verifyCommand(root: string, request: Request) {
  const input = request.payload as Input<"verify">;
  const plan = verificationPlan(
    verificationChanges(
      root,
      input.baseRef,
      input.changedFiles?.map((path) => path.replaceAll("\\", "/")),
    ),
    input.benchmark,
  );
  if (input.mode === "plan") return plan;
  throw new ToolError(
    "VERIFY_RUN_UNAVAILABLE",
    "检查计划已生成，执行器尚未接入",
    "先检查计划，实施任务 2.17 的执行与性能部分后重试",
    "blocked",
  );
}
