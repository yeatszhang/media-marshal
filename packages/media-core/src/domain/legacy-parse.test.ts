import { expect, it } from "vitest";
import { normalizeParse, resolveSeason } from "./media.js";

// 直接保留旧 ParseResultTest 的JSON输入和断言，不依赖Java或旧服务。
it.each([
  ["deserializesSingleEpisodeNumber", '{"episode":16}', 16, null, [16]],
  ["deserializesContiguousEpisodeArrayAsRange", '{"episode":[16,17]}', 16, 17, [16, 17]],
  ["deserializesLongContiguousEpisodeArrayAsRange", '{"episode":[21,22,23,24,25,26,27,28]}', 21, 28, [21, 22, 23, 24, 25, 26, 27, 28]],
] as const)("旧 ParseResult.%s", (_method, json, episode, episodeEnd, episodes) => {
  expect(normalizeParse(JSON.parse(json), "fixture.mkv")).toMatchObject({ episode, episodeEnd, episodes });
});
it("旧 ParseResult.rejectsNonContiguousEpisodeArray", () => { expect(() => normalizeParse(JSON.parse('{"episode":[16,18]}'), "fixture.mkv")).toThrow(); });
it("旧 defaultsToFirstSeasonAndPreservesExplicitSeasons", () => {
  const path = ["剧", "某剧", "03.mkv"];
  expect(resolveSeason(null, null, path)).toBe(1); expect(resolveSeason(2, 1, path)).toBe(2); expect(resolveSeason(0, 1, path)).toBe(0); expect(resolveSeason(null, 3, path)).toBe(3);
});
it("旧 explicitPathMarkersOverrideModelAndDefault", () => {
  for (const folder of ["S02", "Season 02", "第二季", "第2季"]) expect(resolveSeason(null, 1, ["剧", folder, "03.mkv"])).toBe(2);
  expect(resolveSeason(null, null, ["剧", "第十二季", "03.mkv"])).toBe(12);
  expect(resolveSeason(null, 1, ["剧", "S02", "某剧.S03E01.mkv"])).toBe(3);
  expect(resolveSeason(null, null, ["剧", "某剧S02E01.mkv"])).toBe(2);
  for (const folder of ["Specials", "特别篇", "OVA", "SP"]) expect(resolveSeason(null, 1, ["剧", folder, "03.mkv"])).toBe(0);
});
