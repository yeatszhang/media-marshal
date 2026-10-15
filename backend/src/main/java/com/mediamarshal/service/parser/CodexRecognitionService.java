package com.mediamarshal.service.parser;

import com.fasterxml.jackson.databind.JsonNode;
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
        if (!isEnabled()) return Optional.empty();
        try {
            String url = settings.get("codex.bridge-url", "http://host.docker.internal:18081");
            String token = settings.get("codex.bridge-token", "");
            if (token.isBlank()) return Optional.empty();
            JsonNode response = webClientBuilder.build().post().uri(url + "/recognize")
                    .header("X-Media-Marshal-Token", token)
                    .bodyValue(buildContext(source, rule, original)).retrieve()
                    .bodyToMono(JsonNode.class).block(Duration.ofSeconds(240));
            return parseSuggestion(response, rule, original);
        } catch (Exception e) {
            // 不记录响应正文或凭据；桥接不可用时继续原有人工确认流程。
            log.warn("Codex 辅助解析不可用：{}", e.getClass().getSimpleName());
            return Optional.empty();
        }
    }

    Optional<Suggestion> parseSuggestion(JsonNode response, WatchRule rule, ParseResult original) {
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
            result.setOriginalFilename(original.getOriginalFilename());
            result.setScreenSize(original.getScreenSize());
            result.setVideoCodec(original.getVideoCodec());
            result.setReleaseGroup(original.getReleaseGroup());
            if (type.equals("episode")) {
                // 季集号优先保留规则解析结果，避免模型覆盖明确的 SxxExx。
                result.setSeason(original.getSeason() != null ? original.getSeason() : integer(response, "season", 0, 999));
                result.setEpisode(original.getEpisode() != null ? original.getEpisode() : integer(response, "episode", 1, 10000));
                result.setEpisodeEnd(original.getEpisodeEnd());
            }
            String reason = response.path("reason").asText("");
            return Optional.of(new Suggestion(result, confidence, reason.substring(0, Math.min(500, reason.length()))));
        } catch (IllegalArgumentException e) {
            return Optional.empty();
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
            siblings = paths.map(p -> p.getFileName().toString())
                    .filter(n -> n.matches("(?i).+\\.(mkv|mp4|avi|mov|m4v|ts|iso)$"))
                    .sorted().limit(80).toList();
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
        context.put("siblings", siblings);
        context.put("parsed", original);
        return context;
    }

    public record Suggestion(ParseResult parsed, double confidence, String reason) {}
}
