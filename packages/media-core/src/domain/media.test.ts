import { describe, expect, it, vi } from "vitest";
import { assertUniqueEpisodes, normalizeParse, reconcileEpisodes, resolveSeason } from "./media";

describe("Java 名称与季集行为迁移", () => {
  it("归一化中英文标题、单集和连续合并集，技术字段保留原意", () => {
    expect(normalizeParse({ title: "黑暗骑士", year: 2008, type: "movie", screen_size: "1080p", video_codec: "H.264" }, "The.Dark.Knight.2008.mkv")).toMatchObject({ title: "黑暗骑士", year: 2008, type: "MOVIE", screenSize: "1080p", videoCodec: "H.264", episode: null });
    expect(normalizeParse({ episode: [21, 22, 23], type: "episode" }, "Show.mkv")).toMatchObject({ episode: 21, episodeEnd: 23, episodes: [21, 22, 23], type: "TV_SHOW" });
    expect(normalizeParse({ episode: 16 }, "Show.mkv")).toMatchObject({ episode: 16, episodeEnd: null, episodes: [16] });
    expect(normalizeParse({}, "未知.mp4")).toMatchObject({ title: null, type: null, season: null });
  });
  it("不继承旧 Number.intValue 的截断缺陷，缺值与错误类型不混淆", () => {
    for (const raw of [{ episode: [16, 18] }, { episode: [16, 16] }, { episode: ["16"] }, { episode: 1.2 }, { episode: 0 }, { season: [1, 2] }, { year: "2024" }, { title: ["Movie"] }, null]) expect(() => normalizeParse(raw, "Show.mkv")).toThrow();
    expect(() => normalizeParse({}, "../secret.mkv")).toThrow();
    expect(() => normalizeParse({}, "name\n.mkv")).toThrow();
  });
  it("最近名称季号优先，支持中文季号和特别篇，明确解析值不被目录覆盖", () => {
    expect(resolveSeason(0, 1, ["S02", "03.mkv"])).toBe(0);
    expect(resolveSeason(null, 3, ["剧集", "03.mkv"])).toBe(3);
    expect(resolveSeason(null, null, ["剧集", "03.mkv"])).toBe(1);
    for (const name of ["S02", "Season 02", "第二季", "第2季"]) expect(resolveSeason(null, 1, [name, "03.mkv"])).toBe(2);
    expect(resolveSeason(null, null, ["第十二季", "03.mkv"])).toBe(12);
    expect(resolveSeason(null, 1, ["S02", "某剧.S03E01.mkv"])).toBe(3);
    expect(resolveSeason(null, null, ["某剧S02E01.mkv"])).toBe(2);
    for (const name of ["Specials", "特别篇", "OVA", "SP"]) expect(resolveSeason(null, 1, [name, "03.mkv"])).toBe(0);
  });
  it("按真实集号唯一改季，保留绝对集号，合法原季不受其他季影响", async () => {
    const load = vi.fn(async (season: number) => [{ season, episode: 48, title: "累计第48集" }]);
    expect(await reconcileEpisodes({ season: 3, episode: 48, episodeEnd: null }, [0, 1], load)).toEqual({ season: 1, episode: 48, episodeEnd: null, episodeTitle: "累计第48集", changed: true });
    load.mockClear();
    expect(await reconcileEpisodes({ season: 2, episode: 48, episodeEnd: null }, [1, 2], load)).toMatchObject({ season: 2, changed: false });
    expect(load.mock.calls).toEqual([[2]]);
  });
  it("全部合并集必须存在，不能以集数总量或空标题代替实际集合", async () => {
    const coordinate = { season: 2, episode: 26, episodeEnd: 28 };
    await expect(reconcileEpisodes(coordinate, [1], async (season) => [26, 28].map((episode) => ({ season, episode, title: "" })))).rejects.toMatchObject({ code: "EPISODE_INVALID" });
    expect(coordinate.season).toBe(2);
    expect(await reconcileEpisodes(coordinate, [1], async (season) => [26, 27, 28].map((episode) => ({ season, episode, title: "" })))).toMatchObject({ season: 1, episodeEnd: 28, episodeTitle: null });
    expect(await reconcileEpisodes({ season: 1, episode: 26, episodeEnd: null }, [1], async (season) => [{ season, episode: 26, title: "" }])).toMatchObject({ episodeTitle: null });
  });
  it("歧义、特别篇、缺季列表及网络失败都阻断，不在部分证据下换季", async () => {
    const coordinate = { season: 3, episode: 48, episodeEnd: null }, load = async (season: number) => [{ season, episode: 48, title: null }];
    await expect(reconcileEpisodes(coordinate, [1, 2], load)).rejects.toMatchObject({ code: "EPISODE_INVALID" });
    await expect(reconcileEpisodes({ ...coordinate, season: 0 }, [1], load)).rejects.toMatchObject({ code: "EPISODE_INVALID" });
    await expect(reconcileEpisodes(coordinate, [], load)).rejects.toMatchObject({ code: "EPISODE_INVALID" });
    await expect(reconcileEpisodes(coordinate, [1, 2], async (season) => { if (season === 2) throw new Error("fixture-private-network-error"); return load(season); })).rejects.toMatchObject({ code: "METADATA_UNAVAILABLE" });
    await expect(reconcileEpisodes(coordinate, [1], async (season) => [await load(season), await load(season)].flat())).rejects.toMatchObject({ code: "EPISODE_INVALID" });
    expect(coordinate.season).toBe(3);
  });
  it("单条、批量和修正共用重复坐标检查，拒绝过大的无界范围", () => {
    const first = { tmdbId: 1, season: 1, episode: 1, episodeEnd: 3 };
    expect(() => assertUniqueEpisodes([first, { ...first, episode: 3, episodeEnd: 4 }])).toThrow();
    expect(() => assertUniqueEpisodes([first, { ...first, tmdbId: 2 }])).not.toThrow();
    expect(() => assertUniqueEpisodes([{ ...first, episodeEnd: Number.MAX_SAFE_INTEGER }])).toThrow();
  });
});
