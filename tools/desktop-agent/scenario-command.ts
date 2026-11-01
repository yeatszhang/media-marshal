import { scenarios, SCENARIO_VERSION } from "./scenarios.ts";
import { faultCatalog } from "./fault-catalog.ts";
import { startFault } from "./fault-start.ts";
import { startSession } from "./session.ts";
import { ToolError, type Request, type Input } from "./protocol.ts";
export async function dispatchScenario(root: string, request: Request) {
  const input = request.payload as Input<"scenario">;
  if (input.mode === "list")
    return {
      version: SCENARIO_VERSION,
      scenarios,
      faults: { version: 1, scenarios: faultCatalog },
    };
  if (request.sessionId)
    throw new ToolError(
      "SCENARIO_REQUIRES_FRESH_SESSION",
      "不能向现有会话直接写入场景数据",
      "不指定 --session，使用 scenario run 创建新隔离会话",
      "blocked",
    );
  if (input.mode === "fault") return startFault(root, request);
  if (input.fault)
    throw new ToolError(
      "FAULT_MODE_REQUIRED",
      "故障参数需要 mode=fault",
      "使用固定故障场景入口",
      "blocked",
    );
  if (!input.name)
    throw new ToolError("SCENARIO_NAME_REQUIRED", "运行场景需要名称", "先查询 scenario list");
  return startSession(root, {
    ...request,
    payload: {
      scenario: input.name,
      seed: input.seed,
      mode: "background",
      target: "development",
    },
  });
}
