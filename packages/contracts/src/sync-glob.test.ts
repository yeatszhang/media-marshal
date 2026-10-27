import { describe, expect, it } from "vitest";
import { compileSyncFilters, syncFilterSchema } from "./index.js";

describe("有序同步路径过滤", () => {
  it("首个命中、根路径和显式包含收尾", () => {
    const rules = compileSyncFilters([{ action: "exclude", pattern: "/private/**" }, { action: "include", pattern: "*.{mkv,mp4}" }, { action: "exclude", pattern: "**" }]);
    expect(["a.mp4", "目录/a.mkv", "private/a.mp4", "目录/a.txt", "x/private/a.mp4"].map(rules)).toEqual([true, true, false, false, true]);
    expect(compileSyncFilters([{ action: "include", pattern: "*.mp4" }])("a.txt")).toBe(true);
  });
  it("单星不跨段、双星跨段、问号和字符组", () => {
    const match = (pattern: string, path: string) => compileSyncFilters([{ action: "include", pattern }, { action: "exclude", pattern: "**" }])(path);
    expect(match("/a/*.mp4", "a/b/c.mp4")).toBe(false);
    expect(match("/a/**.mp4", "a/b/c.mp4")).toBe(true);
    expect(match("/a/**/c.mp4", "a/c.mp4")).toBe(false);
    expect(match("/a/**/c.mp4", "a/b/c.mp4")).toBe(true);
    expect(match("[A-C]?中文.mp4", "B1中文.mp4")).toBe(true);
    expect(match("[^A-C]?.mp4", "D1.mp4")).toBe(true);
    expect(match("literal\\[1\\].mp4", "literal[1].mp4")).toBe(true);
    expect(match("a+b(1).mp4", "a+b(1).mp4")).toBe(true);
  });
  it("非法和未支持语法在保存前拒绝，逐规则保留大小写", () => {
    for (const pattern of ["***", "{{.*}}", "{a,{b,c}}", "[a", "[z-a]", "a\\", "a\nb", "a//b", "{a/b,c}", "[[:alpha:]]"]) expect(syncFilterSchema.safeParse({ action: "include", pattern }).success, pattern).toBe(false);
    expect(syncFilterSchema.safeParse({ action: "include", pattern: "dir/" }).success).toBe(false);
    expect(compileSyncFilters([{ action: "exclude", pattern: "cache/" }])("a/cache/1.mp4")).toBe(false);
    const rules = compileSyncFilters([{ action: "exclude", pattern: "private*", caseSensitive: true }, { action: "include", pattern: "*.MP4", caseSensitive: false }, { action: "exclude", pattern: "**" }]);
    expect(["private.mp4", "PRIVATE.mp4", "a.Mp4", "a.mkv"].map(rules)).toEqual([false, true, true, false]);
  });
  it("长通配链和特殊文件名保持有界匹配", () => {
    const rules = compileSyncFilters([{ action: "exclude", pattern: "*a".repeat(30) + "b" }]);
    expect(rules("a".repeat(1024))).toBe(true);
    expect(compileSyncFilters([{ action: "include", pattern: "中文 空格[0-9].mp4" }, { action: "exclude", pattern: "**" }])("中文 空格1.mp4")).toBe(true);
  });
});
