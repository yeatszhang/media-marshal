import { expect, it, vi } from "vitest";
import { recognitionSettingsSchema } from "@media-marshal/contracts";
import { normalizeParse } from "../domain/media.js";
import { CodexRecognition, codexContext, codexSuggestion } from "./codex-recognition.js";

const raw = () => ({
  status: "identified",
  title: "正式作品",
  year: 2026,
  type: "episode",
  confidence: 0.97,
  reason: "官网别名依据 https://example.com/work",
  season: 2,
  episode: 9,
});
const original = () =>
  normalizeParse({ title: "来源别名", type: "episode", season: 1, episode: 3 }, "来源.S01E03.mkv");
const context = () =>
  codexContext("rule", ["作品", "S01", "来源.S01E03.mkv"], ["来源.S01E03.mkv"], original());

it("迁移 explicitSeasonAndEpisodeOverrideModelGuess：明确坐标保留，正式片名替换数字搜索词", () => {
  const result = codexSuggestion(raw(), original(), context(), "TV_SHOW", "file")!;
  expect(result.parsed).toMatchObject({
    originalFilename: "正式作品",
    title: "正式作品",
    season: 1,
    episode: 3,
    episodeEnd: null,
  });
  expect(result.evidence).toMatchObject({
    confidence: 0.97,
    mode: "file",
    reason: expect.stringContaining("https://example.com"),
  });
});
it("迁移 missingSeasonDefaultsToFirstWithoutInventingEpisode：缺省第一季，不编造集号", () => {
  const input = normalizeParse({}, "01.mkv"),
    c = codexContext("rule", ["作品", "01.mkv"], ["01.mkv"], input);
  expect(
    codexSuggestion({ ...raw(), season: null, episode: null }, input, c, "AUTO", "file")!.parsed,
  ).toMatchObject({ season: 1, episode: null });
  const special = { ...c, parents: ["特别篇", "作品"] };
  expect(
    codexSuggestion({ ...raw(), season: 2 }, input, special, "AUTO", "file")!.parsed.season,
  ).toBe(0);
});
it.each([
  { status: "unknown" },
  { confidence: 0.59 },
  { confidence: NaN },
  { type: "music" },
  { season: 1.5 },
  { title: "" },
  { title: "a".repeat(201) },
  { episode: -1 },
  { year: 1800 },
])("迁移 rejectsUnknownWeakOrInvalidResults：拒绝 $status $confidence $type", (patch) => {
  expect(codexSuggestion({ ...raw(), ...patch }, original(), context(), "AUTO", "file")).toBeNull();
});
it("迁移 respectsExplicitRuleMediaType：电影／剧集规则拒绝不同模型类型", () => {
  expect(codexSuggestion(raw(), original(), context(), "MOVIE", "file")).toBeNull();
  expect(
    codexSuggestion({ ...raw(), type: "movie" }, original(), context(), "TV_SHOW", "file"),
  ).toBeNull();
});
it("迁移 clusterScopeSharesSeriesAcrossSeasonsButNotOtherPathsOrRules：季目录共享身份，规则及作品隔离", () => {
  const build = (rule: string, folder: string, season: string) =>
    codexContext(rule, [folder, season, "01.mkv"], ["01.mkv"], original());
  expect(build("a", "作品", "S01").cluster_scope).toBe(build("a", "作品", "第三季").cluster_scope);
  expect(build("a", "作品", "S01").cluster_scope).not.toBe(build("b", "作品", "S01").cluster_scope);
  expect(build("a", "作品", "S01").cluster_scope).not.toBe(
    build("a", "另一作品", "S01").cluster_scope,
  );
});
it("迁移 contextIsBoundedToWatchedRoot 与 clusterContextMarksTruncatedSiblings：有界上下文不传绝对路径", () => {
  const c = codexContext(
    "rule",
    ["下载根", "一", "二", "三", "四", "01.mkv"],
    Array.from({ length: 81 }, (_, n) => `${n + 1}.mkv`),
    original(),
  );
  expect(c.parents).toEqual(["四", "三", "二", "一"]);
  expect(c.siblings).toHaveLength(80);
  expect(c.siblings_truncated).toBe(true);
  expect(JSON.stringify(c)).not.toContain("下载根");
});
it("迁移 disabledDoesNotCallBridge 与 movieRulesAndMissingTokenNeverRequestClusterBridge：关闭或电影不请求聚类", async () => {
  const gateway = { request: vi.fn(), close: async () => {} };
  const disabled = new CodexRecognition(gateway, () => recognitionSettingsSchema.parse({}));
  expect(await disabled.file(context(), original(), "AUTO")).toBeNull();
  expect(await disabled.cluster(context(), original(), "AUTO")).toEqual({
    clustered: false,
    suggestion: null,
  });
  const enabled = new CodexRecognition(gateway, () =>
    recognitionSettingsSchema.parse({ codexEnabled: true }),
  );
  await enabled.cluster(context(), original(), "MOVIE");
  expect(gateway.request).not.toHaveBeenCalled();
});
it("迁移 clusterBridgePreservesExplicitCoordinatesAndReturnsHandledUnknown：未知簇标记已处理", async () => {
  const gateway = {
    request: vi.fn().mockResolvedValue({ ...raw(), status: "unknown", clustered: true }),
    close: async () => {},
  };
  const engine = new CodexRecognition(gateway, () =>
    recognitionSettingsSchema.parse({ codexEnabled: true }),
  );
  expect(await engine.cluster(context(), original(), "AUTO")).toMatchObject({
    clustered: true,
    suggestion: null,
    reason: expect.any(String),
  });
});
it("迁移 directoryPreservesEachFileCoordinatesAndEpisodeRange：逐项保留坐标、原合并范围", async () => {
  const input = new Map([
    ["01.mkv", normalizeParse({ type: "episode", season: 3, episode: [48, 49] }, "01.mkv")],
    ["02.mkv", normalizeParse({}, "02.mkv")],
  ]);
  const gateway = {
    request: vi.fn().mockResolvedValue({
      ...raw(),
      files: [
        { filename: "01.mkv", season: 2, episode: 1, episode_end: null },
        { filename: "02.mkv", season: 2, episode: 5, episode_end: 6 },
      ],
    }),
    close: async () => {},
  };
  const engine = new CodexRecognition(gateway, () =>
    recognitionSettingsSchema.parse({ codexEnabled: true }),
  );
  const result = await engine.directory(context(), input, "AUTO");
  expect(result.get("01.mkv")!.parsed).toMatchObject({ season: 3, episode: 48, episodeEnd: 49 });
  expect(result.get("02.mkv")!.parsed).toMatchObject({ season: 1, episode: 5, episodeEnd: 6 });
});
it.each([
  [],
  [{ filename: "foreign.mkv" }],
  [{ filename: "01.mkv", season: 1, episode: 1, episode_end: 0 }],
])(
  "迁移 directoryRejectsMissingDuplicateForeignOrInvalidFiles：不采纳不完整目录结果",
  async (files) => {
    const engine = new CodexRecognition(
      { request: async () => ({ ...raw(), files }), close: async () => {} },
      () => recognitionSettingsSchema.parse({ codexEnabled: true }),
    );
    await expect(
      engine.directory(context(), new Map([["01.mkv", original()]]), "AUTO"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  },
);
