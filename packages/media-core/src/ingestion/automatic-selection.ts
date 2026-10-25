import type { Recognition } from "@media-marshal/contracts";
import type { MediaSelection } from "./coordinates.js";

/** 沿用既有匹配阈值；达到阈值的作品不唯一时仍须人工确认。 */
export const automaticConfidenceThreshold = 0.8;
export function selectAutomaticWork(task: Recognition): { selection: MediaSelection } | { reason: string } {
  if (task.state !== "AWAITING_CONFIRMATION" || !task.parsed) return { reason: "识别尚未完成，请在待处理核对作品" };
  if ((task.revision ?? 0) > 0 || task.matchesStale) return { reason: "识别信息经过人工编辑，请重新预览并确认整理" };
  const first = task.matches[0];
  if (!first || !Number.isFinite(first.confidence) || first.confidence < automaticConfidenceThreshold) return { reason: "作品置信度不足 80%，请人工核对后预览整理" };
  if (first.evidence === "parent" || first.evidence === "manual") return { reason: "作品仅有父目录或人工字段证据，请预览并确认整理" };
  if (task.matches.some((match) => (match.mediaType !== first.mediaType || match.tmdbId !== first.tmdbId) && match.confidence >= automaticConfidenceThreshold)) return { reason: "多个作品达到自动匹配阈值，请人工选择作品" };
  if (first.mediaType === "MOVIE") return { selection: { tmdbId: first.tmdbId, mediaType: first.mediaType, season: null, episode: null, episodeEnd: null } };
  if (first.episodeCheck?.state !== "VALID") return { reason: first.episodeCheck?.state === "NEEDS_REVIEW" ? first.episodeCheck.reason : "真实季集尚未完成校验，请人工核对后重新预览" };
  return { selection: { tmdbId: first.tmdbId, mediaType: first.mediaType, season: first.episodeCheck.season, episode: first.episodeCheck.episode, episodeEnd: first.episodeCheck.episodeEnd } };
}
