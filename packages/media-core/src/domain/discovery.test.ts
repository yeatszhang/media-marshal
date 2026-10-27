import { describe, expect, it } from "vitest";
import { discoveryIgnore, sampleVideos } from "./discovery";

describe("沿用旧发现忽略与样片语义", () => {
  it("默认规则在任意层级剪枝样片、索引和隐藏目录，大小写不敏感", () => {
    const ignored = discoveryIgnore();
    for (const parts of [["release", "SAMPLE"], ["other", "Samples", "clip.mkv"], ["__MACOSX", "video.mp4"], ["@eaDir", "video.mp4"], [".hidden"], ["release", ".DS_Store"], ["片名.MP4.PART"], ["Thumbs.DB"]]) expect(ignored(parts), parts.join("/")).toBe(true);
    for (const parts of [["sample-film.mp4"], ["样片电影.mp4"], ["film.sample.mp4"], ["video.mkv"]]) expect(ignored(parts)).toBe(false);
  });
  it("显式空列表关闭可配置忽略，自定义只使用提供的规则", () => {
    expect(discoveryIgnore([])(["Sample", "clip.mp4"])).toBe(false);
    expect(discoveryIgnore(["cache/"])(["Sample", "clip.mp4"])).toBe(false);
    expect(discoveryIgnore(["cache/"])(["release", "CACHE", "clip.mp4"])).toBe(true);
    expect(discoveryIgnore(["  cache\\  "])(["CACHE", "clip.mp4"])).toBe(true);
    const ignored = discoveryIgnore(["*.{mkv,mp4}", "封面?.jpg", "[ab].nfo"]);
    for (const name of ["Video.MKV", ".hidden.mp4", "封面1.jpg", "a.nfo"]) expect(ignored([name]), name).toBe(true);
    expect(ignored(["Video.avi"])).toBe(false);
  });
  it("样片必须有同目录精确基名主视频，不把独立影片或其他目录的主文件当证据", () => {
    const files = [["片名.mp4"], ["片名.SAMPLE.mkv"], ["片名-sample.mp4"], ["片名_sample.avi"], ["仅有样片.sample.mp4"], ["别处", "片名.sample.mp4"], ["Sample Movie.mp4"]];
    expect([...sampleVideos(files, (name) => /\.(mp4|mkv|avi)$/i.test(name))].sort()).toEqual(files.slice(1, 4).map((parts) => JSON.stringify(parts)).sort());
  });
});
