import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import scores from "./fixtures/confidence-scores.json";
import episodes from "./fixtures/episode-reconciliation.json";
import differences from "./fixtures/intentional-differences.json";
import scopes from "./fixtures/correction-scopes.json";
import { normalizeParse, reconcileEpisodes, type EpisodeMetadata } from "./media";
import { scoreMatch, searchMatches, mergeParentEvidence, type MetadataWork, type TitleQuery } from "./matching";
import { resolveCorrectionScope, type CorrectionScope, type CorrectionTaskSnapshot } from "./correction-scope";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const snapshots = (rows: readonly Partial<CorrectionTaskSnapshot>[]) => rows.map((row) => ({ ...scopes.defaults, ...row }));
describe("旧 Java 固定输入与桌面期望的独立对照", () => {
  it.each(differences.cases)("按新规格修正旧缺陷：$id", (fixture) => {
    if (fixture.raw) expect(() => normalizeParse(fixture.raw, "固定坐标.mkv")).toThrow(expect.objectContaining({ code: fixture.desktopError }));
    else {
      const candidate = (confidence: number) => ({ tmdbId: 7, mediaType: "TV_SHOW" as const, title: "固定剧集", originalTitle: null, year: 2026, evidence: "filename" as const, score: { confidence, titleScore: 1, yearScore: 1, mediaTypeScore: 1, structureBonus: 0, bestQuery: "固定剧集", queryType: "LOCALIZED" as const } });
      expect(mergeParentEvidence([candidate(fixture.filenameConfidence!)], [candidate(fixture.parentConfidence!)])[0]?.score.confidence).toBe(fixture.desktopExpected);
    }
  });
  it.each(scores.cases)("评分：$id", async (fixture) => {
    const parsed = normalizeParse(fixture.raw, fixture.filename), queries = fixture.queries as TitleQuery[], candidate = fixture.candidate as MetadataWork;
    const result = scoreMatch(parsed, candidate, { originalFilename: fixture.filename, guessitTitle: parsed.title, titleRegion: null, queries }, fixture.matchedIndex === null ? null : queries[fixture.matchedIndex]!, fixture.resultCount);
    for (const [key, expected] of Object.entries(fixture.expected)) expect(result[key as keyof typeof fixture.expected], `${fixture.id}.${key}`).toBeCloseTo(expected, 10);
    if (fixture.id === "filtersStrongMediaTypeMismatch") expect(await searchMatches(parsed, { search: async () => [candidate] })).toEqual([]);
  });
  it.each(episodes.cases)("季集：$id", async (fixture) => {
    const original = structuredClone(fixture.coordinate), calls: number[] = [], lists = fixture.lists as Record<string, EpisodeMetadata[] | { error: string }>;
    const result = reconcileEpisodes(fixture.coordinate, fixture.seasons, async (season) => { calls.push(season); const value = lists[season]; if (value && !Array.isArray(value)) throw new Error("固定网络失败，非线上响应"); return value ?? []; });
    if (fixture.error) await expect(result).rejects.toMatchObject({ code: fixture.error }); else expect(await result).toEqual(fixture.expected);
    expect(fixture.coordinate).toEqual(original); expect(calls).toEqual(fixture.calls);
  });
  it.each(scopes.cases)("修正范围：$id", (fixture) => {
    const tasks = snapshots(fixture.members), original = structuredClone(tasks), resolve = () => resolveCorrectionScope(fixture.anchorId, fixture.scope as CorrectionScope, tasks);
    if (fixture.error) expect(resolve).toThrow(expect.objectContaining({ code: fixture.error }));
    else { const result = resolve(); expect(result.members.map((task) => task.id)).toEqual(fixture.expected); expect(result.blockers).toEqual(fixture.blockers); if ("expectedFingerprint" in fixture) expect(hash(result.evidence)).toBe(fixture.expectedFingerprint); }
    expect(tasks).toEqual(original);
  });
  it.each(scopes.mutations)("范围证据绑定 $id，不能由旧预览覆盖新快照", ({ patch }) => {
    const rows = snapshots(scopes.cases[1]!.members), before = resolveCorrectionScope("anchor", "SAME_SERIES", rows), changed = rows.map((row) => row.id === "anchor" ? { ...row, ...patch } : row);
    expect(hash(resolveCorrectionScope("anchor", "SAME_SERIES", changed).evidence)).not.toBe(hash(before.evidence));
  });
  it("输入乱序不改变范围证据，成员增加或移除会使旧预览失效", () => {
    const rows = snapshots(scopes.cases[1]!.members), before = resolveCorrectionScope("anchor", "SAME_SERIES", rows).evidence;
    expect(resolveCorrectionScope("anchor", "SAME_SERIES", [...rows].reverse()).evidence).toBe(before);
    expect(resolveCorrectionScope("anchor", "SAME_SERIES", rows.filter((task) => task.id !== "episode-10")).evidence).not.toBe(before);
    expect(resolveCorrectionScope("anchor", "SAME_SERIES", [...rows, { ...rows[0]!, id: "new-member", episode: 3 }]).evidence).not.toBe(before);
    expect(resolveCorrectionScope("anchor", "SAME_SEASON", rows).evidence).not.toBe(before);
  });
});
