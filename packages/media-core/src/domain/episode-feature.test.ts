import { expect, it } from "vitest";
import { episodeFeature, episodeOverlap } from "./episode-feature.js";

// 来自旧 test_cluster_features_keep_hash_duplicates_ranges_and_release_names。
it.each([
  ["01.mp4", null, 1, null],
  ["01-8930371d37e8.mp4", null, 1, null],
  ["01-02.mkv", null, 1, 2],
  ["Show.A.S02E03.mkv", 2, 3, null],
  ["Show.A.S02E03E04.mkv", 2, 3, 4],
  ["Show.A.S02E03-1080p.mkv", 2, 3, null],
  ["[BeanSub&FZSD][Jujutsu_Kaisen][48][GB][1080P][x264_AAC]-4439f0c824f5.mp4", null, 48, null],
] as const)("旧坐标特征 %s", (name, season, episode, episodeEnd) => {
  expect(episodeFeature(name)).toMatchObject({ season, episode, episodeEnd });
});
it.each(["电影.2025.mkv", "01.mp4.qkdownloading", "00.mp4", "03-01.mkv", "intro.txt"])(
  "旧坐标拒绝case %s",
  (name) => {
    expect(episodeFeature(name)).toBeNull();
  },
);
it("哈希副本保留同一作品族，明确不同作品前缀拆分", () => {
  expect(episodeFeature("01-8930371d37e8.mp4")!.family).toBe(episodeFeature("01.mp4")!.family);
  expect(episodeFeature("Show.A.S01E01.mkv")!.family).not.toBe(
    episodeFeature("Show.B.S01E01.mkv")!.family,
  );
});
it("旧 detectsUnqueuedAnimeHashCopyBeforeTheFirstCopyMoves", () => {
  const original = "[BeanSub&FZSD][Jujutsu_Kaisen][49][GB][1080P][x264_AAC].mp4",
    copy = original.replace(".mp4", "-4439f0c824f5.mp4");
  expect(episodeOverlap(original, [original, copy])).toEqual({
    filename: copy,
    start: 49,
    end: 49,
  });
});
it("旧 detectsUnqueuedMergedEpisodeRangeButAllowsDifferentSeason", () => {
  const original = "Show.S01E03-E05.mkv",
    overlap = "Show.S01E04-E06.mkv",
    another = "Show.S02E04.mkv";
  expect(episodeOverlap(original, [original, overlap, another])).toEqual({
    filename: overlap,
    start: 4,
    end: 5,
  });
  expect(episodeOverlap(original, [original, another])).toBeNull();
});
