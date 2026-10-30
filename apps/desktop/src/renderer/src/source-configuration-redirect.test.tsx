// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { ContainerProvider } from "@yeatz/app-framework/react";
import type { DesktopApi } from "@media-marshal/contracts";
import { createRendererApplication } from "./services";
import { SourceConfigurationRedirect } from "./pages/SourceConfigurationRedirect";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); document.body.innerHTML = ""; });
const Destination = () => { const value = useLocation(); return <p>{value.pathname + value.search}</p>; };
it.each([true, false, null])("历史来源 claimed=%s 按所有权定位，不重新提交来源或下载", async (claimed) => {
  const id = crypto.randomUUID(), api = { listSyncSources: vi.fn(async () => claimed === null ? [] : [{ id, runtime: { claimed } }]) }, app = createRendererApplication(api as unknown as DesktopApi); await app.start();
  const element = document.createElement("div"); document.body.append(element); const root = createRoot(element); cleanup.push(async () => { await act(async () => root.unmount()); await app.stop(); });
  await act(async () => root.render(<ContainerProvider value={app.container}><MemoryRouter initialEntries={[`/sources/resolve?source=${id}`]}><Routes><Route path="/sources/resolve" element={<SourceConfigurationRedirect />} /><Route path="*" element={<Destination />} /></Routes></MemoryRouter></ContainerProvider>));
  expect(element.textContent).toBe((claimed ? "/sources" : "/sources/legacy") + "?source=" + id); expect(api.listSyncSources).toHaveBeenCalledWith({ includeDeleted: true });
});
