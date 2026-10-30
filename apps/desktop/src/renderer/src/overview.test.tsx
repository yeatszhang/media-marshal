// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ContainerProvider } from "@yeatz/app-framework/react";
import type { DesktopApi, DesktopRuntime } from "@media-marshal/contracts";
import { createRendererApplication, RuntimeViewModel } from "./services";
import { Overview } from "./pages/Overview";
import i18n, { i18nReady } from "./i18n";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  await i18n.changeLanguage("zh-CN");
  document.body.innerHTML = "";
});

async function mount(status: DesktopRuntime["status"]) {
  await i18nReady;
  const runtime: DesktopRuntime = { appVersion: "test", protocolVersion: 1, core: "ready", detail: null, status };
  const api = { getRuntime: vi.fn(async () => runtime) };
  const app = createRendererApplication(api as unknown as DesktopApi);
  await app.start();
  const model = app.container.get(RuntimeViewModel);
  await model.refresh();
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  await act(async () => root.render(<MemoryRouter><ContainerProvider value={app.container}><Overview /></ContainerProvider></MemoryRouter>));
  cleanups.push(async () => { await act(async () => root.unmount()); await app.stop(); });
  return { element, model, api, runtime };
}
const emptyStatus: NonNullable<DesktopRuntime["status"]> = { schemaVersion: 13, sourceCount: 0, recognitionCount: 0, taskCount: 0, mode: "manual-only", parser: "unavailable" };

it("首次使用提供配置入口，已有数据后更新主动作且不再显示虚假空状态", async () => {
  const f = await mount(emptyStatus);
  expect(f.element.textContent).toContain("还没有整理任务");
  expect(f.element.querySelector(".page-actions a")?.getAttribute("href")).toBe("/sources");
  f.api.getRuntime.mockResolvedValue({ ...f.runtime, status: { ...emptyStatus, sourceCount: 2, recognitionCount: 1, taskCount: 5 } });
  await act(async () => f.model.refresh());
  expect(f.element.textContent).not.toContain("还没有整理任务");
  expect(f.element.textContent).toContain("已有 5 条整理记录");
  expect(f.element.querySelector(".page-actions a")?.getAttribute("href")).toBe("/review");
  expect([...f.element.querySelectorAll(".stat")].map((a) => a.getAttribute("href"))).toEqual(["/sources", "/recognition", "/tasks"]);
  expect(f.element.querySelectorAll(".is-configured")).toHaveLength(2);
});

it("未知统计不伪装成零条任务，恢复后正常显示；英文入口保持可用", async () => {
  const f = await mount(null);
  expect(f.element.querySelector('[role="status"]')?.textContent).toContain("统计暂不可用");
  expect(f.element.textContent).not.toContain("还没有整理任务");
  expect([...f.element.querySelectorAll(".stat strong")].map((node) => node.textContent)).toEqual(["—", "—", "—"]);
  f.api.getRuntime.mockResolvedValue({ ...f.runtime, status: emptyStatus });
  await act(async () => { await f.model.refresh(); await i18n.changeLanguage("en"); });
  expect(f.element.querySelector('[role="status"]')).toBeNull();
  expect(f.element.textContent).toContain("Bring files into your library");
  expect(f.element.querySelector(".page-actions a")?.getAttribute("href")).toBe("/sources");
});
