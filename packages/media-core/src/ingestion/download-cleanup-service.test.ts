import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { cleanupFixture } from "./download-cleanup-fixture.js";
import { DownloadCleanupService } from "./download-cleanup-service.js";
import { authorizeOrganizedDownloadCleanup } from "./download-cleanup-intents.js";

const disposals: (() => unknown | Promise<unknown>)[] = [],
  folders: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of disposals.splice(0).reverse()) await close();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function fixture() {
  const f = await cleanupFixture((close) => disposals.push(close));
  folders.push(f.folder);
  let clock = Date.now();
  const service = new DownloadCleanupService(f.database, undefined, () => clock);
  disposals.push(() => service.close());
  return {
    ...f,
    service,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
describe("清理调度与历史范围授权", () => {
  it("取消读取中的预览会中止该预览的读取，不生成清理日志或改变文件", async () => {
    const f = await fixture();
    let started!: () => void, signal: AbortSignal | undefined;
    const ready = new Promise<void>((done) => {
      started = done;
    });
    vi.spyOn(f.service.evidence, "prepare").mockImplementation(
      async (_receipt, _task, _authorization, _target, current) => {
        signal = current;
        started();
        await new Promise<void>((_done, reject) =>
          current!.addEventListener("abort", () => reject(new Error("已取消读取")), { once: true }),
        );
        throw new Error("取消后不能建立计划");
      },
    );
    const preview = f.service.preview({ receiptIds: [f.receiptId], requestKey: randomUUID() });
    await ready;
    f.service.cancel(preview.id);
    expect(signal?.aborted).toBe(true);
    await f.service.tick();
    expect(f.service.getPreview(preview.id).state).toBe("CANCELLED");
    expect(f.service.list({})).toEqual([]);
    expect(await readFile(join(f.sourceGrant.path, ...f.sourceSegments))).toEqual(f.bytes);
  });
  it("启动不接管旧成果，列表与查询只读，取消准备好的历史预览不删除文件", async () => {
    const f = await fixture();
    f.organized();
    await f.service.tick();
    expect(f.service.list({})).toEqual([]);
    expect(f.service.scope({})).toEqual([
      {
        receiptId: f.receiptId,
        sourcePath: join(f.sourceGrant.path, ...f.sourceSegments),
        size: f.bytes.length,
      },
    ]);
    const preview = f.service.preview({ receiptIds: [f.receiptId], requestKey: randomUUID() });
    await f.service.tick();
    expect(f.service.getPreview(preview.id)).toMatchObject({
      state: "READY",
      items: [{ receiptId: f.receiptId, size: f.bytes.length }],
    });
    f.service.cancel(preview.id);
    await expect(f.service.confirm(preview.id)).rejects.toThrow();
    await f.service.tick();
    expect(f.service.list({})).toEqual([]);
    expect(await readFile(join(f.sourceGrant.path, ...f.sourceSegments))).toEqual(f.bytes);
  });
  it("过期与 Emby 绑定改变阻止确认，伪造业务 ID 不会获得路径删除权限", async () => {
    const f = await fixture(),
      preview = f.service.preview({ receiptIds: [f.receiptId], requestKey: randomUUID() });
    await f.service.tick();
    f.advance(16 * 60 * 1000);
    await expect(f.service.confirm(preview.id)).rejects.toThrow(/过期/);
    const next = f.service.preview({ receiptIds: [f.receiptId], requestKey: randomUUID() });
    await f.service.tick();
    f.database.connection.prepare("UPDATE emby_connection SET version=2").run();
    await expect(f.service.confirm(next.id)).rejects.toThrow();
    const forged = f.service.preview({ receiptIds: [randomUUID()], requestKey: randomUUID() });
    await f.service.tick();
    expect(f.service.getPreview(forged.id).state).toBe("BLOCKED");
    expect(f.service.list({})).toEqual([]);
    expect(await readFile(join(f.sourceGrant.path, ...f.sourceSegments))).toEqual(f.bytes);
  });
  it("只有新整理确认登记清理意图，核验结果与失败可查询，重试不会改变 DONE 或交付状态", async () => {
    const f = await fixture(),
      operation = f.organized();
    authorizeOrganizedDownloadCleanup(f.database, operation.operationId, operation.taskId);
    expect(f.service.list({ taskId: operation.taskId })).toMatchObject([
      { phase: "PENDING", waitingReason: expect.stringContaining("等待") },
    ]);
    await f.service.tick();
    expect(f.service.list({ taskId: operation.taskId })).toMatchObject([
      { phase: "NEEDS_ATTENTION", failure: expect.stringContaining("可信独占改名组件") },
    ]);
    const row = f.service.list({ taskId: operation.taskId })[0]!;
    f.service.retry(row.id);
    await f.service.tick();
    expect(
      f.database.connection
        .prepare("SELECT status FROM media_task WHERE id=?")
        .get(operation.taskId),
    ).toEqual({ status: "DONE" });
    expect(await readFile(join(f.sourceGrant.path, ...f.sourceSegments))).toEqual(f.bytes);
  });
});
