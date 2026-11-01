/** 对齐旧聚类特征：哈希不属于作品名，集号来自明确文件特征，不按排序补号。 */
export function episodeFeature(
  filename: string,
): { family: string; season: number | null; episode: number; episodeEnd: number | null } | null {
  if (!/\.(?:mkv|mp4|avi|mov|m4v|wmv|flv|ts|m2ts|rmvb)$/i.test(filename)) return null;
  const stem = filename.replace(/\.[^.]+$/, "").replace(/-[a-f0-9]{8,64}$/i, "");
  const numbered = /^(\d{1,4})(?:[-~](\d{1,4}))?$/.exec(stem);
  let season: number | null = null,
    episode: number,
    episodeEnd: number | null,
    family: string;
  const namedFamily = (value: string) =>
    "named:" +
    value
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .toLowerCase();
  if (numbered) {
    family = "numbered";
    episode = Number(numbered[1]);
    episodeEnd = numbered[2] ? Number(numbered[2]) : null;
  } else {
    const named =
      /^(.*?)(?<![a-z0-9])S(\d{1,3})[ ._-]*E(\d{1,4})(?:(?:[-~]E?|[ ._]E|E)(\d{1,4})(?=$|[^a-z0-9]))?(?=$|[^0-9])/i.exec(
        stem,
      );
    if (named) {
      family = namedFamily(named[1]!);
      season = Number(named[2]);
      episode = Number(named[3]);
      episodeEnd = named[4] ? Number(named[4]) : null;
    } else {
      const anime = /^(.+?)\[(\d{1,4})(?:[-~](\d{1,4}))?\](?:\[[^\]]*\])*$/.exec(stem);
      if (!anime) return null;
      family = namedFamily(anime[1]!);
      episode = Number(anime[2]);
      episodeEnd = anime[3] ? Number(anime[3]) : null;
    }
  }
  if (
    episode < 1 ||
    episode > 10000 ||
    (episodeEnd !== null && (episodeEnd < episode || episodeEnd > 10000))
  )
    return null;
  return { family, season, episode, episodeEnd };
}

export function episodeOverlap(filename: string, siblings: readonly string[]) {
  const current = episodeFeature(filename);
  if (!current) return null;
  for (const otherName of siblings) {
    if (otherName === filename) continue;
    const other = episodeFeature(otherName);
    if (
      !other ||
      other.family !== current.family ||
      (other.season !== null && current.season !== null && other.season !== current.season)
    )
      continue;
    const start = Math.max(current.episode, other.episode),
      end = Math.min(current.episodeEnd ?? current.episode, other.episodeEnd ?? other.episode);
    if (start <= end) return { filename: otherName, start, end };
  }
  return null;
}
