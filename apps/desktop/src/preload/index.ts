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
      reply.error.retryAfterSeconds,
    );
  return reply.result;
}
// 此对象仅暴露具体动作，不暴露 invoke、通道名或 Electron 对象。
const api: DesktopApi = {
  listMediaLibraries: () => invoke("media.libraries", {}),
  chooseMediaTarget: (mediaType) => invoke("desktop.media.choose-target", { mediaType }),
  getEmbyConfiguration: () => invoke("emby.configuration", {}),
  listEmbyLibraries: () => invoke("emby.libraries", {}),
  connectEmby: (input) => invoke("emby.connect", input),
  retryEmby: async (taskId) => { await invoke("emby.retry", { taskId }); },
  openEmby: async (taskId) => { await invoke("desktop.emby.open", { taskId }); },
  configureManagedIngestion: (input) => invoke("desktop.ingestion.configure", input),
  listIngestionCandidates: (input) => invoke("ingestion.candidates", input),
  scanIngestion: (sourceId) => invoke("ingestion.scan", { sourceId }),
  recognizeIngestion: (input) => invoke("ingestion.recognize", input),
  getIngestionTask: (taskId) => invoke("ingestion.task", { taskId }),
  previewOrganize: (input) => invoke("ingestion.preview", input),
  confirmOrganize: (input) => invoke("ingestion.confirm", input),
  retryOrganize: async (taskId) => { await invoke("ingestion.retry", { taskId }); },
  getCloudDownloadPause: () => invoke("cloud.downloads.pause-status", {}),
  setCloudDownloadPause: (input) => invoke("cloud.downloads.set-paused", input),
  configureCloudSubscription: (input) => invoke("cloud.subscriptions.configure", input),
  listCloudSubscriptions: (input) => invoke("cloud.subscriptions.list", input),
  controlCloudSubscription: (input) => invoke("cloud.subscriptions.control", input),
  listDownloadRoots: () => invoke("cloud.roots.list", {}),
  chooseDownloadRoot: () => invoke("desktop.cloud.choose-root", {}),
  previewDownload: (input) => invoke("cloud.downloads.preview", input),
  getDownloadPreview: (requestKey) => invoke("cloud.downloads.get-preview", { requestKey }),
  confirmDownload: (input) => invoke("cloud.downloads.confirm", input),
  listDownloads: (input) => invoke("cloud.downloads.list", input),
  controlDownload: (input) => invoke("cloud.downloads.control", input),
  openDownloadDirectory: async (jobId) => { await invoke("desktop.cloud.open-completed", { jobId }); },
  listCloudAccounts: () => invoke("cloud.accounts.list", {}),
  authorizeCloudAccount: (input) => invoke("desktop.cloud.authorize", input),
  getCloudAuthorization: (requestKey) => invoke("cloud.authorizations.get", { requestKey }),
  disconnectCloudAccount: (accountId) => invoke("desktop.cloud.disconnect", { accountId }),
  restoreCloudAccounts: () => invoke("desktop.cloud.restore", {}),
  listRemote: (input) => invoke("cloud.remote.list", input),
  statRemote: (accountId, ref) => invoke("cloud.remote.stat", { accountId, ref }),
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
  prepareDesktopUpgrade: async () => { await invoke("desktop.upgrade.prepare", {}); },
  restoreDesktopUpgrade: async () => { await invoke("desktop.upgrade.restore", {}); },
  exportDiagnostics: () => invoke("desktop.diagnostics.export", {}),
};
contextBridge.exposeInMainWorld("desktopApi", api);
