import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DesktopError,
  type CodexEvidence,
  type RecognitionSettings,
} from "@media-marshal/contracts";
import { normalizeParse, resolveSeason, type ParsedMedia } from "../domain/media.js";
import type { CodexGateway } from "../infrastructure/codex-process.js";

export interface CodexContext {
  filename: string;
  parents: string[];
  siblings: string[];
  siblings_truncated: boolean;
  cluster_scope: string;
  parsed: {
    title: string | null;
    year: number | null;
    type: "movie" | "episode" | null;
    season: number | null;
    episode: number | null;
  };
}
export interface CodexSuggestion {
  parsed: ParsedMedia;
  evidence: CodexEvidence;
}
const resultSchema = z.object({
  status: z.enum(["identified", "unknown"]),
  title: z.string().max(200).nullable(),
  year: z.number().int().min(1880).max(2100).nullable(),
  type: z.enum(["movie", "episode"]).nullable(),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(16384),
  season: z.number().int().min(0).max(999).nullable(),
  episode: z.number().int().min(1).max(10000).nullable(),
  episode_end: z.number().int().min(1).max(10000).nullable().optional(),
});
const seasonFolder =
  /^(?:s\d{1,3}|season[ ._-]*\d+|第.+季|specials?|ova|oad|sp|特别篇|特別篇|特典)$/i;

/** 规则和身份路径仅以摘要发送；既有明确坐标优先于模型。 */
export function codexContext(
  sourceId: string,
  relative: string[],
  siblings: readonly string[],
  parsed: ParsedMedia,
): CodexContext {
  const parents = relative.slice(0, -1).reverse().slice(0, 4),
    identity = relative.slice(0, -1);
  while (identity.length && seasonFolder.test(identity.at(-1)!)) identity.pop();
  return {
    filename: relative.at(-1)!,
    parents,
    siblings: [...siblings].sort().slice(0, 80),
    siblings_truncated: siblings.length > 80,
    cluster_scope: createHash("sha256")
      .update(JSON.stringify([sourceId, identity]))
      .digest("hex"),
    parsed: {
      title: parsed.title,
      year: parsed.year,
      type: parsed.type === "MOVIE" ? "movie" : parsed.type === "TV_SHOW" ? "episode" : null,
      season: parsed.season,
      episode: parsed.episode,
    },
  };
}

export function codexSuggestion(
  value: unknown,
  original: ParsedMedia,
  context: CodexContext,
  type: "AUTO" | "MOVIE" | "TV_SHOW",
  mode: CodexEvidence["mode"],
): CodexSuggestion | null {
  const checked = resultSchema.safeParse(value);
  if (!checked.success) return null;
  const raw = checked.data;
  if (
    raw.status !== "identified" ||
    raw.confidence < 0.6 ||
    !raw.title?.trim() ||
    !raw.type ||
    (type !== "AUTO" && (raw.type === "movie" ? "MOVIE" : "TV_SHOW") !== type)
  )
    return null;
  const parsed = normalizeParse(
    {
      title: raw.title.trim(),
      year: raw.year,
      type: raw.type,
      screen_size: original.screenSize,
      video_codec: original.videoCodec,
      release_group: original.releaseGroup,
    },
    raw.title.trim(),
  );
  if (raw.type === "episode") {
    parsed.season = resolveSeason(
      original.season,
      raw.season,
      [...context.parents].reverse().concat(context.filename),
    );
    parsed.episode = original.episode ?? raw.episode;
    parsed.episodeEnd =
      original.episodeEnd ?? (original.episode === null ? (raw.episode_end ?? null) : null);
    if (
      parsed.episodeEnd !== null &&
      (parsed.episode === null ||
        parsed.episodeEnd < parsed.episode ||
        parsed.episodeEnd - parsed.episode >= 1000)
    )
      return null;
    parsed.episodes =
      parsed.episode === null
        ? []
        : Array.from(
            { length: (parsed.episodeEnd ?? parsed.episode) - parsed.episode + 1 },
            (_, index) => parsed.episode! + index,
          );
  }
  return {
    parsed,
    evidence: { confidence: raw.confidence, reason: raw.reason.slice(0, 500), mode },
  };
}

export class CodexRecognition {
  constructor(
    private readonly gateway: CodexGateway,
    private readonly settings: () => RecognitionSettings,
  ) {}
  get enabled() {
    return this.settings().codexEnabled;
  }
  async cluster(
    context: CodexContext,
    original: ParsedMedia,
    type: "AUTO" | "MOVIE" | "TV_SHOW",
    signal?: AbortSignal,
  ) {
    if (!this.enabled || type === "MOVIE") return { clustered: false, suggestion: null };
    const value = await this.gateway.request("recognize-cluster", context, signal);
    if (
      !value ||
      typeof value !== "object" ||
      !("clustered" in value) ||
      typeof value.clustered !== "boolean"
    )
      throw new DesktopError("CONFLICT", "Codex 聚类返回无效，请核对名称后重试");
    const suggestion = value.clustered
      ? codexSuggestion(value, original, context, type, "cluster")
      : null;
    const result = {
      clustered: value.clustered,
      suggestion: suggestion?.parsed.type === "TV_SHOW" ? suggestion : null,
    };
    return "reason" in value && typeof value.reason === "string" && value.clustered && !suggestion
      ? { ...result, reason: value.reason.slice(0, 500) }
      : result;
  }
  async file(
    context: CodexContext,
    original: ParsedMedia,
    type: "AUTO" | "MOVIE" | "TV_SHOW",
    retryUnknown = false,
    signal?: AbortSignal,
  ) {
    if (!this.enabled) return null;
    return codexSuggestion(
      await this.gateway.request("recognize", { ...context, retry_unknown: retryUnknown }, signal),
      original,
      context,
      type,
      "file",
    );
  }
  async directory(
    context: CodexContext,
    originals: Map<string, ParsedMedia>,
    type: "AUTO" | "MOVIE" | "TV_SHOW",
    signal?: AbortSignal,
  ) {
    if (!this.enabled) throw new DesktopError("CONFLICT", "请先在设置中启用 Codex 识别");
    if (context.siblings_truncated || originals.size > 80)
      throw new DesktopError("CONFLICT", "目录视频超过 80 个，请拆分目录后识别");
    const raw = await this.gateway.request(
      "recognize-directory",
      { ...context, files: [...originals.keys()] },
      signal,
    );
    if (
      !raw ||
      typeof raw !== "object" ||
      !("files" in raw) ||
      !Array.isArray(raw.files) ||
      raw.files.length !== originals.size
    )
      throw new DesktopError(
        "CONFLICT",
        "Codex 未能完整识别同一作品目录，原识别信息保留，请逐文件核对",
      );
    const result = new Map<string, CodexSuggestion>();
    for (const file of raw.files) {
      if (
        !file ||
        typeof file.filename !== "string" ||
        !originals.has(file.filename) ||
        result.has(file.filename)
      )
        throw new DesktopError("CONFLICT", "Codex 目录结果含重复或外来文件，原识别信息保留");
      const item = codexSuggestion(
        { ...raw, season: file.season, episode: file.episode, episode_end: file.episode_end },
        originals.get(file.filename)!,
        { ...context, filename: file.filename },
        type,
        "directory",
      );
      if (!item || (originals.size > 1 && item.parsed.type === "MOVIE"))
        throw new DesktopError(
          "CONFLICT",
          "Codex 未能确认目录属于同一剧集，请逐文件识别或手动选择作品",
        );
      result.set(file.filename, item);
    }
    return result;
  }
}
