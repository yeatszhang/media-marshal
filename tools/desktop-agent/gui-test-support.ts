import { join, resolve } from "node:path";
import { launchDesktop } from "../../apps/desktop/tests/support/electron.ts";
import { GuiObserver } from "./gui-observe.ts";
import { assertBuild } from "./build.ts";
import { newSession, runHome, saveSession } from "./session-store.ts";
import { identify } from "./process.ts";
import { parseRequest, type Input } from "./protocol.ts";
import { EventCollector } from "./collector.ts";
import { beginEvidence, healthEvidence, finishEvidence } from "./evidence-run.ts";
import { lifecycleEvidence } from "./evidence-capture.ts";
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
  await beginEvidence(guiRoot, session, build.manifest);
  const app = await launchDesktop(guiRoot, {
    ...session.options,
    dataDir: join(runHome(guiRoot, session.runId), "data"),
    diagnostics: { sessionId: session.sessionId, runId: session.runId, buildId: build.buildId },
  });
  session.application = identify(app.process().pid!);
  session.owner = identify(process.pid);
  session.status = "running";
  await saveSession(guiRoot, session);
  const collector = await EventCollector.create(guiRoot, session);
  collector.attach(app);
  await lifecycleEvidence(guiRoot, session, "running");
  const page = await app.firstWindow();
  await page.getByText("核心已连接", { exact: true }).waitFor();
  return { app, page, session, collector, gui: new GuiObserver(guiRoot, app, session) };
}
export async function closeGui(context: Awaited<ReturnType<typeof setupGui>>) {
  await healthEvidence(guiRoot, context.session, context.app);
  await context.app.close();
  await context.collector.close();
  await finishEvidence(guiRoot, context.session);
  context.session.status = "stopped";
  await saveSession(guiRoot, context.session);
}
