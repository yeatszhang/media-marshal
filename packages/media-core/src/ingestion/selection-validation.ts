import { DesktopError, selectionSchema } from "@media-marshal/contracts";
import { reconcileEpisodes, type EpisodeCoordinate } from "../domain/media.js";
import type { TmdbClient } from "../infrastructure/tmdb.js";
import type { CoreDatabase } from "../infrastructure/database.js";
import { assertMediaCoordinates } from "./coordinates.js";

/** 识别预检、人工预览及修正共用真实分集与占用核对；结果不授权文件执行。 */
export async function validateMediaSelection(database: CoreDatabase, tmdb: Pick<TmdbClient, "detail" | "episodes">, input: unknown, context: { taskId: string; fileName: string; signal?: AbortSignal }) {
  const selection = selectionSchema.parse(input), { signal } = context;
  signal?.throwIfAborted();
  if (selection.mediaType === "TV_SHOW" && (selection.season === null || selection.episode === null)) throw new DesktopError("CONFLICT", "请补齐 TMDB 季号和集号后重新预览");
  const metadata = await tmdb.detail(selection.tmdbId, selection.mediaType, signal);
  signal?.throwIfAborted();
  let episodeTitle: string | null = null, seasonChanged = false;
  if (selection.mediaType === "TV_SHOW") {
    let checked: EpisodeCoordinate & { episodeTitle: string | null; changed: boolean };
    try { checked = await reconcileEpisodes({ season: selection.season!, episode: selection.episode!, episodeEnd: selection.episodeEnd }, metadata.seasons, async (season) => {
      signal?.throwIfAborted();
      const episodes = await tmdb.episodes(selection.tmdbId, season, signal);
      signal?.throwIfAborted();
      return episodes;
    }); } catch (error) { signal?.throwIfAborted(); throw error; }
    Object.assign(selection, { season: checked.season, episode: checked.episode, episodeEnd: checked.episodeEnd });
    episodeTitle = checked.episodeTitle; seasonChanged = checked.changed;
  } else Object.assign(selection, { season: null, episode: null, episodeEnd: null });
  signal?.throwIfAborted();
  assertMediaCoordinates(database, selection, context.taskId, context.fileName);
  return { selection, metadata, episodeTitle, seasonChanged };
}
