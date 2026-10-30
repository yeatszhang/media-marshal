import { afterEach, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { compileSyncFilters, type SyncFilter } from "@media-marshal/contracts";

const run = promisify(execFile), cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });
it.runIf(process.platform === "darwin")("锁定 Rclone 与真实隔离目录对照清单、copy 不删除及不覆盖边界", async () => {
  const binary = resolve(`apps/desktop/resources/sidecars/${process.platform}-${process.arch}/bin/rclone`);
  const lock = JSON.parse(await readFile("tools/desktop-sidecars/sidecars.lock.json", "utf8"));
  expect(createHash("sha256").update(await readFile(binary)).digest("hex")).toBe(lock.components.rclone.assets[`${process.platform}-${process.arch}`].binary.sha256);
  const directory = await mkdtemp(join(tmpdir(), "marshal-rclone-filters-")); cleanup.push(directory);
  const source = join(directory, "source"), target = join(directory, "target"); await mkdir(source); await mkdir(target);
  const files = ["root.mp4", "root.MKV", "目录/a.mp4", "目录/nested/b.mkv", "private/a.mp4", "cache/a.mp4", "中文 空格1.mp4", "literal[1].mp4", "a+b(1).mp4", "a.txt"];
  for (const file of files) { await mkdir(dirname(join(source, file)), { recursive: true }); await writeFile(join(source, file), file); }
  const cases: SyncFilter[][] = [
    [{ action: "exclude", pattern: "/private/**", caseSensitive: true }, { action: "include", pattern: "*.{mp4,mkv}", caseSensitive: true }, { action: "exclude", pattern: "**", caseSensitive: true }],
    [{ action: "include", pattern: "/root.mp4", caseSensitive: true }, { action: "exclude", pattern: "**", caseSensitive: true }],
    [{ action: "include", pattern: "/目录/*.mp4", caseSensitive: true }, { action: "include", pattern: "literal\\[1\\].mp4", caseSensitive: true }, { action: "exclude", pattern: "**", caseSensitive: true }],
    [{ action: "exclude", pattern: "cache/", caseSensitive: true }, { action: "include", pattern: "中文 空格[0-9].mp4", caseSensitive: true }],
  ];
  for (const rules of cases) {
    const filter = join(directory, "filter.txt"); await writeFile(filter, rules.map((rule) => `${rule.action === "include" ? "+" : "-"} ${rule.pattern}`).join("\n") + "\n");
    const { stdout } = await run(binary, ["lsf", source, "--recursive", "--files-only", "--filter-from", filter, "--config", ""]);
    expect(stdout.trim().split("\n").filter(Boolean).sort()).toEqual(files.filter(compileSyncFilters(rules)).sort());
  }
  await writeFile(join(target, "keep.txt"), "保留目标"); await writeFile(join(target, "root.mp4"), "冲突保留");
  const manifest = join(directory, "files.txt"); await writeFile(manifest, "root.mp4\n中文 空格1.mp4\n");
  // --ignore-existing 是精确清单传输的额外保护；业务仍须在预览和发布时报告冲突。
  await run(binary, ["copy", source, target, "--files-from-raw", manifest, "--ignore-existing", "--config", ""]);
  expect(await readFile(join(target, "root.mp4"), "utf8")).toBe("冲突保留");
  expect(await readFile(join(target, "keep.txt"), "utf8")).toBe("保留目标");
  expect(await readFile(join(target, "中文 空格1.mp4"), "utf8")).toBe("中文 空格1.mp4");
});
