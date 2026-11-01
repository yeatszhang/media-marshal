import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMediaApplication } from "@media-marshal/media-core";
import {
  DesktopError,
  type CoreAction,
  type CoreInput,
  type CoreOutput,
} from "@media-marshal/contracts";
import type {
  PrivateCoreAction,
  PrivateCoreInput,
  PrivateCoreOutput,
} from "@media-marshal/contracts/internal/core";
import { ConfigurationDirectoryController } from "./configuration-directories";
import { DownloadRootController } from "./cloud/roots";
import { probeManagedVolume, probeReadOnlyVolume } from "./cloud/volume-probe";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const path = await realpath(await mkdtemp(join(tmpdir(), "marshal-preview-restore-")));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  const inputPath = join(path, "输入"),
    targetPath = join(path, "下载");
  await Promise.all([mkdir(inputPath), mkdir(targetPath)]);
  const input = await probeReadOnlyVolume(inputPath),
    target = await probeManagedVolume(targetPath);
  let runtime = createMediaApplication(join(path, "core.sqlite3"));
  await runtime.app.start();
  cleanup.push(() => runtime.stop());
  const core = {
    request: <K extends CoreAction>(action: K, payload: CoreInput<K>) =>
      runtime.dispatch({
        kind: "request",
        protocolVersion: 1,
        requestId: randomUUID(),
        action,
        payload,
      }) as Promise<CoreOutput<K>>,
    requestPrivate: <K extends PrivateCoreAction>(action: K, payload: PrivateCoreInput<K>) =>
      runtime.dispatchPrivate({
        kind: "core.private.request",
        requestId: randomUUID(),
        action,
        payload,
      }) as Promise<PrivateCoreOutput<K>>,
  };
  await core.requestPrivate("configuration.authorize", { kind: "ordinary", grant: input });
  await core.requestPrivate("configuration.authorize", { kind: "managed", grant: target });
  await core.request("configuration.set-default", {
    expectedVersion: 0,
    directoryId: target.id,
    requestKey: randomUUID(),
  });
  const source = await core.request("sync.save", {
    id: randomUUID(),
    expectedVersion: 0,
    expectedDraftRevision: 0,
    expectedLifecycleRevision: 0,
    requestKey: randomUUID(),
    configuration: { type: "local", name: "授权恢复", inputDirectoryId: input.id },
  });
  await runtime.stop();
  runtime = createMediaApplication(join(path, "core.sqlite3"));
  await runtime.app.start();
  const installRoot = vi.fn(async () => {}),
    roots = new DownloadRootController(core, { installRoot });
  const preview = {
    id: source.id,
    expectedVersion: source.version,
    expectedDraftRevision: source.draftRevision,
    expectedLifecycleRevision: source.lifecycleRevision,
    requestKey: randomUUID(),
  };
  return { core, roots, input, target, preview, installRoot };
}

describe.skipIf(process.platform !== "darwin")("同步预览恢复原目录授权", () => {
  it("启动时输入暂不可用，预览前重试恢复原身份，且不创建同步作业", async () => {
    const f = await fixture(),
      probe = vi
        .fn(probeReadOnlyVolume)
        .mockRejectedValueOnce(new DesktopError("LOCAL_UNAVAILABLE", "原卷暂不可用", true));
    const controller = new ConfigurationDirectoryController(f.core, f.roots, {
      ordinary: probe,
      media: probeManagedVolume,
    });
    await controller.restore();
    expect(await f.core.request("configuration.directories", {})).toContainEqual(
      expect.objectContaining({ id: f.input.id, available: false }),
    );
    await expect(f.core.request("sync.preview", f.preview)).rejects.toMatchObject({
      code: "LOCAL_UNAVAILABLE",
    });
    expect(
      await Promise.all([
        controller.prepareSyncPreview(f.preview),
        controller.prepareSyncPreview(f.preview),
      ]),
    ).toEqual([true, true]);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(probe).toHaveBeenLastCalledWith(f.input.path, f.input.id);
    await expect(f.core.request("sync.preview", f.preview)).resolves.toMatchObject({
      state: "READY",
      snapshot: { inputDirectory: { id: f.input.id }, targetDirectory: { id: f.target.id } },
    });
    expect(await f.core.request("sync.jobs", {})).toMatchObject({ total: 0 });
  });
  it("下载目录恢复同时安装传输宿主和配置读取句柄，在线预览不重复探测", async () => {
    const f = await fixture(),
      probe = vi
        .fn(probeManagedVolume)
        .mockRejectedValueOnce(new DesktopError("LOCAL_UNAVAILABLE", "下载卷暂不可用", true));
    const roots = new DownloadRootController(f.core, { installRoot: f.installRoot }, probe),
      controller = new ConfigurationDirectoryController(f.core, roots);
    await controller.restore();
    expect(await f.core.request("cloud.roots.list", {})).toMatchObject([{ state: "UNAVAILABLE" }]);
    await controller.prepareSyncPreview(f.preview);
    expect(await f.core.request("cloud.roots.list", {})).toMatchObject([
      { id: f.target.id, state: "AVAILABLE" },
    ]);
    expect(f.installRoot).toHaveBeenCalledTimes(1);
    expect(f.installRoot).toHaveBeenCalledWith(expect.objectContaining({ id: f.target.id }));
    await expect(f.core.request("sync.preview", f.preview)).resolves.toMatchObject({
      state: "READY",
    });
    await controller.prepareSyncPreview(f.preview);
    expect(probe).toHaveBeenCalledTimes(2);
  });
  it("同路径替代卷被拒绝，错误包含具体目录与下一步；恢复原卷后可再试", async () => {
    const f = await fixture(),
      probe = vi.fn(async (path: string, id?: string) => {
        const grant = await probeReadOnlyVolume(path, id);
        return { ...grant, volume: { ...grant.volume, volumeId: randomUUID() } };
      });
    const controller = new ConfigurationDirectoryController(f.core, f.roots, {
      ordinary: probe,
      media: probeManagedVolume,
    });
    await expect(controller.prepareSyncPreview(f.preview)).rejects.toMatchObject({
      code: "LOCAL_UNAVAILABLE",
      message: expect.stringContaining(f.input.path),
    });
    await expect(controller.prepareSyncPreview(f.preview)).rejects.toThrow(
      /原卷身份不一致.*重新选择并授权原目录/,
    );
    expect(await f.core.request("configuration.directories", {})).toContainEqual(
      expect.objectContaining({ id: f.input.id, available: false }),
    );
    probe.mockImplementation(probeReadOnlyVolume);
    await controller.prepareSyncPreview(f.preview);
    await expect(f.core.request("sync.preview", f.preview)).resolves.toMatchObject({
      state: "READY",
    });
  });
});
