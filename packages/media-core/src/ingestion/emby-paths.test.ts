import { describe, expect, it } from "vitest";
import { discoverEmbyTarget, embyServerPath, sameServerPath, serverContains } from "./emby-paths.js";

describe("Emby 全部库根发现和显式命名空间转换", () => {
  const library = (id: string, paths: string[], type: string | null = "movies") => ({ id, name: id, paths, type });
  it("目标子目录匹配具体第二库根，不把相似前缀或目录名称当作证据", () => {
    const libraries = [library("movies", ["/media/archive", "/media/movies"])];
    expect(discoverEmbyTarget({ path: "/media/movies/中文", mediaType: "MOVIE" }, libraries)).toMatchObject({ state: "MATCHED", matches: [{ libraryId: "movies", libraryPath: "/media/movies", serverPath: "/media/movies/中文" }] });
    expect(discoverEmbyTarget({ path: "/media/movies-old", mediaType: "MOVIE" }, libraries).state).toBe("UNMATCHED");
    expect(discoverEmbyTarget({ path: "/other/movies", mediaType: "MOVIE" }, libraries).state).toBe("UNMATCHED");
  });
  it("多重包含和类型冲突保留完整候选，不按顺序猜测", () => {
    const target = { path: "/media/movies/中文", mediaType: "MOVIE" as const };
    expect(discoverEmbyTarget(target, [library("a", ["/media"]), library("b", ["/media/movies"])]).state).toBe("AMBIGUOUS");
    expect(discoverEmbyTarget(target, [library("a", ["/media"], "tvshows")])).toMatchObject({ state: "TYPE_CONFLICT", matches: [], incompatible: [{ libraryId: "a" }] });
    expect(discoverEmbyTarget({ ...target, mediaType: "AUTO" }, [library("a", ["/media"], "movies")]).state).toBe("TYPE_CONFLICT");
    expect(discoverEmbyTarget({ ...target, mediaType: "AUTO" }, [library("a", ["/media"], null)]).state).toBe("MATCHED");
  });
  it("容器与 Windows 服务端保留相对目录，不按本机文件系统大小写匹配服务端", () => {
    const conversion = { localRoot: "/Volumes/媒体", serverRoot: "/data", serverPathStyle: "posix" as const };
    expect(embyServerPath("/Volumes/媒体/movies/中文.mp4", conversion)).toBe("/data/movies/中文.mp4");
    expect(discoverEmbyTarget({ path: "/Volumes/媒体/movies/中文", mediaType: "MOVIE" }, [library("a", ["/data/movies"])], conversion).state).toBe("MATCHED");
    const windows = { ...conversion, serverRoot: "D:\\媒体", serverPathStyle: "win32" as const };
    expect(embyServerPath("/Volumes/媒体/movies/中文.mp4", windows)).toBe("D:\\媒体\\movies\\中文.mp4");
    expect(serverContains("d:\\媒体\\MOVIES", "D:\\媒体\\movies\\中文.mp4", "win32")).toBe(true);
    expect(sameServerPath("/data/A.mp4", "/data/a.mp4", "posix")).toBe(false);
    expect(sameServerPath("d:\\A.mp4", "D:/a.mp4", "win32")).toBe(true);
    expect(embyServerPath("/Volumes/媒体/中文.mp4", { ...windows, serverRoot: "\\\\server\\share\\媒体" })).toBe("\\\\server\\share\\媒体\\中文.mp4");
  });
  it("拒绝转换根越界、点段、Windows 盘符相对路径和不可表示的本机名称", () => {
    const conversion = { localRoot: "/local/media", serverRoot: "/server/media", serverPathStyle: "posix" as const };
    for (const path of ["/local/media-old/a.mp4", "/local/media/../a.mp4", "/local/media/./a.mp4", "relative/a.mp4"]) expect(() => embyServerPath(path, conversion)).toThrow();
    for (const serverRoot of ["D:relative", "\\relative", "D:\\media\\..\\other"]) expect(() => embyServerPath("/local/media/a.mp4", { ...conversion, serverRoot, serverPathStyle: "win32" })).toThrow();
    for (const path of ["/local/media/a\\b.mp4", "/local/media/a:b.mp4", "/local/media/CON.mp4", "/local/media/a. "]) expect(() => embyServerPath(path, { ...conversion, serverRoot: "D:\\media", serverPathStyle: "win32" })).toThrow();
  });
});
