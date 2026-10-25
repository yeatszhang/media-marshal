import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { clearPrivateSessions } from "./private-sessions";
const roots: string[] = [];
async function fixture() { const root = await mkdtemp(join(tmpdir(), "marshal-private-cleanup-")); roots.push(root); await mkdir(join(root, "sessions")); return root; }
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
describe("停止后的组件私有状态清理", () => {
  it("仅清理 session UUID 目录，不删除下载成果与其他目录", async () => {
    const root = await fixture(), session = join(root, "sessions", randomUUID()); await mkdir(session); await writeFile(join(session, "data.db"), "fixture-secret");
    const keep = join(root, "completed.mp4"); await writeFile(keep, "completed");
    await clearPrivateSessions(root);
    await expect(stat(session)).rejects.toMatchObject({ code: "ENOENT" }); expect(await readFile(keep, "utf8")).toBe("completed");
  });
  it("符号链接或 Windows 联接点不能把清理引向其他目录", async () => {
    const root = await fixture(), outside = join(root, "outside"); await mkdir(outside); await writeFile(join(outside, "keep"), "keep");
    await symlink(outside, join(root, "sessions", randomUUID()), process.platform === "win32" ? "junction" : "dir");
    await expect(clearPrivateSessions(root)).rejects.toMatchObject({ code: "CONFLICT" }); expect(await readFile(join(outside, "keep"), "utf8")).toBe("keep");
  });
});
