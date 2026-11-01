import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { closeGui, setupGui, guiRoot as root } from "./gui-test-support.ts";
import { runHome } from "./session-store.ts";
import { NativeProbe, untilNative } from "./native-test-support.ts";
import type { DesktopApi } from "@media-marshal/contracts";
test(
  "真实系统目录选择与取消，选择后保存隔离目录并返回焦点",
  { timeout: 120000, skip: process.platform !== "darwin" },
  async () => {
    const context = await setupGui("foreground"),
      probe = await NativeProbe.create(context);
    try {
      await probe.send("activate");
      await probe.frontmost();
      await context.page.getByRole("link", { name: "设置", exact: true }).click();
      const panel = context.page.getByRole("region", { name: "本地下载目录", exact: true });
      const choose = panel.getByRole("button", { name: "选择本地下载目录", exact: true });
      await choose.click();
      await untilNative(
        () => probe.observe(),
        (value) =>
          value.nodes.some((node) => node.role === "AXButton" && /^(取消|Cancel)$/.test(node.name)),
      );
      await probe.send(
        "press",
        (node) => node.role === "AXButton" && /^(取消|Cancel)$/.test(node.name),
      );
      await untilNative(() => choose.isEnabled(), Boolean);
      assert.equal(
        await panel.getByRole("button", { name: "保存下载目录", exact: true }).isDisabled(),
        true,
      );
      assert.equal(
        await context.page
          .evaluate(() =>
            (
              window as unknown as { desktopApi: DesktopApi }
            ).desktopApi.getDefaultDownloadDirectory(),
          )
          .then((value) => value.directory),
        null,
      );
      await probe.frontmost();
      await probe.record("assertion", { source: "native", cancelKeptDefault: true });
      const selected = join(runHome(root, context.session.runId), "native-selected");
      await mkdir(selected);
      await choose.click();
      await untilNative(
        () => probe.observe(),
        (value) =>
          value.nodes.some((node) => node.role === "AXButton" && /^(取消|Cancel)$/.test(node.name)),
      );
      await probe.send("key", undefined, { key: "Command+Shift+G" });
      await untilNative(
        () => probe.observe(),
        (value) =>
          value.nodes.some(
            (node) => ["AXTextField", "AXComboBox"].includes(node.role) && node.focused,
          ),
      );
      await probe.send(
        "fill",
        (node) => ["AXTextField", "AXComboBox"].includes(node.role) && node.focused && !node.secure,
        { text: selected },
      );
      await probe.send("key", undefined, { key: "Enter" });
      await untilNative(
        () => probe.observe(),
        (value) =>
          !value.nodes.some(
            (node) => ["AXTextField", "AXComboBox"].includes(node.role) && node.focused,
          ),
      );
      await probe.send(
        "press",
        (node) =>
          node.role === "AXButton" && /^(打开|选择|Open|Choose|选择文件夹)$/.test(node.name),
      );
      await untilNative(
        () => panel.textContent(),
        (value) => !!value?.includes(selected),
      );
      await panel.getByRole("button", { name: "保存下载目录", exact: true }).click();
      await untilNative(
        () =>
          context.page.evaluate(() =>
            (
              window as unknown as { desktopApi: DesktopApi }
            ).desktopApi.getDefaultDownloadDirectory(),
          ),
        (value) => value.directory?.path === selected,
      );
      await probe.frontmost();
      assert.equal(await context.page.evaluate(() => document.hasFocus()), true);
      await probe.record("assertion", {
        source: "native",
        selectionSaved: true,
        focusReturned: true,
      });
      await probe.finish();
    } catch (error) {
      await probe.finish(error);
      throw error;
    } finally {
      await closeGui(context);
    }
  },
);
