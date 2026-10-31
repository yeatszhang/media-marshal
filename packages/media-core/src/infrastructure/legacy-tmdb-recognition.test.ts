import { afterEach, expect, it } from "vitest";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { CoreDatabase } from "./database.js";
import { TmdbClient } from "./tmdb.js";
import { searchMatches } from "../domain/matching.js";
import { normalizeParse } from "../domain/media.js";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(handler: http.RequestListener) {
  const db = await CoreDatabase.open(":memory:"); cleanup.push(() => db.close());
  const server: Server = http.createServer(handler); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  let clock = 0;
  const create = () => { const api = new TmdbClient(db, { apiKey: "isolated-token", baseUrl, now: () => clock }); cleanup.push(() => api.close()); return api; };
  return { db, api: create(), create, expire: () => { clock += 86400001; } };
}
it("旧 fetchesTmdbSeasonStructureAndKeepsCachedDetailsIsolated", async () => {
  let calls = 0;
  const f = await fixture((_req, res) => { calls++; res.end(JSON.stringify({ id: 207347, name: "青之箱", original_name: "アオのハコ", first_air_date: "2024-10-03", seasons: [{ season_number: 1, episode_count: 37 }] })); });
  const first = await f.api.detail(207347, "TV_SHOW"); first.title = "被任务修改的标题"; first.seasons.push(99);
  expect(await f.api.detail(207347, "TV_SHOW")).toMatchObject({ title: "青之箱", seasons: [1] }); expect(calls).toBe(1);
});
it("旧 fetchesAndCachesSeasonEpisodesIncludingMissingTitles", async () => {
  let calls = 0;
  const f = await fixture((_req, res) => { calls++; res.end(JSON.stringify({ season_number: 1, episodes: [{ season_number: 1, episode_number: 26, name: "似曾相识" }, { season_number: 1, episode_number: 27, name: null }] })); });
  expect(await f.api.episodes(207347, 1)).toEqual([{ season: 1, episode: 26, title: "似曾相识" }, { season: 1, episode: 27, title: null }]);
  await f.api.episodes(207347, 1); expect(calls).toBe(1);
});
it.each([
  ["rejectsWrongSeasonInTmdbResponse", 200, { episodes: [{ season_number: 2, episode_number: 1, name: "错误季" }] }, "INVALID_RESPONSE"],
  ["tmdb404CannotBecomeAnEmptySuccessfulSeason", 404, {}, "INVALID_RESPONSE"],
  ["reportsRateLimitAndRetryDelay", 429, {}, "RATE_LIMITED"],
] as const)("旧 %s", async (_name, status, body, code) => {
  const f = await fixture((_req, res) => { res.writeHead(status, { "Retry-After": "15" }); res.end(JSON.stringify(body)); });
  await expect(f.api.episodes(207347, 1)).rejects.toMatchObject({ code, ...(status === 429 ? { retryAfterSeconds: 15 } : {}) });
  expect(f.db.connection.prepare("SELECT count(*) AS n FROM tmdb_cache").get()).toEqual({ n: 0 });
});
it("旧 readsLargeSeasonResponseAndSharesItAcrossEpisodeRequests", async () => {
  let calls = 0;
  const episodes = Array.from({ length: 59 }, (_, n) => ({ season_number: 1, episode_number: n + 1, name: `第${n + 1}集`, overview: "a".repeat(6000) }));
  const body = JSON.stringify({ season_number: 1, episodes }); expect(Buffer.byteLength(body)).toBeGreaterThan(262144);
  const f = await fixture((_req, res) => { calls++; res.end(body); });
  const [first, second] = await Promise.all([f.api.episodes(95479, 1), f.api.episodes(95479, 1)]);
  expect(first).toHaveLength(59); expect(second).toEqual(first); expect(await f.api.episodes(95479, 1)).toHaveLength(59); expect(calls).toBe(1);
});
it.each([
  ["omitsSearchYearForLaterSeasonTv", "TV_SHOW", 2, null],
  ["keepsSearchYearForFirstSeasonTv", "TV_SHOW", 1, "2025"],
  ["keepsSearchYearForMovies", "MOVIE", null, "2025"],
] as const)("旧 %s", async (_name, type, season, expected) => {
  let year: string | null | undefined;
  const f = await fixture((req, res) => { const url = new URL(req.url!, "http://test"); year = url.searchParams.get(type === "MOVIE" ? "year" : "first_air_date_year"); res.end(JSON.stringify({ results: [] })); });
  await searchMatches(normalizeParse({ title: "Movie", type: type === "MOVIE" ? "movie" : "episode", year: 2025, season }, "Movie.mkv"), { search: async (query, mediaType, year, signal) => { await f.api.search(query, mediaType, year, signal); return [{ tmdbId: 1, title: "Movie", originalTitle: null, year: 2025, mediaType }]; } });
  expect(year).toBe(expected);
});
it("旧 searchesCleanAnimeTitleWhenGuessitDidNotReturnTitle", async () => {
  const queries: string[] = [];
  const f = await fixture((req, res) => { queries.push(new URL(req.url!, "http://test").searchParams.get("query")!); res.end(JSON.stringify({ results: [{ id: 95479, name: "咒术回战", original_name: "呪術廻戦", first_air_date: "2020-10-03" }] })); });
  const result = await searchMatches(normalizeParse({ type: "episode", episode: 48, release_group: "BeanSub&FZSD" }, "[BeanSub&FZSD][Jujutsu_Kaisen][48][GB][1080P][x264_AAC].mp4"), f.api);
  expect(result[0]).toMatchObject({ tmdbId: 95479, title: "咒术回战", mediaType: "TV_SHOW" }); expect(queries).toEqual(["Jujutsu Kaisen"]);
});
it("旧 failedRequestCanBeRetriedWithoutRetainingFailedFuture 与 persistsOnlySuccessfulLoads", async () => {
  let calls = 0;
  const f = await fixture((_req, res) => { if (++calls === 1) res.writeHead(503).end("隔离故障"); else res.end(JSON.stringify({ results: [{ id: 1, title: "Movie" }] })); });
  await expect(f.api.search("Movie", "MOVIE", null)).rejects.toBeDefined(); expect(f.db.connection.prepare("SELECT count(*) AS n FROM tmdb_cache").get()).toEqual({ n: 0 });
  expect(await f.api.search("Movie", "MOVIE", null)).toHaveLength(1); expect(await f.api.search("Movie", "MOVIE", null)).toHaveLength(1); expect(calls).toBe(2);
});
it("旧 restoresTypedMetadataAcrossInstancesAndDiscardsExpiredOrCorruptEntries", async () => {
  let calls = 0;
  const f = await fixture((_req, res) => { calls++; res.end(JSON.stringify({ results: [{ id: 1, title: "Movie", release_date: "2026-01-01" }] })); });
  await f.api.search("Movie", "MOVIE", null); f.api.close();
  const restored = f.create(); expect((await restored.search("Movie", "MOVIE", null))[0]!.year).toBe(2026); expect(calls).toBe(1); restored.close();
  f.db.connection.prepare("UPDATE tmdb_cache SET value=?").run('{"corrupt":true}'); const repaired = f.create(); expect(await repaired.search("Movie", "MOVIE", null)).toHaveLength(1); expect(calls).toBe(2); repaired.close();
  f.expire(); expect(await f.create().search("Movie", "MOVIE", null)).toHaveLength(1); expect(calls).toBe(3);
});
