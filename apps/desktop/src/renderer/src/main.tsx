import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ContainerProvider } from "@yeatz/app-framework/react";
import { createRendererApplication } from "./services";
import { App } from "./App";
import { i18nReady } from "./i18n";
import "./styles.css";

async function bootstrap() {
  await i18nReady;
  const application = createRendererApplication(window.desktopApi);
  await application.start();
  const root = createRoot(document.getElementById("root")!);
  root.render(
    <StrictMode>
      <ContainerProvider value={application.container}>
        <App />
      </ContainerProvider>
    </StrictMode>,
  );
  const stop = async () => {
    root.unmount();
    await application.stop();
  };
  if (import.meta.hot)
    import.meta.hot.dispose(() => {
      void stop();
    });
}
void bootstrap().catch(() => {
  document.getElementById("root")!.textContent =
    "界面初始化失败，请关闭窗口后重新打开。";
});
