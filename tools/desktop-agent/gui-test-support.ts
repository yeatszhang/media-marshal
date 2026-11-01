import { join, resolve } from "node:path";
import { launchDesktop } from "../../apps/desktop/tests/support/electron.ts";
import { GuiObserver } from "./gui-observe.ts";
import { assertBuild } from "./build.ts";
import { newSession, runHome, saveSession } from "./session-store.ts";
import { identify } from "./process.ts";
import { parseRequest, type Input } from "./protocol.ts";
export const guiRoot = resolve(import.meta.dirname, "../..");
export const observeInput = (payload: object = {}) =>
  parseRequest({ command: "observe", payload }).payload as Input<"observe">;
export async function setupGui(mode: "background" | "foreground" = "background") {
  const build = await assertBuild(guiRoot, "development");
  const session = await newSession(guiRoot, {
    scenario: "empty",
    seed: "gui",
    mode,
    target: "development",
  });
  session.buildId = build.buildId;
  const app = await launchDesktop(guiRoot, {
    ...session.options,
    dataDir: join(runHome(guiRoot, session.runId), "data"),
    diagnostics: { sessionId: session.sessionId, runId: session.runId, buildId: build.buildId },
  });
  session.application = identify(app.process().pid!);
  session.owner = identify(process.pid);
  session.status = "running";
  await saveSession(guiRoot, session);
  const page = await app.firstWindow();
  await page.getByText("核心已连接", { exact: true }).waitFor();
  return { app, page, session, gui: new GuiObserver(guiRoot, app, session) };
}
