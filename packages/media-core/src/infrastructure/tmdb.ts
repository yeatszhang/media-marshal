import { createHash } from "node:crypto";
import { HttpsProxyAgent } from "https-proxy-agent";
import { z } from "zod";
import type { CoreDatabase } from "./database.js";
import { MediaNetworkError, requestJson } from "./json-http.js";
import type { MetadataSearch, MetadataWork } from "../domain/matching.js";
import type { EpisodeMetadata } from "../domain/media.js";

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER), text = z.string().max(500), date = z.string().max(32).nullable().optional();
const rawWork = z.object({ id: positive, title: text.optional(), name: text.optional(), original_title: text.nullable().optional(), original_name: text.nullable().optional(), release_date: date, first_air_date: date, overview: z.string().max(32768).optional(),
  genres: z.array(z.object({ id: positive, name: text })).max(100).optional(), production_countries: z.array(z.object({ iso_3166_1: z.string().max(8), name: text })).max(100).optional(), origin_country: z.array(z.string().max(8)).max(100).optional(),
  seasons: z.array(z.object({ season_number: z.number().int().min(0).max(999) })).max(1000).optional() });
function workSchema(type: "MOVIE" | "TV_SHOW") { return rawWork.refine((row) => !!(type === "MOVIE" ? row.title : row.name)?.trim(), "作品缺少有效标题"); }
function mapWork(row: z.infer<typeof rawWork>, mediaType: "MOVIE" | "TV_SHOW"): MetadataWork {
  const date = mediaType === "MOVIE" ? row.release_date : row.first_air_date, year = date && /^\d{4}(?:-|$)/.test(date) ? Number(date.slice(0, 4)) : null;
  return { tmdbId: row.id, mediaType, title: (mediaType === "MOVIE" ? row.title : row.name)!.trim(), originalTitle: (mediaType === "MOVIE" ? row.original_title : row.original_name)?.trim() || null, year: year && year > 0 ? year : null, overview: row.overview ?? "", genres: row.genres?.map((value) => value.name) ?? [], country: row.production_countries?.[0]?.iso_3166_1 ?? row.origin_country?.[0] ?? null };
}
interface Flight { controller: AbortController; promise: Promise<unknown>; waiters: number }
export interface TmdbOptions { apiKey: string | null; proxy?: string; language?: "zh-CN" | "en-US"; baseUrl?: string; now?: () => number; timeoutMs?: number }
/** 服务密钥只存内存；缓存不含请求 URL、凭据或失败响应，外层凭据轮换时替换实例。 */
export class TmdbClient implements MetadataSearch {
  private readonly base: URL; private readonly language: string; private readonly now: () => number; private readonly agent?: HttpsProxyAgent<string>;
  private readonly flights = new Map<string, Flight>(); private readonly memory = new Map<string, { value: unknown; expires: number; bytes: number }>(); private memoryBytes = 0; private closed = false;
  constructor(private readonly database: CoreDatabase, private readonly options: TmdbOptions) {
    this.base = new URL(options.baseUrl ?? "https://api.themoviedb.org/3/");
    if (!["http:", "https:"].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash || !this.base.pathname.endsWith("/")) throw new MediaNetworkError("INVALID_RESPONSE");
    this.language = options.language ?? "zh-CN"; this.now = options.now ?? Date.now;
    if (options.proxy) { const proxy = new URL(options.proxy); if (!["http:", "https:"].includes(proxy.protocol) || proxy.username || proxy.password || proxy.hash || proxy.search || proxy.pathname !== "/") throw new MediaNetworkError("INVALID_RESPONSE"); this.agent = new HttpsProxyAgent(proxy); }
  }
  private async get<T>(route: string, params: Record<string, string>, schema: z.ZodType<T>, ttlMs: number, signal?: AbortSignal): Promise<T> {
    if (this.closed || signal?.aborted) throw new MediaNetworkError("INTERRUPTED");
    if (!this.options.apiKey || this.options.apiKey.length > 32768 || /[\r\n\0]/.test(this.options.apiKey)) throw new MediaNetworkError("AUTH_REQUIRED");
    const url = new URL(route, this.base); url.searchParams.set("language", this.language); for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const cacheKey = createHash("sha256").update("tmdb-v1|" + url.href).digest("hex"), db = this.database.connection, now = this.now();
    const remembered = this.memory.get(cacheKey); if (remembered && remembered.expires > now) return structuredClone(schema.parse(remembered.value));
    const cached = db.prepare("SELECT value,expires_at FROM tmdb_cache WHERE key=? AND expires_at>?").get(cacheKey, now) as { value: string; expires_at: number } | undefined;
    if (cached) {
      try { const value = schema.parse(JSON.parse(cached.value)); this.remember(cacheKey, value, cached.expires_at); return structuredClone(value); }
      catch { db.prepare("DELETE FROM tmdb_cache WHERE key=?").run(cacheKey); }
    }
    let flight = this.flights.get(cacheKey);
    if (!flight) {
      if (this.flights.size >= 32) throw new MediaNetworkError("RATE_LIMITED", 1);
      const controller = new AbortController();
      const headers: Record<string, string> = {}; if (/^[a-f0-9]{32}$/i.test(this.options.apiKey)) url.searchParams.set("api_key", this.options.apiKey); else headers.Authorization = `Bearer ${this.options.apiKey}`;
      const promise = (async () => {
        const raw = await requestJson(url, { headers, agent: this.agent, signal: controller.signal, timeoutMs: this.options.timeoutMs }), parsed = schema.safeParse(raw);
        if (!parsed.success) throw new MediaNetworkError("INVALID_RESPONSE");
        if (this.closed || controller.signal.aborted) throw new MediaNetworkError("INTERRUPTED");
        const expires = this.now() + ttlMs, value = parsed.data, encoded = JSON.stringify(value);
        // 大响应仍可使用，但不让缓存随查询数量增长为数 GiB；磁盘最多 1000 个 256 KiB 条目。
        if (Buffer.byteLength(encoded) <= 256 * 1024) db.transaction(() => { db.prepare("DELETE FROM tmdb_cache WHERE expires_at<=?").run(this.now()); db.prepare("INSERT INTO tmdb_cache(key,value,expires_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,expires_at=excluded.expires_at").run(cacheKey, encoded, expires); db.prepare("DELETE FROM tmdb_cache WHERE key IN (SELECT key FROM tmdb_cache ORDER BY expires_at DESC LIMIT -1 OFFSET 1000)").run(); })();
        this.remember(cacheKey, value, expires); return value;
      })();
      flight = { controller, promise, waiters: 0 }; this.flights.set(cacheKey, flight);
      void promise.finally(() => { if (this.flights.get(cacheKey) === flight) this.flights.delete(cacheKey); }).catch(() => {});
    }
    return structuredClone(await this.wait(cacheKey, flight, signal)) as T;
  }
  private wait(key: string, flight: Flight, signal?: AbortSignal): Promise<unknown> {
    flight.waiters++;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: unknown, value?: unknown) => {
        if (settled) return; settled = true; signal?.removeEventListener("abort", abort); flight.waiters--;
        if (signal?.aborted && flight.waiters === 0) { if (this.flights.get(key) === flight) this.flights.delete(key); flight.controller.abort(); }
        if (error) reject(error); else resolve(value);
      };
      const abort = () => finish(new MediaNetworkError("INTERRUPTED")); signal?.addEventListener("abort", abort, { once: true });
      flight.promise.then((value) => finish(null, value), (error) => finish(error)); if (signal?.aborted) abort();
    });
  }
  private remember(key: string, value: unknown, expires: number) {
    const old = this.memory.get(key); if (old) { this.memoryBytes -= old.bytes; this.memory.delete(key); }
    const bytes = Buffer.byteLength(JSON.stringify(value)); this.memoryBytes += bytes; this.memory.set(key, { value, expires, bytes });
    while (this.memory.size > 256 || this.memoryBytes > 32 * 1024 * 1024) { const key = this.memory.keys().next().value!, entry = this.memory.get(key)!; this.memory.delete(key); this.memoryBytes -= entry.bytes; }
  }
  async search(query: string, type: "MOVIE" | "TV_SHOW", year: number | null, signal?: AbortSignal): Promise<MetadataWork[]> {
    if (!query.trim() || query.length > 1024 || (year !== null && (!Number.isInteger(year) || year < 1 || year > 9999))) throw new MediaNetworkError("INVALID_RESPONSE");
    const params: Record<string, string> = { query, include_adult: "false", page: "1" }; if (year !== null) params[type === "MOVIE" ? "year" : "first_air_date_year"] = String(year);
    const value = await this.get(`search/${type === "MOVIE" ? "movie" : "tv"}`, params, z.object({ results: z.array(workSchema(type)).max(100) }), 600000, signal);
    return value.results.map((row) => mapWork(row, type));
  }
  async detail(tmdbId: number, type: "MOVIE" | "TV_SHOW", signal?: AbortSignal): Promise<MetadataWork & { seasons: number[] }> {
    this.identifier(tmdbId); const schema = workSchema(type).refine((value) => value.id === tmdbId && (type !== "TV_SHOW" || (!!value.seasons?.length && new Set(value.seasons.map((row) => row.season_number)).size === value.seasons.length)));
    const value = await this.get(`${type === "MOVIE" ? "movie" : "tv"}/${tmdbId}`, {}, schema, type === "MOVIE" ? 86400000 : 600000, signal);
    return { ...mapWork(value, type), seasons: value.seasons?.map((row) => row.season_number) ?? [] };
  }
  async episodes(tmdbId: number, season: number, signal?: AbortSignal): Promise<EpisodeMetadata[]> {
    this.identifier(tmdbId); if (!Number.isInteger(season) || season < 0 || season > 999) throw new MediaNetworkError("INVALID_RESPONSE");
    const value = await this.get(`tv/${tmdbId}/season/${season}`, {}, z.object({ episodes: z.array(z.object({ episode_number: z.number().int().min(1).max(10000), season_number: z.literal(season), name: text.nullable().optional() })).max(10000) }).refine((value) => new Set(value.episodes.map((row) => row.episode_number)).size === value.episodes.length), 600000, signal);
    return value.episodes.map((row) => ({ season, episode: row.episode_number, title: row.name?.trim() || null }));
  }
  private identifier(value: number) { if (!Number.isSafeInteger(value) || value < 1) throw new MediaNetworkError("INVALID_RESPONSE"); }
  close() { this.closed = true; for (const flight of this.flights.values()) flight.controller.abort(); this.flights.clear(); this.agent?.destroy(); this.memory.clear(); this.memoryBytes = 0; }
}
