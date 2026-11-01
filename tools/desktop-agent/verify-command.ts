import { verificationChanges } from "./verify-changes.ts";
import { verificationPlan } from "./verify-plan.ts";
import { type Request, type Input } from "./protocol.ts";
import { startVerification } from "./verify-start.ts";
export async function verifyCommand(root: string, request: Request) {
  const input = request.payload as Input<"verify">;
  if (input.mode === "run") return startVerification(root, request);
  const plan = verificationPlan(
    verificationChanges(
      root,
      input.baseRef,
      input.changedFiles?.map((path) => path.replaceAll("\\", "/")),
    ),
    input.benchmark,
  );
  return plan;
}
