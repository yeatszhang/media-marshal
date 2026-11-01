import { expect, it, vi } from "vitest";
import { DesktopError, recognitionSettingsSchema } from "@media-marshal/contracts";
import { normalizeParse } from "../domain/media.js";
import type { MetadataWork } from "../domain/matching.js";
import { CodexRecognition, codexContext } from "./codex-recognition.js";
import { identifyUsingStrategies, type RecognitionStrategyInput } from "./recognition-strategies.js";

const work = (title = "正式作品"): MetadataWork => ({ tmdbId: 1, mediaType: "TV_SHOW", title, originalTitle: title, year: 2026 });
const proposed = () => ({ status: "identified", title: "正式作品", type: "episode", confidence: 0.97, year: 2026, season: 1, episode: 1, reason: "别名经官网查证" });
function fixture() {
  const parsed = () => normalizeParse({ title: "来源别名", type: "episode", season: 1, episode: 1, year: 2026 }, "来源.S01E01.mkv");
  const settings = recognitionSettingsSchema.parse({ codexEnabled: true });
  const request = vi.fn().mockResolvedValue({ ...proposed(), clustered: false });
  const parser = { ready: true, start: async () => {}, close: async () => {}, parse: vi.fn(async () => parsed()) };
  const search = vi.fn(async (): Promise<MetadataWork[]> => [work()]);
  const input: RecognitionStrategyInput = { filename: "来源.S01E01.mkv", relative: ["作品", "S01", "来源.S01E01.mkv"], type: "AUTO", parser, tmdb: { search }, settings,
    codex: new CodexRecognition({ request, close: async () => {} }, () => settings), context: async (value) => codexContext("rule", ["作品", "S01", "来源.S01E01.mkv"], ["来源.S01E01.mkv", "来源.S01E02.mkv"], value) };
  return { input, parser, search, request, parsed };
}
it("迁移 clusterIdentityIsAppliedBeforeFilenameSearchWithoutPerFileCodex：先应用共同身份，再查询TMDB", async () => {
  const f = fixture(); f.request.mockResolvedValue({ ...proposed(), clustered: true });
  const result = await identifyUsingStrategies(f.input);
  expect(result.parsed.title).toBe("正式作品"); expect(result.matches[0]).toMatchObject({ evidence: "codex", codex: { mode: "cluster", confidence: 0.97 } });
  expect(f.request).toHaveBeenCalledTimes(1); expect(f.request.mock.calls[0]![0]).toBe("recognize-cluster");
  expect(f.search.mock.calls.every(([query]) => query === "正式作品")).toBe(true);
});
it("迁移 unknownClusterDoesNotFallBackToRepeatedIndividualModelCalls：未知簇不逐文件兜底", async () => {
  const f = fixture(); f.request.mockResolvedValue({ ...proposed(), status: "unknown", clustered: true }); f.search.mockResolvedValue([]);
  const result = await identifyUsingStrategies(f.input); expect(result.matches).toEqual([]);
  expect(result.failure).toContain("聚类未得到"); expect(f.request).toHaveBeenCalledTimes(1);
});
it("迁移 identifiedClusterStillRequiresTmdbCandidateBeforeOrganizing：模型确认仍须TMDB候选", async () => {
  const f = fixture(); f.request.mockResolvedValue({ ...proposed(), clustered: true }); f.search.mockResolvedValue([]);
  expect((await identifyUsingStrategies(f.input)).matches).toEqual([]); expect(f.request).toHaveBeenCalledTimes(1);
});
it("迁移低分兜底与正式片名搜索：有可靠TMDB结果才替换解析和原候选", async () => {
  const f = fixture(); const result = await identifyUsingStrategies(f.input);
  expect(result.parsed.title).toBe("正式作品"); expect(result.matches[0]!.evidence).toBe("codex");
  expect(f.request.mock.calls.map(([action]) => action)).toEqual(["recognize-cluster", "recognize"]);
});
it("迁移单文件兜底不降分：新建议无候选或元数据失败时保留原候选", async () => {
  for (const mode of ["empty", "error", "lower"]) {
    const f = fixture(); f.search.mockImplementation(async (query) => {
      if (query === "正式作品") { if (mode === "error") throw new Error("隔离网络故障"); return mode === "empty" ? [] : [work("完全不同")]; }
      return [work("来源别名")];
    });
    const result = await identifyUsingStrategies(f.input);
    expect(result.parsed.title).toBe("来源别名"); expect(result.matches[0]!.title).toBe("来源别名"); expect(result.matches[0]!.codex).toBeUndefined();
  }
});
it("迁移解析器故障兜底及类型不明：模型可恢复类型与正式片名", async () => {
  const f = fixture(); f.parser.parse.mockRejectedValue(new Error("隔离解析异常"));
  const result = await identifyUsingStrategies(f.input);
  expect(result.parsed).toMatchObject({ title: "正式作品", type: "TV_SHOW", episode: 1 }); expect(result.matches[0]!.codex).toBeDefined();
});
it("父目录增强只在低分时运行，失败保留原候选，关闭Codex时不调用", async () => {
  const f = fixture(); f.input.relative = ["正式作品 (2026)", "来源.S01E01.mkv"]; f.input.settings.codexEnabled = false;
  f.search.mockResolvedValue([work("来源")]);
  await identifyUsingStrategies(f.input); expect(f.parser.parse).toHaveBeenCalledTimes(1); expect(f.request).not.toHaveBeenCalled();
  f.search.mockImplementation(async (query) => { if (query.includes("正式")) throw new Error("父目录请求异常"); return [work("来")]; });
  f.parser.parse.mockImplementation(async (name) => normalizeParse({ title: name.includes("正式") ? "正式作品" : "来源别名", year: 2026, type: "episode", season: 1, episode: 1 }, name));
  expect((await identifyUsingStrategies(f.input)).matches[0]!.title).toBe("来");
});
it("模型不可用的原因可查询，取消信号不得被兜底吞掉", async () => {
  const f = fixture(); f.request.mockRejectedValue(new DesktopError("COMPONENT_UNAVAILABLE", "Codex 今日调用预算已用完")); f.search.mockResolvedValue([]);
  expect((await identifyUsingStrategies(f.input)).failure).toContain("预算");
  const controller = new AbortController(); f.input.signal = controller.signal; controller.abort();
  await expect(identifyUsingStrategies(f.input)).rejects.toBeDefined();
});
