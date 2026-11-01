import { DesktopError, type RecognitionSettings } from "@media-marshal/contracts";
import { normalizeParse, resolveSeason, type ParsedMedia } from "../domain/media.js";
import { mergeParentEvidence, parentContext, searchMatches, type MediaMatch, type MetadataSearch } from "../domain/matching.js";
import type { NameParser } from "../infrastructure/parser-process.js";
import type { CodexContext, CodexRecognition, CodexSuggestion } from "./codex-recognition.js";

export interface RecognitionStrategyInput {
  filename: string; relative: string[]; type: "AUTO" | "MOVIE" | "TV_SHOW";
  parser?: NameParser; tmdb: MetadataSearch; settings: RecognitionSettings;
  codex?: CodexRecognition; context(parsed: ParsedMedia): Promise<CodexContext>;
  edited?: ParsedMedia | null; signal?: AbortSignal;
}

/** 移植旧编排顺序；未知聚类不逐集兜底，失败建议不降低已有候选。 */
export async function identifyUsingStrategies(input: RecognitionStrategyInput) {
  const { signal, settings, codex } = input;
  let failure: string | null = null, parsed: ParsedMedia;
  const readFailure = (error: unknown) => { signal?.throwIfAborted(); return error instanceof DesktopError ? error.message : "Codex 辅助识别暂不可用，请检查 CLI 登录状态与网络后重试"; };
  if (input.edited) parsed = { ...input.edited };
  else {
    try {
      if (!input.parser) throw new DesktopError("COMPONENT_UNAVAILABLE", "离线名称解析器不可用，请重启核心后重试识别", true);
      parsed = await input.parser.parse(input.filename, signal);
    } catch (error) { signal?.throwIfAborted(); if (!codex?.enabled) throw error; parsed = normalizeParse({}, input.filename); }
    if (input.type !== "AUTO") parsed.type = input.type;
  }
  let suggestion: CodexSuggestion | null = null, clustered = false;
  let context: CodexContext | undefined;
  const getContext = async () => context ??= await input.context(parsed);
  if (!input.edited && codex?.enabled) {
    try { const result = await codex.cluster(await getContext(), parsed, input.type, signal); clustered = result.clustered; suggestion = result.suggestion; if ("reason" in result && result.reason) failure = `Codex 同作品聚类未得到可靠建议：${result.reason}。请重试或人工选择作品`.slice(0, 500); }
    catch (error) { failure = readFailure(error); }
    if (suggestion) parsed = suggestion.parsed;
    if (parsed.type === null && !clustered) {
      try { suggestion = await codex.file(await getContext(), parsed, input.type, false, signal); if (suggestion) parsed = suggestion.parsed; }
      catch (error) { failure = readFailure(error); }
    }
  }
  parsed.season = parsed.type === "TV_SHOW" ? resolveSeason(parsed.season, null, input.relative.slice(0, -1)) : null;
  let matches = await searchMatches(parsed, input.tmdb, signal, !!input.edited);
  if (!input.edited && settings.parentFolderEnabled && best(matches) < settings.confidenceThreshold && input.parser) {
    const parent = input.relative.slice(0, -1).reverse().map((part) => parentContext(part, parsed)).find(Boolean);
    if (parent) {
      try {
        const context = await input.parser.parse(parent.folderName, signal); context.type = parsed.type; context.season = parsed.season;
        matches = mergeParentEvidence(matches, await searchMatches(context, input.tmdb, signal), settings.confidenceThreshold, settings.parentOnlyConfidenceCap, settings.parentMutualBoost);
      } catch { signal?.throwIfAborted(); /* 父目录增强失败时保留原文件候选。 */ }
    }
  }
  if (!input.edited && !suggestion && !clustered && codex?.enabled && best(matches) < settings.confidenceThreshold) {
    try {
      const proposed = await codex.file(await getContext(), parsed, input.type, false, signal);
      if (proposed) {
        const proposedMatches = await searchMatches(proposed.parsed, input.tmdb, signal);
        if (proposedMatches.length && best(proposedMatches) >= best(matches)) { parsed = proposed.parsed; matches = proposedMatches; suggestion = proposed; }
      }
    } catch (error) { failure = readFailure(error); }
  }
  if (suggestion) matches = matches.map((match) => ({ ...match, evidence: "codex" as const, codex: suggestion!.evidence }));
  signal?.throwIfAborted();
  return { parsed, matches, failure: matches.length ? null : failure ?? (clustered ? "Codex 同作品聚类未得到可验证的 TMDB 候选，请补充正式片名或手动选择作品" : null) };
}

function best(matches: MediaMatch[]) { return Math.max(0, ...matches.map((match) => match.score.confidence)); }
