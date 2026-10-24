import { contextBridge, ipcRenderer } from "electron";
import {
  DESKTOP_CHANNEL,
  PROTOCOL_VERSION,
  DesktopError,
  type DesktopApi,
} from "@media-marshal/contracts";

async function invoke(action: string, payload: unknown): Promise<any> {
  const reply = await ipcRenderer.invoke(DESKTOP_CHANNEL, {
    protocolVersion: PROTOCOL_VERSION,
    requestId: crypto.randomUUID(),
    action,
    payload,
  });
  if (!reply.ok)
    throw new DesktopError(
      reply.error.code,
      reply.error.message,
      reply.error.retryable,
    );
  return reply.result;
}
// 此对象仅暴露具体动作，不暴露 invoke、通道名或 Electron 对象。
const api: DesktopApi = {
  getRuntime: () => invoke("desktop.runtime", {}),
  listSources: () => invoke("sources.list", {}),
  saveSource: (input) => invoke("sources.save", input),
  pauseSource: (id, paused) => invoke("sources.pause", { id, paused }),
  listTasks: (input) => invoke("tasks.list", input),
  listJobs: () => invoke("jobs.list", {}),
  getSettings: () => invoke("desktop.settings", {}),
  saveSettings: (input) => invoke("settings.save", input),
  saveCredential: async (kind, value) => {
    await invoke("desktop.credentials.save", { kind, value });
  },
  chooseDirectory: (purpose) => invoke("desktop.choose-directory", { purpose }),
  restartCore: async () => {
    await invoke("desktop.restart-core", {});
  },
  exportDiagnostics: () => invoke("desktop.diagnostics.export", {}),
};
contextBridge.exposeInMainWorld("desktopApi", api);
