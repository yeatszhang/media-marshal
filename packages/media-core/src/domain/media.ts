/** 与进程、文件和框架无关的识别模型；上游异常不能携带名称或请求内容。 */
export class RecognitionError extends Error {
  constructor(readonly code: "PARSE_INVALID" | "EPISODE_INVALID" | "TEMPLATE_INVALID" | "METADATA_UNAVAILABLE", message: string) { super(message); this.name = "RecognitionError"; }
}
export interface ParsedMedia {
  originalFilename: string; title: string | null; year: number | null; season: number | null;
  episode: number | null; episodeEnd: number | null; episodes: number[];
  type: "MOVIE" | "TV_SHOW" | null; releaseGroup: string | null; screenSize: string | null; videoCodec: string | null;
}
function invalid(): never { throw new RecognitionError("PARSE_INVALID", "名称解析结果无效，请手动核对"); }
function integer(value: unknown, min: number, max: number): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) invalid();
  return value;
}
function text(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > 16384 || /[\0\r\n]/.test(value)) invalid();
  return value.trim() || null;
}
export function normalizeParse(value: unknown, filename: string): ParsedMedia {
  if (!filename.trim() || filename.length > 16384 || /[/\\\0\r\n]/.test(filename) || !value || typeof value !== "object" || Array.isArray(value)) invalid();
  const raw = value as Record<string, unknown>, season = integer(raw.season, 0, 999), year = integer(raw.year, 1, 9999);
  let episodes: number[] = [];
  if (raw.episode !== undefined && raw.episode !== null) {
    const values = Array.isArray(raw.episode) ? raw.episode : [raw.episode]; if (values.length > 1000) invalid();
    episodes = values.map((item) => { const result = integer(item, 1, 10000); if (result === null) invalid(); return result; });
    for (let index = 1; index < episodes.length; index++) if (episodes[index] !== episodes[index - 1]! + 1) invalid();
  }
  if (raw.type !== undefined && raw.type !== null && raw.type !== "movie" && raw.type !== "episode") invalid();
  return { originalFilename: filename, title: text(raw.title), year, season, episode: episodes[0] ?? null, episodeEnd: episodes.length > 1 ? episodes.at(-1)! : null, episodes,
    type: raw.type === "episode" || season !== null || episodes.length ? "TV_SHOW" : raw.type === "movie" ? "MOVIE" : null,
    releaseGroup: text(raw.release_group), screenSize: text(raw.screen_size), videoCodec: text(raw.video_codec) };
}
function chineseNumber(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const units = /[十百]/.test(value); let total = 0, current = 0;
  for (const char of value) {
    if (char === "十" || char === "百") { total += (current || 1) * (char === "十" ? 10 : 100); current = 0; }
    else { const digit = char === "两" ? 2 : char === "〇" ? 0 : "零一二三四五六七八九".indexOf(char); if (digit < 0) return -1; current = units ? digit : current * 10 + digit; }
  }
  return total + current;
}
/** 与旧实现一致：明确解析值优先，其次最近五层名称中的季号/特别篇，再采用建议值或第一季。 */
export function resolveSeason(parsed: number | null, suggested: number | null, pathSegments: readonly string[]): number {
  if (parsed !== null) { integer(parsed, 0, 999); return parsed; }
  for (const name of pathSegments.slice(-5).reverse()) {
    const match = /(?:^|[^a-z0-9])(?:s|season[\s._-]*)(\d{1,3})(?=$|[^a-z0-9]|e\d)|第\s*([\d零〇一二三四五六七八九十百两]{1,5})\s*季/i.exec(name);
    if (match) { const season = match[1] ? Number(match[1]) : chineseNumber(match[2]!); if (season >= 0 && season <= 999) return season; }
    if (/(?:^|[^a-z0-9])(?:specials?|ova|oad|sp)(?=$|[^a-z0-9]|\d)|特别篇|特別篇|特典/i.test(name)) return 0;
  }
  return integer(suggested, 0, 999) ?? 1;
}
export interface EpisodeCoordinate { season: number; episode: number; episodeEnd: number | null }
export interface EpisodeMetadata { season: number; episode: number; title: string | null }
function blocked(message: string): never { throw new RecognitionError("EPISODE_INVALID", message + "；已暂停文件整理"); }
export async function reconcileEpisodes(coordinate: EpisodeCoordinate, seasons: readonly number[], load: (season: number) => Promise<readonly EpisodeMetadata[]>): Promise<EpisodeCoordinate & { episodeTitle: string | null; changed: boolean }> {
  const { season, episode } = coordinate, end = coordinate.episodeEnd ?? episode;
  if (!Number.isInteger(season) || season < 0 || season > 999 || !Number.isInteger(episode) || episode < 1 || !Number.isInteger(end) || end < episode || end > 10000 || end - episode >= 1000) blocked("缺少有效的季集号，请先补齐");
  if (!seasons.length || seasons.length > 1000 || new Set(seasons).size !== seasons.length || seasons.some((value) => !Number.isInteger(value) || value < 0 || value > 999)) blocked("TMDB 未提供有效季列表");
  const read = async (number: number) => {
    let values: readonly EpisodeMetadata[]; try { values = await load(number); } catch { throw new RecognitionError("METADATA_UNAVAILABLE", "TMDB 分集列表获取失败，季集未经校验，请重试"); }
    if (!Array.isArray(values) || values.length > 10000 || values.some((value) => value.season !== number || !Number.isInteger(value.episode) || value.episode < 1 || value.episode > 10000) || new Set(values.map((value) => value.episode)).size !== values.length) blocked("TMDB 分集列表无效");
    return new Map(values.map((value) => [value.episode, value]));
  };
  const contains = (values: Map<number, EpisodeMetadata>) => { for (let value = episode; value <= end; value++) if (!values.has(value)) return false; return true; };
  let chosen = season, entries = seasons.includes(season) ? await read(season) : new Map<number, EpisodeMetadata>();
  if (!contains(entries)) {
    const matches: { season: number; entries: Map<number, EpisodeMetadata> }[] = [];
    if (season > 0) for (const candidate of seasons.filter((value) => value > 0 && value !== season)) { const values = await read(candidate); if (contains(values)) matches.push({ season: candidate, entries: values }); }
    if (matches.length !== 1) blocked(matches.length ? "多个正片季包含全部集号，无法唯一映射" : "没有唯一正片季包含全部集号，请按 TMDB 编辑季集号");
    chosen = matches[0]!.season; entries = matches[0]!.entries;
  }
  return { season: chosen, episode, episodeEnd: coordinate.episodeEnd, episodeTitle: episode === end ? entries.get(episode)?.title?.trim() || null : null, changed: chosen !== season };
}
/** 自动、人工确认与修正共同使用；目录摘要不能免除逐资产坐标冲突检查。 */
export function assertUniqueEpisodes(values: readonly (EpisodeCoordinate & { tmdbId: number })[]) {
  if (values.length > 1000) blocked("一次季集确认超出允许范围");
  const occupied = new Set<string>();
  for (const value of values) {
    const end = value.episodeEnd ?? value.episode;
    if (!Number.isSafeInteger(value.tmdbId) || value.tmdbId < 1 || !Number.isInteger(value.season) || value.season < 0 || value.season > 999 || !Number.isInteger(value.episode) || value.episode < 1 || !Number.isInteger(end) || end < value.episode || end > 10000 || end - value.episode >= 1000) blocked("季集坐标无效");
    for (let episode = value.episode; episode <= end; episode++) {
      const key = `${value.tmdbId}:${value.season}:${episode}`; if (occupied.has(key)) blocked("同一作品存在重复或重叠季集"); occupied.add(key);
    }
  }
}
