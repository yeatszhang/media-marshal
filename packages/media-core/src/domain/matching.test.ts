import { describe, expect, it, vi } from "vitest";
import fixtures from "./fixtures/search-plans.json";
import { normalizeParse } from "./media";
import { buildSearchPlan, mergeParentEvidence, parentContext, scoreMatch, searchMatches, titleSimilarity, type MediaMatch, type MetadataWork } from "./matching";
const parsed = (raw: unknown = {}) => normalizeParse(raw, "fixture.mkv");
const work = (input: Partial<MetadataWork> = {}): MetadataWork => ({ tmdbId: 1, mediaType: "TV_SHOW", title: "家业", originalTitle: "The Heir", year: 2026, ...input });
function candidate(tmdbId: number, confidence: number): MediaMatch { return { ...work({ tmdbId }), evidence: "filename", score: { confidence, bestQuery: "家业", queryType: "LOCALIZED", titleScore: 1, yearScore: 1, mediaTypeScore: 1, structureBonus: 0 } }; }
describe("Java 标题计划与证据迁移", () => {
  it.each(fixtures.cases)("标题计划 $id", ({ filename, raw, expected }) => {
    expect(buildSearchPlan(normalizeParse(raw, filename)).queries.map((query) => query.query)).toEqual(expected);
  });
  it("猜测标题作为最后退路去重，纯元数据不能虚构标题", () => {
    const value = normalizeParse({ title: "Jujutsu Kaisen", type: "episode", episode: 48 }, "[BeanSub][Jujutsu_Kaisen][48][GB].mp4");
    expect(buildSearchPlan(value).queries).toEqual([{ query: "Jujutsu Kaisen", type: "ORIGINAL", weight: 0.95 }]);
  });
  it("双语命中才给结构加分，电影年份严格、续季按季播出年份比较", () => {
    const movie = parsed({ title: "飞驰人生3", type: "movie", year: 2026 }), plan = { ...buildSearchPlan(movie), queries: [{ query: "飞驰人生3", type: "LOCALIZED" as const, weight: 1 }, { query: "Pegasus 3", type: "ORIGINAL" as const, weight: 0.95 }] };
    expect(scoreMatch(movie, work({ mediaType: "MOVIE", title: "飞驰人生3", originalTitle: "Pegasus 3" }), plan)).toMatchObject({ confidence: 1, bestQuery: "飞驰人生3", yearScore: 1, structureBonus: 1 });
    const show = parsed({ title: "Slow Horses", type: "episode", season: 4, episode: 1, year: 2025 }), showPlan = buildSearchPlan({ ...show, originalFilename: "Slow.Horses.S04E01.2025.mkv" });
    expect(scoreMatch(show, work({ title: "Slow Horses", originalTitle: "Slow Horses", year: 2022 }), showPlan)).toMatchObject({ yearScore: 1, structureBonus: 0 });
    expect(scoreMatch({ ...show, season: 1 }, work({ year: 2022 }), showPlan).yearScore).toBe(0);
    expect(scoreMatch(movie, work({ mediaType: "MOVIE", title: "飞驰人生3", year: 2025 }), plan).yearScore).toBe(0.3);
  });
  it("英文别名的唯一召回是弱证据，缺年份时不得保持高置信度", () => {
    const value = parsed({ title: "The Flowers of War", type: "movie", year: 2011 }), plan = { ...buildSearchPlan(value), queries: [{ query: "The Flowers of War", type: "ORIGINAL" as const, weight: 0.95 }] }, item = work({ mediaType: "MOVIE", title: "金陵十三钗", originalTitle: "金陵十三钗", year: 2011 });
    expect(scoreMatch(value, item, plan, plan.queries[0], 1).confidence).toBeCloseTo(0.8244);
    expect(scoreMatch({ ...value, year: null }, item, plan, plan.queries[0], 1).confidence).toBeLessThan(0.45);
    expect(scoreMatch(value, item, plan, plan.queries[0], 10).titleScore).toBe(0);
  });
  it("父目录只接受带发行线索的有效名称，同季号才补充证据", () => {
    const value = parsed({ title: "The Heir", type: "episode", season: 1, episode: 25 });
    expect(parentContext("家业.The.Heir.S01.2026.2160p.WEB-DL", value)).toMatchObject({ titleRegion: "家业 The Heir" });
    for (const name of ["TV Shows", "家业", "家业.The.Heir.S02.2026.WEB-DL", "Season 01", "Movies.2026"]) expect(parentContext(name, value)).toBeNull();
    expect(parentContext("家业.The.Heir.S01.2026.WEB-DL", { ...value, season: null })).toBeNull();
  });
  it("父目录单独命中、同 ID 但文件名仅弱证据仍被限权；相互强证据才加分", () => {
    expect(mergeParentEvidence([], [candidate(1, 0.92)])[0]).toMatchObject({ score: { confidence: 0.75 }, evidence: "parent", parentOnlyCapped: true });
    expect(mergeParentEvidence([candidate(1, 0.3)], [candidate(1, 0.9)])[0]).toMatchObject({ score: { confidence: 0.75 }, filenameConfidence: 0.3, parentConfidence: 0.9, parentOnlyCapped: true });
    expect(mergeParentEvidence([candidate(1, 0.65)], [candidate(1, 0.9)])[0]!.score.confidence).toBeCloseTo(0.95);
    expect(mergeParentEvidence([candidate(1, 0.72)], [candidate(2, 0.95)]).map((value) => value.score.confidence)).toEqual([0.75, 0.72]);
  });
  it("无结果时去年份重试，同 ID 多查询仅保留最高分，类型不符被拒绝", async () => {
    const value = normalizeParse({ title: "Movie", year: 2026, type: "movie" }, "Movie.2026.mkv"), search = vi.fn(async (_query: string, _type: string, year: number | null) => year ? [] : [work({ title: "Movie", mediaType: "MOVIE" }), work({ tmdbId: 2, mediaType: "TV_SHOW" })]);
    const results = await searchMatches(value, { search }); expect(results).toHaveLength(1); expect(results[0]?.tmdbId).toBe(1); expect(search.mock.calls.map((call) => call[2])).toEqual([2026, null]);
    search.mockClear(); await searchMatches({ ...value, type: "TV_SHOW", season: 2 }, { search }); expect(search.mock.calls[0]?.[2]).toBeNull();
    const empty = await searchMatches(value, { search: async () => [] }); expect(empty).toEqual([]);
    await expect(searchMatches(value, { search: async () => { throw new Error("fixture unavailable"); } })).rejects.toThrow();
  });
  it("相似度保留 Unicode 归一化和最长公共子序列，超长标题不截断后误报满分", () => {
    expect(titleSimilarity("Café.Movie", "Cafe Movie")).toBe(1); expect(titleSimilarity("abc", "axc")).toBeCloseTo(2 / 3);
    expect(() => titleSimilarity("a".repeat(513), "a".repeat(513) + "b")).toThrow();
  });
});
