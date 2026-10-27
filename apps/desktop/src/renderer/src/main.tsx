import { StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ContainerProvider } from "@yeatz/app-framework/react";
import { createRendererApplication } from "./services";
import { App } from "./App";
import { i18nReady } from "./i18n";
import { rendererGeneration, rendererStop } from "./lifecycle";
import "./styles.css";

let application: ReturnType<typeof createRendererApplication> | undefined;
let root: Root | undefined;
let release: (() => void) | undefined;
let replaced = false;
const stop = rendererStop(() => root?.unmount(), async () => { try { await application?.stop(); } finally { release?.(); } });
const generation = rendererGeneration(async (isStopping) => {
  // Vite dispose 不能等待 Promise，新一代在创建容器前等待旧一代清理。
  await import.meta.hot?.data.rendererStopping;
  if (isStopping() || import.meta.hot?.data.rendererReloadPending) return false;
  await i18nReady;
  if (isStopping()) return false;
  application = createRendererApplication(window.desktopApi);
  await application.start();
  return true;
}, () => {
  root = createRoot(document.getElementById("root")!);
  root.render(<StrictMode><ContainerProvider value={application!.container}><App /></ContainerProvider></StrictMode>);
  release = window.desktopApi.onBeforeReload(() => { if (import.meta.hot) import.meta.hot.data.rendererReloadPending = true; return generation.stop(); });
}, stop);

// 在异步启动完成之前登记 dispose，覆盖启动中的 HMR 替换。
if (import.meta.hot) import.meta.hot.dispose((data) => {
  replaced = true;
  data.rendererStopping = generation.stop();
  void data.rendererStopping.catch(() => {});
});
void generation.ready.catch(() => {
  if (!replaced) document.getElementById("root")!.textContent = "界面初始化失败，请关闭窗口后重新打开。";
});
