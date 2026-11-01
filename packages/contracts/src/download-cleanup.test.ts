import { expect, it } from "vitest";
import { downloadCleanupActions, downloadCleanupSchema } from "./download-cleanup.js";

const id = "e092d395-163b-4fc3-bb9e-bc27ede378c1";
it("清理动作只接受业务身份和明确范围，拒绝任意删除路径、私有授权及过量选择", () => {
  expect(downloadCleanupActions["cleanup.preview"].input.safeParse({ receiptIds: [id], requestKey: id }).success).toBe(true);
  expect(downloadCleanupActions["cleanup.preview"].input.safeParse({ receiptIds: [id], requestKey: id, sourcePath: "/任意文件" }).success).toBe(false);
  expect(downloadCleanupActions["cleanup.preview"].input.safeParse({ receiptIds: Array(51).fill(id), requestKey: id }).success).toBe(false);
  expect(downloadCleanupActions["cleanup.confirm"].input.safeParse({ id, grant: { path: "/任意目录" } }).success).toBe(false);
  expect(downloadCleanupActions["cleanup.retry"].input.safeParse({ id, targetPath: "/其他媒体" }).success).toBe(false);
});
it("持久清理反馈保留可定位对象、等待原因和独立释放大小", () => {
  const row = downloadCleanupSchema.parse({ id, receiptId: id, taskId: null, phase: "WAITING_REFERENCES", resumePhase: null, sourcePath: "/受管下载/completed/01.mp4", targetPath: "/媒体库/作品 - S01E01.mp4", size: 1234, freedBytes: 0, waitingReason: "另一识别规则暂停，仍保留需求", failure: null, updatedAt: new Date().toISOString() });
  expect(row).toMatchObject({ kind: "SOURCE", freedBytes: 0, waitingReason: expect.stringContaining("暂停") });
  expect(downloadCleanupSchema.safeParse({ ...row, freedBytes: -1 }).success).toBe(false);
});
