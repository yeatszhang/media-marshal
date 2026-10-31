import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ContainerProvider } from "@yeatz/app-framework/react";
import { createRendererApplication } from "./services";
import { App } from "./App";
import { i18nReady } from "./i18n";
import { rendererGeneration, rendererStop } from "./lifecycle";
import { logger } from "./logger";
import "./styles.css";
import "./configuration.css";

let application: ReturnType<typeof createRendererApplication> | undefined;
let root: Root | undefined;
let release: (() => void) | undefined;
let replaced = false;
const onError = (event: ErrorEvent) => logger.error({ error: event.error }, "界面发生未捕获异常");
const onRejection = (event: PromiseRejectionEvent) => logger.error({ error: event.reason instanceof Error ? event.reason : undefined }, "界面异步任务未处理异常");
window.addEventListener("error", onError);
window.addEventListener("unhandledrejection", onRejection);
const stop = rendererStop(() => root?.unmount(), async () => { try { await application?.stop(); } finally { release?.(); } });
const generation = rendererGeneration(async (isStopping) => {
  // Vite dispose 不能等待 Promise，新一代在创建容器前等待旧一代清理。
  await import.meta.hot?.data.rendererStopping;
  if (isStopping() || import.meta.hot?.data.rendererReloadPending) return false;
  await i18nReady;
  if (isStopping()) return false;
  application = createRendererApplication(window.desktopApi);
  logger.info({ event: "renderer.start" }, "界面正在启动");
  await application.start();
  return true;
}, () => {
  root = createRoot(document.getElementById("root")!);
  root.render(<StrictMode><ContainerProvider value={application!.container}><App /></ContainerProvider></StrictMode>);
  logger.info({ event: "renderer.ready" }, "界面已挂载");
  release = window.desktopApi.onBeforeReload(() => { if (import.meta.hot) import.meta.hot.data.rendererReloadPending = true; return generation.stop(); });
}, stop);

// 在异步启动完成之前登记 dispose，覆盖启动中的 HMR 替换。
if (import.meta.hot) import.meta.hot.dispose((data) => {
  replaced = true;
  window.removeEventListener("error", onError);
  window.removeEventListener("unhandledrejection", onRejection);
  data.rendererStopping = generation.stop();
  void data.rendererStopping.catch(() => {});
});
void generation.ready.catch((error) => {
  logger.error({ error }, "界面初始化失败");
  if (!replaced) document.getElementById("root")!.textContent = "界面初始化失败，请关闭窗口后重新打开。";
});
