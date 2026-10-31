/** 仅提取明确的本地身份，不做片名模糊匹配或在线识别。 */
export interface LibraryMediaIdentity {
  title?: string; year?: number; tmdbId?: string; season?: number; episode?: string; conflict: boolean;
}
const normalize = (value: string) => value.normalize("NFC").trim().toLocaleLowerCase("en-US");
export function libraryMediaIdentity(segments: readonly string[]): LibraryMediaIdentity {
  const identity: LibraryMediaIdentity = { conflict: false }, seasons = new Set<number>(), episodes = new Set<string>();
  for (const part of segments) {
    const work = /^(.*?)\s*[（(]((?:19|20)\d{2})[)）]/.exec(part);
    if (work?.[1]?.trim()) {
      const title = normalize(work[1]), year = Number(work[2]);
      if (identity.title && (identity.title !== title || identity.year !== year)) identity.conflict = true;
      identity.title = title; identity.year = year;
    }
    const tmdb = /\[tmdbid[=:](\d+)\]/i.exec(part)?.[1];
    if (tmdb) { if (identity.tmdbId && identity.tmdbId !== tmdb) identity.conflict = true; identity.tmdbId = tmdb; }
    for (const match of part.matchAll(/\bS(\d{1,3})E(\d{1,4})((?:\s*[-–]?\s*E\d{1,4})*)/gi)) {
      seasons.add(Number(match[1]));
      const end = match[3] ? [...match[3].matchAll(/E(\d+)/gi)].map((entry) => String(Number(entry[1]))).join("-") : "";
      episodes.add(String(Number(match[2])) + (end ? "-" + end : ""));
    }
    const season = /^(?:Season\s*(\d+)|第\s*(\d+)\s*季)(?:\b|\s|$)/i.exec(part);
    if (season) seasons.add(Number(season[1] ?? season[2]));
  }
  if (seasons.size > 1 || episodes.size > 1) identity.conflict = true;
  identity.season = [...seasons][0]; identity.episode = [...episodes][0];
  return identity;
}
export function conflictingMediaIdentity(a: LibraryMediaIdentity, b: LibraryMediaIdentity) {
  return a.conflict || b.conflict || !!(a.tmdbId && b.tmdbId && a.tmdbId !== b.tmdbId)
    || !!(a.title && b.title && (a.title !== b.title || a.year !== b.year))
    || a.season !== undefined && b.season !== undefined && a.season !== b.season
    || a.episode !== undefined && b.episode !== undefined && a.episode !== b.episode;
}
export function sameMediaIdentity(a: LibraryMediaIdentity, b: LibraryMediaIdentity) {
  if (conflictingMediaIdentity(a, b)) return false;
  const work = a.tmdbId && b.tmdbId ? a.tmdbId === b.tmdbId : !!(a.title && b.title && a.title === b.title && a.year === b.year);
  return work && a.season === b.season && a.episode === b.episode;
}
