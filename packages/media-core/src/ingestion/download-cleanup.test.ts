import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { loadNativeRename, type NativeRenameApi } from "../files/native-rename.js";
import { ManagedRoot } from "../files/index.js";
import { CoreDatabase } from "../infrastructure/database.js";
import { cleanupFixture } from "./download-cleanup-fixture.js";
import { DownloadCleanup } from "./download-cleanup.js";
import { DownloadCleanupEvidence } from "./download-cleanup-evidence.js";
import { SyncReceipts } from "../sources/sync-receipts.js";
import { DownloadCleanupService } from "./download-cleanup-service.js";
import { authorizeOrganizedDownloadCleanup } from "./download-cleanup-intents.js";

const disposals: (() => unknown | Promise<unknown>)[] = [],
  folders: string[] = [];
let native: NativeRenameApi, launch: { manifestPath: string; manifestSha256: string }, work: string;
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of disposals.splice(0).reverse()) await close();
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
describe.skipIf(process.platform !== "darwin")(
  "受管下载原件独占清理（隔离真实文件与 SQLite）",
  () => {
    beforeAll(async () => {
      work = await mkdtemp(join(tmpdir(), "marshal-cleanup-native-"));
      await promisify(execFile)(
        process.execPath,
        [resolve("tools/desktop-files/build.mjs"), "--out", join(work, "native")],
        { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30000 },
      );
      const manifestPath = join(work, "native/manifest.json");
      launch = {
        manifestPath,
        manifestSha256: createHash("sha256")
          .update(await readFile(manifestPath))
          .digest("hex"),
      };
      native = await loadNativeRename(launch);
    }, 40000);
    afterAll(async () => {
      if (work) await rm(work, { recursive: true, force: true });
    });
    async function fixture(api = native, caches?: () => Promise<void>) {
      const f = await cleanupFixture((close) => disposals.push(close));
      folders.push(f.folder);
      const plan = await f.verification.prepare(f.receiptId, null, "HISTORICAL_PREVIEW"),
        row = f.verification.journal.create(f.receiptId, null, plan),
        engine = new DownloadCleanup(f.verification, api, caches);
      disposals.push(() => engine.close());
      return {
        ...f,
        plan,
        row,
        engine,
        sourcePath: join(f.sourceGrant.path, ...f.sourceSegments),
        targetPath: join(f.targetGrant.path, ...f.targetSegments),
      };
    }
    it("完整核验后隔离与删除原件，重复执行只查询完成记录且媒体库内容保持", async () => {
      const f = await fixture(),
        a = f.engine.run(f.row.id);
      expect(f.engine.run(f.row.id)).toBe(a);
      expect(await a).toMatchObject({ phase: "DONE", freed_bytes: f.bytes.length });
      await expect(readFile(f.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(f.targetPath)).toEqual(f.bytes);
      expect(await f.engine.run(f.row.id)).toMatchObject({
        phase: "DONE",
        freed_bytes: f.bytes.length,
      });
      const receipts = new SyncReceipts(f.database),
        receipt = receipts.get(f.receiptId)!;
      expect(receipts.isCleaned(receipt.id)).toBe(true);
      expect(await receipts.observe(receipt, f.source)).toBe("REMOVED");
      expect(receipts.byResult(receipt.result_kind, receipt.result_id)).toEqual(receipt);
    });
    it("等待暂停消费者时只查需求，不在每轮调度重复读取大视频摘要", async () => {
      const f = await fixture(),
        references = vi
          .spyOn(f.engine.demands, "reasons")
          .mockReturnValue(["另一暂停规则仍保留原件"]),
        verify = vi.spyOn(f.verification, "verifyTarget"),
        confirm = vi.spyOn(ManagedRoot.prototype, "confirmRelocation");
      expect(await f.engine.run(f.row.id)).toMatchObject({ phase: "WAITING_REFERENCES" });
      expect(await f.engine.run(f.row.id)).toMatchObject({ phase: "WAITING_REFERENCES" });
      expect(verify).not.toHaveBeenCalled();
      expect(confirm).not.toHaveBeenCalled();
      references.mockRestore();
      expect(await f.engine.run(f.row.id)).toMatchObject({ phase: "DONE" });
    });
    it("图片、字幕、NFO 独立核验，混合目录保留未交付内容，只移除确实为空的子目录", async () => {
      const f = await fixture(),
        db = f.database.connection;
      async function asset(parts: string[], content: string, target: string, delivered?: string) {
        await mkdir(join(f.sourceGrant.path, "completed", ...parts.slice(0, -1)), {
          recursive: true,
        });
        await writeFile(join(f.sourceGrant.path, "completed", ...parts), content);
        if (delivered !== undefined) await writeFile(join(f.targetGrant.path, target), delivered);
        const evidence = (await f.source.inspectForRelocation(["completed", ...parts])).evidence,
          id = randomUUID();
        db.prepare(
          "INSERT INTO sync_receipt VALUES(?,'cloud','附件账户',?,'版本','{}',?,?,?, ?,?,?, 'download-item',?,'版本')",
        ).run(
          id,
          id,
          f.sourceGrant.id,
          id,
          JSON.stringify(parts),
          evidence.sha256,
          evidence.size,
          new Date().toISOString(),
          randomUUID(),
        );
        db.prepare("INSERT INTO sync_receipt_evidence VALUES(?,?)").run(
          id,
          JSON.stringify(evidence),
        );
        return { id, parts, target };
      }
      const image = await asset(["图片", "封面.jpg"], "图片内容相同", "封面.jpg", "图片内容相同"),
        nfo = await asset(["保留", "原始.nfo"], "原始元数据", "重写.nfo", "已经重写的元数据"),
        missing = await asset(["保留", "未交付.srt"], "字幕未交付", "未交付.srt");
      await writeFile(join(f.sourceGrant.path, "completed", "保留", "用户排除.ass"), "用户排除");
      for (const item of [nfo, missing])
        await expect(
          f.verification.prepare(item.id, null, "ORGANIZE", {
            id: f.targetGrant.id,
            segments: [item.target],
          }),
        ).rejects.toThrow();
      const plan = await f.verification.prepare(image.id, null, "ORGANIZE", {
          id: f.targetGrant.id,
          segments: [image.target],
        }),
        row = f.engine.journal.create(image.id, null, plan);
      expect(await f.engine.run(row.id)).toMatchObject({ phase: "DONE" });
      expect(await f.engine.run(f.row.id)).toMatchObject({ phase: "DONE" });
      await expect(lstat(join(f.sourceGrant.path, "completed", "图片"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      for (const name of ["原始.nfo", "未交付.srt", "用户排除.ass"])
        expect(await readFile(join(f.sourceGrant.path, "completed", "保留", name))).toBeDefined();
      expect(await lstat(join(f.sourceGrant.path, "completed"))).toBeDefined();
      expect(await readFile(f.targetPath)).toEqual(f.bytes);
    });
    it("历史范围确认后执行完整闭环，服务重启只恢复原日志，不认领其他旧文件", async () => {
      const f = await cleanupFixture((close) => disposals.push(close));
      folders.push(f.folder);
      const service = new DownloadCleanupService(f.database, native);
      disposals.push(() => service.close());
      const preview = service.preview({ receiptIds: [f.receiptId], requestKey: randomUUID() });
      await service.tick();
      expect(service.getPreview(preview.id).state).toBe("READY");
      await service.confirm(preview.id);
      await service.tick();
      expect(service.list({})).toMatchObject([{ phase: "DONE", freedBytes: f.bytes.length }]);
      await service.close();
      const restored = new DownloadCleanupService(f.database, native);
      disposals.push(() => restored.close());
      await restored.tick();
      expect(restored.list({})).toMatchObject([{ phase: "DONE", freedBytes: f.bytes.length }]);
      expect(await readFile(join(f.targetGrant.path, ...f.targetSegments))).toEqual(f.bytes);
    });
    it("登记清理前媒体已经修正改名，可按完整内容找到当前副本并保留其修正消费者", async () => {
      const f = await cleanupFixture((close) => disposals.push(close));
      folders.push(f.folder);
      const operation = f.organized(),
        moved = ["修正后的作品 - S01E01.mp4"],
        db = f.database.connection;
      await rename(
        join(f.targetGrant.path, ...f.targetSegments),
        join(f.targetGrant.path, ...moved),
      );
      db.prepare("UPDATE media_task SET status='CORRECTED' WHERE id=?").run(operation.taskId);
      const currentTask = randomUUID(),
        preparation = randomUUID(),
        stamp = new Date().toISOString();
      db.prepare(
        "INSERT INTO media_task(id,source_id,source_path,status,target_path,created_at,updated_at) VALUES(?,?,?,'DONE',?,?,?)",
      ).run(
        currentTask,
        operation.sourceId,
        "隔离修正成果",
        join(f.targetGrant.path, ...moved),
        stamp,
        stamp,
      );
      db.prepare(
        "INSERT INTO media_correction_preparation(id,task_id,kind,input_hash,input_json,state,created_at,updated_at) VALUES(?,?,'PREVIEW','隔离摘要','{}','PENDING',?,?)",
      ).run(preparation, currentTask, stamp, stamp);
      authorizeOrganizedDownloadCleanup(f.database, operation.operationId, operation.taskId);
      const service = new DownloadCleanupService(f.database, native);
      disposals.push(() => service.close());
      await service.tick();
      expect(service.list({ taskId: operation.taskId })).toMatchObject([
        { phase: "WAITING_REFERENCES", targetPath: join(f.targetGrant.path, ...moved) },
      ]);
      expect(await readFile(join(f.sourceGrant.path, ...f.sourceSegments))).toEqual(f.bytes);
      db.prepare("UPDATE media_correction_preparation SET state='CANCELED' WHERE id=?").run(
        preparation,
      );
      await service.tick();
      expect(service.list({ taskId: operation.taskId })).toMatchObject([{ phase: "DONE" }]);
      expect(await readFile(join(f.targetGrant.path, ...moved))).toEqual(f.bytes);
    });
    it("隔离回执丢失后只核对原 UUID 私有文件，不删除原位置的同名替代文件", async () => {
      let sourcePath = "",
        once = false;
      const api: NativeRenameApi = {
        ...native,
        renameBeneath: async (...args) => {
          const result = await native.renameBeneath(...args);
          if (result.moved && !once) {
            once = true;
            await writeFile(sourcePath, "同名替代文件保留");
            throw new Error("回执丢失");
          }
          return result;
        },
      };
      const f = await fixture(api);
      sourcePath = f.sourcePath;
      expect(await f.engine.run(f.row.id)).toMatchObject({
        phase: "NEEDS_ATTENTION",
        resume_phase: "CLAIMED",
      });
      f.engine.journal.retry(f.row.id);
      expect(await f.engine.run(f.row.id)).toMatchObject({ phase: "DONE" });
      expect(await readFile(f.sourcePath, "utf8")).toBe("同名替代文件保留");
      expect(await readFile(f.targetPath)).toEqual(f.bytes);
    });
    it("目标在最终删除前被改写时保留隔离副本，缓存失败独立重试不重复删除", async () => {
      const f = await fixture(),
        remove = ManagedRoot.prototype.removeRelocation;
      vi.spyOn(ManagedRoot.prototype, "removeRelocation").mockImplementationOnce(async function (
        this: ManagedRoot,
        ...args
      ) {
        await writeFile(f.targetPath, "目标已变更");
        return remove.apply(this, args);
      });
      expect(await f.engine.run(f.row.id)).toMatchObject({
        phase: "NEEDS_ATTENTION",
        resume_phase: "REMOVING",
        freed_bytes: 0,
      });
      expect(
        await readFile(join(f.sourceGrant.path, ...f.source.relocationSegments(f.row.id))),
      ).toEqual(f.bytes);
      await writeFile(f.targetPath, f.bytes);
      f.engine.journal.retry(f.row.id);
      expect(await f.engine.run(f.row.id)).toMatchObject({ phase: "DONE" });
      const caches = vi
          .fn()
          .mockRejectedValueOnce(new Error("缓存失败"))
          .mockResolvedValue(undefined),
        g = await fixture(native, caches);
      expect(await g.engine.run(g.row.id)).toMatchObject({
        phase: "NEEDS_ATTENTION",
        resume_phase: "CACHE_PENDING",
        freed_bytes: g.bytes.length,
      });
      g.engine.journal.retry(g.row.id);
      expect(await g.engine.run(g.row.id)).toMatchObject({ phase: "DONE" });
      expect(caches).toHaveBeenCalledTimes(2);
    });
    it("符号链接和替代来源拒绝隔离，不支持的原生能力保留原件", async () => {
      const f = await fixture();
      await rename(f.sourcePath, f.sourcePath + ".original");
      await symlink(f.sourcePath + ".original", f.sourcePath);
      expect(await f.engine.run(f.row.id)).toMatchObject({
        phase: "NEEDS_ATTENTION",
        freed_bytes: 0,
      });
      expect(await readFile(f.sourcePath + ".original")).toEqual(f.bytes);
      const g = await fixture(),
        unsupported = new DownloadCleanup(g.verification);
      disposals.push(() => unsupported.close());
      expect(await unsupported.run(g.row.id)).toMatchObject({
        phase: "NEEDS_ATTENTION",
        freed_bytes: 0,
      });
      expect(await readFile(g.sourcePath)).toEqual(g.bytes);
    });
    it("原卷暂时失联保持原阶段，原目录授权恢复后继续同一个清理作业", async () => {
      const f = await fixture();
      await rename(f.sourceGrant.path, f.sourceGrant.path + "-离线");
      expect(await f.engine.run(f.row.id)).toMatchObject({
        phase: "PENDING",
        waiting_reason: expect.stringContaining("等待原卷"),
      });
      await rename(f.sourceGrant.path + "-离线", f.sourceGrant.path);
      expect(await f.engine.run(f.row.id)).toMatchObject({ phase: "DONE" });
    });
    it("绑定变更先停止；显式重试只为同一物理副本补充当前绑定核验历史", async () => {
      const f = await fixture();
      f.database.connection
        .prepare("UPDATE emby_library SET binding_json=?")
        .run(JSON.stringify({ ...f.binding, version: 2 }));
      expect(await f.engine.run(f.row.id)).toMatchObject({
        phase: "NEEDS_ATTENTION",
        resume_phase: "PENDING",
      });
      expect(await readFile(f.sourcePath)).toEqual(f.bytes);
      f.engine.journal.retry(f.row.id);
      expect(await f.engine.run(f.row.id)).toMatchObject({ phase: "DONE" });
      expect(
        f.database.connection.prepare("SELECT state FROM download_cleanup_binding_review").get(),
      ).toEqual({ state: "APPROVED" });
      expect(JSON.parse(f.engine.journal.get(f.row.id).plan_json).binding).toBe(
        JSON.stringify(f.binding),
      );
      expect(await readFile(f.targetPath)).toEqual(f.bytes);
    });
    it.each(["CLAIMED", "QUARANTINED", "REMOVING", "AFTER_UNLINK", "SOURCE_REMOVED"])(
      "SIGKILL 于 %s，重启只恢复原阶段，库内成果和收据保持",
      async (checkpoint) => {
        const f = await fixture(),
          path = join(f.folder, "state.sqlite");
        await f.engine.close();
        f.database.close();
        const url = (file: string) => pathToFileURL(resolve("packages/media-core/dist", file)).href;
        const script = `import {CoreDatabase} from ${JSON.stringify(url("infrastructure/database.js"))};
import {DownloadCleanup} from ${JSON.stringify(url("ingestion/download-cleanup.js"))};
import {DownloadCleanupEvidence} from ${JSON.stringify(url("ingestion/download-cleanup-evidence.js"))};
import {ManagedRoot} from ${JSON.stringify(url("files/index.js"))};
import {loadNativeRename} from ${JSON.stringify(url("files/native-rename.js"))};
const db=await CoreDatabase.open(${JSON.stringify(path)}), evidence=new DownloadCleanupEvidence(db), native=await loadNativeRename(${JSON.stringify(launch)});
const advance=evidence.journal.advance.bind(evidence.journal); evidence.journal.advance=(...args)=>{const result=advance(...args);if(args[2]===${JSON.stringify(checkpoint)})process.kill(process.pid,'SIGKILL');return result;};
if(${JSON.stringify(checkpoint)}==='AFTER_UNLINK'){const remove=ManagedRoot.prototype.removeRelocation;ManagedRoot.prototype.removeRelocation=async function(...args){await remove.apply(this,args);process.kill(process.pid,'SIGKILL');};}
await new DownloadCleanup(evidence,native).run(${JSON.stringify(f.row.id)});process.exit(2);`;
        const outcome = await new Promise<{
          code: number | null;
          signal: string | null;
          stderr: string;
        }>((done, reject) => {
          const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
            stdio: ["ignore", "ignore", "pipe"],
          });
          let stderr = "";
          child.stderr.on("data", (chunk) => {
            stderr += chunk;
          });
          child.on("error", reject);
          child.on("exit", (code, signal) => done({ code, signal, stderr }));
        });
        expect(outcome, outcome.stderr).toMatchObject({ signal: "SIGKILL" });
        const db = await CoreDatabase.open(path);
        disposals.push(() => db.close());
        const engine = new DownloadCleanup(new DownloadCleanupEvidence(db), native);
        disposals.push(() => engine.close());
        expect(await engine.run(f.row.id)).toMatchObject({
          phase: "DONE",
          freed_bytes: f.bytes.length,
        });
        expect(await readFile(f.targetPath)).toEqual(f.bytes);
        expect(db.connection.prepare("SELECT count(*) AS n FROM sync_receipt").get()).toEqual({
          n: 1,
        });
      },
    );
  },
);
