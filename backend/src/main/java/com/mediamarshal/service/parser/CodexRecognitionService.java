package com.mediamarshal.service.parser;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.mediamarshal.model.dto.ParseResult;
import com.mediamarshal.model.entity.WatchRule;
import com.mediamarshal.service.settings.SettingsService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.web.reactive.function.client.WebClient;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

/** Codex 仅提供名称解析建议；作品身份仍须经 TMDB 校验。 */
@Slf4j
@Service
@RequiredArgsConstructor
public class CodexRecognitionService {
    private final SettingsService settings;
    private final WebClient.Builder webClientBuilder;

    public boolean isEnabled() {
        return Boolean.parseBoolean(settings.get("codex.enabled", "false"));
    }

    public boolean requiresConfirmation(double confidence) {
        return Boolean.parseBoolean(settings.get("codex.require-confirmation", "true")) || confidence < 0.9;
    }

    public Optional<Suggestion> recognize(Path source, WatchRule rule, ParseResult original) {
        return recognize(source, rule, original, false);
    }

    /** 主动重试绕过短期 unknown 缓存，成功的作品身份仍可复用。 */
    public Optional<Suggestion> recognize(Path source, WatchRule rule, ParseResult original, boolean retryUnknown) {
        if (!isEnabled()) return Optional.empty();
        try {
            String url = settings.get("codex.bridge-url", "http://host.docker.internal:18081");
            String token = settings.get("codex.bridge-token", "");
            if (token.isBlank()) return Optional.empty();
            Map<String, Object> context = buildContext(source, rule, original);
            context.put("retry_unknown", retryUnknown);
            JsonNode response = webClientBuilder.build().post().uri(url + "/recognize")
                    .header("X-Media-Marshal-Token", token)
                    .bodyValue(context).retrieve()
                    .bodyToMono(JsonNode.class).block(Duration.ofSeconds(240));
            return parseSuggestion(response, rule, original, source);
        } catch (Exception e) {
            // 不记录响应正文或凭据；桥接不可用时继续原有人工确认流程。
            log.warn("Codex 辅助解析不可用：{}", e.getClass().getSimpleName());
            return Optional.empty();
        }
    }

    Optional<Suggestion> parseSuggestion(JsonNode response, WatchRule rule, ParseResult original) {
        return parseSuggestion(response, rule, original, null);
    }

    private Optional<Suggestion> parseSuggestion(JsonNode response, WatchRule rule, ParseResult original, Path source) {
        try {
            if (response == null || !"identified".equals(response.path("status").asText())
                    || !response.path("title").isTextual()
                    || !response.path("confidence").isNumber()) return Optional.empty();
            String title = response.path("title").asText().strip();
            String type = response.path("type").asText();
            double confidence = response.path("confidence").asDouble();
            if (title.isBlank() || title.length() > 200 || !Double.isFinite(confidence)
                    || confidence < 0.6 || confidence > 1
                    || !(type.equals("movie") || type.equals("episode"))) return Optional.empty();
            if (rule.getMediaType() == WatchRule.RuleMediaType.MOVIE && !type.equals("movie")) return Optional.empty();
            if (rule.getMediaType() == WatchRule.RuleMediaType.TV_SHOW && !type.equals("episode")) return Optional.empty();
            ParseResult result = new ParseResult();
            result.setTitle(title);
            result.setYear(integer(response, "year", 1880, 2100));
            result.setType(type);
            // 此对象仅用于再次检索；使用正式片名，避免 01.mkv 产生无关数字候选。
            // 任务中的真实源路径和文件名保持不变。
            result.setOriginalFilename(title);
            result.setScreenSize(original.getScreenSize());
            result.setVideoCodec(original.getVideoCodec());
            result.setReleaseGroup(original.getReleaseGroup());
            if (type.equals("episode")) {
                // 季集号优先保留规则解析结果，避免模型覆盖明确的 SxxExx。
                result.setSeason(EpisodeSeasonResolver.resolve(original.getSeason(), integer(response, "season", 0, 999), source));
                result.setEpisode(original.getEpisode() != null ? original.getEpisode() : integer(response, "episode", 1, 10000));
                result.setEpisodeEnd(original.getEpisodeEnd());
            }
            String reason = response.path("reason").asText("");
            return Optional.of(new Suggestion(result, confidence, reason.substring(0, Math.min(500, reason.length()))));
        } catch (IllegalArgumentException e) {
            return Optional.empty();
        }
    }

    /** 一次解析同目录作品身份和逐文件坐标；不跨目录共享模型推测。 */
    public Map<String, Suggestion> recognizeDirectory(Path source, WatchRule rule, Map<String, ParseResult> originals) {
        if (!isEnabled()) throw new IllegalStateException("请先启用 Codex 识别");
        try {
            String token = settings.get("codex.bridge-token", "");
            if (token.isBlank()) throw new IllegalStateException("Codex 桥接尚未配置");
            Map<String, Object> context = buildContext(source, rule, originals.get(source.getFileName().toString()));
            if (Boolean.TRUE.equals(context.get("siblings_truncated"))) {
                throw new IllegalStateException("目录视频超过 80 个，请拆分目录后识别");
            }
            context.put("files", new ArrayList<>(originals.keySet()));
            JsonNode response = webClientBuilder.build().post()
                    .uri(settings.get("codex.bridge-url", "http://host.docker.internal:18081") + "/recognize-directory")
                    .header("X-Media-Marshal-Token", token).bodyValue(context).retrieve()
                    .bodyToMono(JsonNode.class).block(Duration.ofSeconds(240));
            Map<String, Suggestion> suggestions = parseDirectorySuggestions(response, rule, originals, source.getParent());
            if (suggestions.isEmpty()) throw new IllegalStateException("Codex 未能确认目录属于同一作品，请逐文件识别或手动选择作品");
            return suggestions;
        } catch (IllegalStateException e) {
            throw e;
        } catch (Exception e) {
            log.warn("Codex 目录解析不可用：{}", e.getClass().getSimpleName());
            throw new IllegalStateException("Codex 目录识别暂不可用，已保留原识别信息");
        }
    }

    Map<String, Suggestion> parseDirectorySuggestions(JsonNode response, WatchRule rule, Map<String, ParseResult> originals) {
        return parseDirectorySuggestions(response, rule, originals, null);
    }

    private Map<String, Suggestion> parseDirectorySuggestions(JsonNode response, WatchRule rule, Map<String, ParseResult> originals, Path directory) {
        if (!(response instanceof ObjectNode) || !response.path("files").isArray()
                || response.path("files").size() != originals.size()) return Map.of();
        Map<String, Suggestion> results = new LinkedHashMap<>();
        try {
            for (JsonNode file : response.path("files")) {
                String name = file.path("filename").asText();
                if (!originals.containsKey(name) || results.containsKey(name)) return Map.of();
                ObjectNode item = response.deepCopy();
                item.set("season", file.path("season"));
                item.set("episode", file.path("episode"));
                Optional<Suggestion> suggestion = parseSuggestion(item, rule, originals.get(name), directory == null ? Path.of(name) : directory.resolve(name));
                if (suggestion.isEmpty()) return Map.of();
                ParseResult parsed = suggestion.get().parsed();
                if ("episode".equals(parsed.getType()) && originals.get(name).getEpisode() == null) {
                    Integer end = integer(file, "episode_end", 1, 10000);
                    if (end != null && (parsed.getEpisode() == null || end < parsed.getEpisode())) return Map.of();
                    parsed.setEpisodeEnd(end);
                }
                results.put(name, suggestion.get());
            }
            if (results.values().stream().anyMatch(s -> "movie".equals(s.parsed().getType())) && results.size() > 1) return Map.of();
            return results;
        } catch (IllegalArgumentException e) {
            return Map.of();
        }
    }

    private Integer integer(JsonNode node, String key, int min, int max) {
        JsonNode value = node.get(key);
        if (value == null || value.isNull()) return null;
        if (!value.isIntegralNumber() || !value.canConvertToInt()) throw new IllegalArgumentException("无效数值字段");
        int number = value.intValue();
        if (number < min || number > max) throw new IllegalArgumentException("数值字段越界");
        return number;
    }

    Map<String, Object> buildContext(Path source, WatchRule rule, ParseResult parsed) throws Exception {
        Path root = Path.of(rule.getSourceDir()).toAbsolutePath().normalize();
        Path file = source.toAbsolutePath().normalize();
        if (!file.startsWith(root)) throw new IllegalArgumentException("源路径不属于监控目录");
        List<String> parents = new ArrayList<>();
        for (Path parent = file.getParent(); parent != null && !parent.equals(root) && parent.startsWith(root)
                && parents.size() < 4; parent = parent.getParent()) {
            parents.add(parent.getFileName().toString());
        }
        List<String> siblings;
        try (var paths = Files.list(file.getParent())) {
            siblings = paths.filter(Files::isRegularFile).map(p -> p.getFileName().toString())
                    .filter(n -> n.matches("(?i).+\\.(mkv|mp4|avi|mov|m4v|wmv|flv|ts|m2ts|rmvb|iso)$"))
                    .sorted().limit(81).toList();
        }
        Map<String, Object> original = new LinkedHashMap<>();
        original.put("title", parsed.getTitle());
        original.put("year", parsed.getYear());
        original.put("type", parsed.getType());
        original.put("season", parsed.getSeason());
        original.put("episode", parsed.getEpisode());
        Map<String, Object> context = new LinkedHashMap<>();
        context.put("filename", file.getFileName().toString());
        context.put("parents", parents);
        context.put("siblings", siblings.size() > 80 ? siblings.subList(0, 80) : siblings);
        context.put("siblings_truncated", siblings.size() > 80);
        context.put("parsed", original);
        return context;
    }

    public record Suggestion(ParseResult parsed, double confidence, String reason) {}
}
