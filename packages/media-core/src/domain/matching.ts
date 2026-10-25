import { RecognitionError, type ParsedMedia } from "./media.js";

export type QueryType = "LOCALIZED" | "ORIGINAL" | "COMBINED" | "GUESSIT";
export interface TitleQuery { query: string; type: QueryType; weight: number }
export interface SearchPlan { originalFilename: string; guessitTitle: string | null; titleRegion: string | null; queries: TitleQuery[] }
export interface MetadataWork { tmdbId: number; mediaType: "MOVIE" | "TV_SHOW"; title: string; originalTitle: string | null; year: number | null; overview?: string; genres?: string[]; country?: string | null }
export interface MatchScore { confidence: number; bestQuery: string | null; queryType: QueryType | null; titleScore: number; yearScore: number; mediaTypeScore: number; structureBonus: number }
export interface MediaMatch extends MetadataWork { score: MatchScore; evidence: "filename" | "parent" | "both"; filenameConfidence?: number; parentConfidence?: number; parentOnlyCapped?: boolean }
const hasHan = (value: string) => /\p{Script=Han}/u.test(value), hasAscii = (value: string | null) => /[A-Za-z]/.test(value ?? "");
const normalize = (value: string | null | undefined): string | null => value?.replace(/[._]+/g, " ").replace(/[\[\]【】()（）]/g, " ").replace(/\s+/g, " ").trim() || null;
const trim = (value: string) => value.replace(/^[\s._-]+|[\s._-]+$/g, "");
const metadataToken = "(?:gb|big5|chs|cht|sc|tc|简体|繁体|简繁|简繁内封|简繁外挂|\\d{3,4}p|4k|8k|bluray|blu-ray|web-dl|webrip|hdtv|hdrip|dvdrip|bdrip|x264|x265|h[. ]?264|h[. ]?265|hevc|avc|aac|flac|ddp?|dts|atmos|10bit|8bit|hi10p|hdr|sdr)";
const bracketMetadata = new RegExp(`^${metadataToken}(?:[\\s._+\\-]+${metadataToken})*$`, "i");
const releaseMarker = /(?:^|[. _\-[\(])(s\d{1,2}(?:e\d{1,3})?|season\s*\d+|第\s*\d+\s*季|第\s*\d+\s*集|\d{3,4}p|2160p|1080p|720p|480p|4k|8k|bluray|blu-ray|web-dl|webrip|hdtv|hdrip|dvdrip|bdrip|x264|x265|h\.264|h\.265|hevc|aac|ddp?|dts|atmos|proper|repack)(?:$|[. _\-\]\)])/i;
const yearMarker = /(?:^|[. _\-[\(])((?:19|20)\d{2})(?:$|[. _\-\]\)])/;
function stripMetadata(filename: string, parsed: ParsedMedia): string {
  let title = "", cursor = 0;
  for (const match of filename.matchAll(/[\[【(（]([^\[\]【】()（）]+)[\]】)）]/g)) {
    title += filename.slice(cursor, match.index); const token = match[1]!.trim();
    const group = normalize(parsed.releaseGroup)?.toLowerCase() === normalize(token)?.toLowerCase() || /^(?:.*字幕[组組社]|[a-z0-9._-]*subs?)(?:\s*[&+＆]\s*[\p{L}\p{N}._-]+)*$/iu.test(token);
    if (group) title += " ";
    else {
      const hasTitle = normalize(trim(title)) !== null, episode = hasTitle && parsed.type === "TV_SHOW" && /^\d{1,4}(?:[-~]\d{1,4})?(?:v\d+)?$/i.test(token);
      if (bracketMetadata.test(token) || episode) { if (hasTitle) return title; title += " "; } else title += match[0];
    }
    cursor = match.index! + match[0].length;
  }
  return title + filename.slice(cursor);
}
function unbracketed(value: string | null): string[] {
  if (!value) return [];
  const chinese: string[] = [], english: string[] = [];
  for (const part of value.split(/\s+/)) {
    if (hasHan(part)) chinese.push(part); else if (hasAscii(part) || (/^\d+$/.test(part) && english.length)) english.push(part);
  }
  return chinese.length && english.length ? [chinese.join(" "), english.join(" "), normalize(chinese.join(" ") + " " + english.join(" "))!] : [value];
}
export function buildSearchPlan(parsed: ParsedMedia): SearchPlan {
  if (parsed.originalFilename.length > 16384) throw new RecognitionError("PARSE_INVALID", "名称过长，请手动核对");
  let region = stripMetadata(parsed.originalFilename.replace(/\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|iso)$/i, ""), parsed);
  const markers = [releaseMarker.exec(region)?.index, yearMarker.exec(region)?.index];
  if (parsed.season !== null) markers.push(new RegExp(`(?:^|[. _-])s${String(parsed.season).padStart(2, "0")}`, "i").exec(region)?.index);
  if (parsed.year !== null) markers.push(new RegExp(`(?:^|[. _\\-[\\(])${parsed.year}(?:$|[. _\\-\\]\\)])`).exec(region)?.index);
  const first = Math.min(...markers.filter((index): index is number => index !== undefined)); if (first > 0 && Number.isFinite(first)) region = region.slice(0, first);
  region = trim(region); let remaining = region, bracketed = false; const primary: string[] = [];
  for (;;) { const match = /^\s*[\[【(（]([^\]】)）]+)[\]】)）]\s*(.*)$/.exec(remaining); if (!match) break; bracketed = true; primary.push(...unbracketed(normalize(match[1]))); remaining = trim(match[2]!); }
  if (bracketed) { primary.push(...unbracketed(normalize(remaining))); if (primary.length > 1 && normalize(region)) primary.push(normalize(region)!); } else primary.push(...unbracketed(normalize(region)));
  const queries: TitleQuery[] = [], seen = new Set<string>();
  const add = (value: string | null, type: QueryType) => { const query = normalize(value); if (query && !seen.has(query.toLowerCase())) { seen.add(query.toLowerCase()); queries.push({ query, type, weight: { LOCALIZED: 1, ORIGINAL: 0.95, COMBINED: 0.85, GUESSIT: 0.75 }[type] }); } };
  for (const value of primary) { add(value, hasHan(value) ? hasAscii(value) ? "COMBINED" : "LOCALIZED" : "ORIGINAL"); if (queries.length >= 3) break; }
  if (queries.length < 4) add(parsed.title, "GUESSIT");
  return { originalFilename: parsed.originalFilename, guessitTitle: normalize(parsed.title), titleRegion: region || null, queries };
}
export function titleSimilarity(left: string | null, right: string | null): number {
  const norm = (value: string | null) => (value ?? "").normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();
  const a = norm(left), b = norm(right); if (!a || !b) return 0;
  if (a.length > 512 || b.length > 512) throw new RecognitionError("PARSE_INVALID", "标题过长，无法安全自动评分，请人工核对");
  if (a === b) return 1;
  let previous = new Uint16Array(b.length + 1), current = new Uint16Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) { for (let j = 1; j <= b.length; j++) current[j] = a[i - 1] === b[j - 1] ? previous[j - 1]! + 1 : Math.max(previous[j]!, current[j - 1]!); [previous, current] = [current, previous]; current.fill(0); }
  return previous[b.length]! / Math.max(a.length, b.length);
}
export function scoreMatch(parsed: ParsedMedia, candidate: MetadataWork, plan: SearchPlan, matched: TitleQuery | null = null, resultCount = 0): MatchScore {
  const yearScore = parsed.year === null ? 0.3 : candidate.year === null ? 0.1 : candidate.year === parsed.year || (parsed.season !== null && parsed.season >= 2 && candidate.mediaType === "TV_SHOW" && candidate.year <= parsed.year) ? 1 : Math.abs(candidate.year - parsed.year) === 1 ? 0.3 : 0;
  const mediaTypeScore = parsed.type === null ? 0.5 : parsed.type === candidate.mediaType ? 1 : 0;
  let bestQuery: string | null = null, queryType: QueryType | null = null, titleScore = 0;
  for (const query of plan.queries) { const score = Math.max(titleSimilarity(query.query, candidate.title), titleSimilarity(query.query, candidate.originalTitle)) * query.weight; if (score > titleScore) { titleScore = score; bestQuery = query.query; queryType = query.type; } }
  if (matched && resultCount > 0 && !hasAscii(candidate.title) && !hasAscii(candidate.originalTitle) && (matched.type === "ORIGINAL" || matched.type === "GUESSIT")) {
    const evidence = (resultCount === 1 ? yearScore === 1 && mediaTypeScore === 1 ? 0.92 : 0.45 : resultCount <= 3 ? 0.35 : 0) * matched.weight;
    if (evidence > titleScore) { titleScore = evidence; bestQuery = matched.query; queryType = matched.type; }
  }
  const localized = plan.queries.some((query) => query.type === "LOCALIZED" && titleSimilarity(query.query, candidate.title) >= 0.9), original = plan.queries.some((query) => query.type === "ORIGINAL" && titleSimilarity(query.query, candidate.originalTitle) >= 0.9), structureBonus = localized && original ? 1 : 0;
  return { confidence: Math.min(1, titleScore * 0.6 + yearScore * 0.2 + mediaTypeScore * 0.1 + structureBonus * 0.1), bestQuery, queryType, titleScore, yearScore, mediaTypeScore, structureBonus };
}
const genericParents = new Set(["download", "downloads", "complete", "completed", "incoming", "media", "library", "movie", "movies", "tv", "tv show", "tv shows", "show", "shows", "series", "season", "season 1", "season 01", "s01", "电视剧", "剧集", "国产剧", "电影", "合集"]);
export function parentContext(folder: string, parsed: ParsedMedia): { folderName: string; titleRegion: string } | null {
  const season = /(?:^|[. _-])(?:s(\d{1,2})|season\s*(\d+)|第\s*(\d+)\s*季)(?:$|[. _-])/i.exec(folder), marker = /(?:^|[. _\-[\(])(?:s\d{1,2}(?:e\d{1,3})?|season\s*\d+|第\s*\d+\s*季|(?:19|20)\d{2}|\d{3,4}p|4k|8k|bluray|blu-ray|web-dl|webrip|hdtv|hdrip|dvdrip|bdrip|x264|x265|h\.264|h\.265|h264|h265|hevc|aac|ddp?\d?(?:\.\d)?|dts|atmos|proper|repack)(?:$|[. _\-\]\)])/i.exec(folder);
  if (season && Number(season[1] ?? season[2] ?? season[3]) !== parsed.season) return null;
  if (!marker || marker.index <= 0) return null; const region = normalize(trim(folder.slice(0, marker.index)));
  if (!region || genericParents.has(region.toLowerCase()) || /^(?:s\d{1,2}|season\s*\d+|第\s*\d+\s*季)$/i.test(region) || !/[\p{Script=Han}A-Za-z0-9]/u.test(region)) return null;
  return { folderName: folder, titleRegion: region };
}
/** 父目录不独自授权自动整理；原实现仅同 ID 即加分的宽松行为由新规格收紧。 */
export function mergeParentEvidence(filename: readonly MediaMatch[], parent: readonly MediaMatch[], threshold = 0.8): MediaMatch[] {
  const key = (value: MetadataWork) => `${value.mediaType}:${value.tmdbId}`, merged = new Map(filename.map((value) => [key(value), value]));
  for (const candidate of parent) {
    const old = merged.get(key(candidate)), supporting = !!old && old.score.confidence >= 0.6 && candidate.score.confidence >= 0.6;
    const score = supporting ? Math.min(1, Math.max(old.score.confidence, candidate.score.confidence) + 0.05) : Math.max(old?.score.confidence ?? 0, Math.min(candidate.score.confidence, 0.75, Math.max(0, threshold - 0.01)));
    const source = old && old.score.confidence > candidate.score.confidence ? old : candidate;
    merged.set(key(candidate), { ...source, score: { ...source.score, confidence: score }, evidence: old ? "both" : "parent", filenameConfidence: old?.filenameConfidence ?? old?.score.confidence, parentConfidence: candidate.score.confidence, parentOnlyCapped: !supporting });
  }
  return [...merged.values()].sort((a, b) => b.score.confidence - a.score.confidence);
}
export interface MetadataSearch { search(query: string, type: "MOVIE" | "TV_SHOW", year: number | null, signal?: AbortSignal): Promise<MetadataWork[]> }
export async function searchMatches(parsed: ParsedMedia, source: MetadataSearch, signal?: AbortSignal): Promise<MediaMatch[]> {
  const plan = buildSearchPlan(parsed), merged = new Map<string, MediaMatch>();
  const types = parsed.type ? [parsed.type] : ["MOVIE", "TV_SHOW"] as const;
  for (const type of types) for (const query of plan.queries) {
    signal?.throwIfAborted(); const year = type === "TV_SHOW" && parsed.season !== null && parsed.season >= 2 ? null : parsed.year;
    let results = await source.search(query.query, type, year, signal); if (!results.length && year !== null) results = await source.search(query.query, type, null, signal);
    if (results.length > 100) throw new RecognitionError("METADATA_UNAVAILABLE", "元数据候选超出允许范围");
    for (const candidate of results) {
      if (parsed.type && candidate.mediaType !== parsed.type) continue;
      const score = scoreMatch(parsed, candidate, plan, query, results.length), key = `${candidate.mediaType}:${candidate.tmdbId}`;
      if (!merged.has(key) || merged.get(key)!.score.confidence < score.confidence) merged.set(key, { ...candidate, score, evidence: "filename", filenameConfidence: score.confidence });
    }
  }
  return [...merged.values()].sort((a, b) => b.score.confidence - a.score.confidence).slice(0, 100);
}
