package com.mediamarshal.service.parser;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.mediamarshal.model.dto.ParseResult;
import com.mediamarshal.model.entity.WatchRule;
import com.mediamarshal.service.settings.SettingsService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.web.reactive.function.client.WebClient;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.*;

class CodexRecognitionServiceTest {
    private final SettingsService settings = mock(SettingsService.class);
    private final WebClient.Builder builder = mock(WebClient.Builder.class);
    private final CodexRecognitionService service = new CodexRecognitionService(settings, builder);
    private final ObjectMapper mapper = new ObjectMapper();

    private WatchRule rule() {
        WatchRule rule = new WatchRule();
        rule.setMediaType(WatchRule.RuleMediaType.AUTO);
        return rule;
    }

    @Test
    void reliableResultsNoLongerReadLegacyForcedApprovalSetting() {
        assertThat(service.requiresConfirmation(0.9)).isFalse();
        assertThat(service.requiresConfirmation(0.99)).isFalse();
        assertThat(service.requiresConfirmation(0.89)).isTrue();
        assertThat(service.requiresConfirmation(Double.NaN)).isTrue();
        verifyNoInteractions(settings);
    }

    @Test
    void disabledDoesNotCallBridge() {
        when(settings.get("codex.enabled", "false")).thenReturn("false");
        assertThat(service.recognize(Path.of("/missing"), rule(), new ParseResult())).isEmpty();
        assertThat(service.recognizeCluster(Path.of("/missing"), rule(), new ParseResult()).clustered()).isFalse();
        verifyNoInteractions(builder);
    }

    @Test
    void movieRulesAndMissingTokenNeverRequestClusterBridge() {
        when(settings.get("codex.enabled", "false")).thenReturn("true");
        WatchRule movieRule = rule();
        movieRule.setMediaType(WatchRule.RuleMediaType.MOVIE);
        assertThat(service.recognizeCluster(Path.of("/missing"), movieRule, new ParseResult()).clustered()).isFalse();
        when(settings.get("codex.bridge-token", "")).thenReturn("");
        assertThat(service.recognizeCluster(Path.of("/missing"), rule(), new ParseResult()).clustered()).isFalse();
        verifyNoInteractions(builder);
    }

    @Test
    void explicitSeasonAndEpisodeOverrideModelGuess() throws Exception {
        ParseResult original = new ParseResult();
        original.setOriginalFilename("01.mkv");
        original.setSeason(2);
        original.setEpisode(3);
        original.setEpisodeEnd(4);
        var result = service.parseSuggestion(mapper.readTree("""
                {"status":"identified","title":"示例剧集","type":"episode","year":2024,
                 "season":9,"episode":8,"confidence":0.95,"reason":"目录中含正式片名"}
                """), rule(), original).orElseThrow().parsed();
        assertThat(result.getTitle()).isEqualTo("示例剧集");
        assertThat(result.getOriginalFilename()).isEqualTo("示例剧集");
        assertThat(original.getOriginalFilename()).isEqualTo("01.mkv");
        assertThat(result.getSeason()).isEqualTo(2);
        assertThat(result.getEpisode()).isEqualTo(3);
        assertThat(result.getEpisodeEnd()).isEqualTo(4);
    }

    @Test
    void missingSeasonDefaultsToFirstWithoutInventingEpisode() throws Exception {
        var result = service.parseSuggestion(mapper.readTree("""
                {"status":"identified","title":"某剧","type":"episode","season":null,"episode":null,"confidence":0.96}
                """), rule(), new ParseResult()).orElseThrow().parsed();
        assertThat(result.getSeason()).isEqualTo(1);
        assertThat(result.getEpisode()).isNull();
        var movie = service.parseSuggestion(mapper.readTree("""
                {"status":"identified","title":"电影","type":"movie","confidence":0.96}
                """), rule(), new ParseResult()).orElseThrow().parsed();
        assertThat(movie.getSeason()).isNull();
    }

    @Test
    void rejectsUnknownWeakOrInvalidResults() throws Exception {
        for (String value : new String[]{
                "{\"status\":\"unknown\",\"title\":\"猜测\",\"type\":\"movie\",\"confidence\":0.99}",
                "{\"status\":\"identified\",\"title\":\"猜测\",\"type\":\"movie\",\"confidence\":0.4}",
                "{\"status\":\"identified\",\"title\":\"影片\",\"type\":\"movie\",\"year\":2,\"confidence\":0.99}"}) {
            assertThat(service.parseSuggestion(mapper.readTree(value), rule(), new ParseResult())).isEmpty();
        }
    }

    @Test
    void respectsExplicitRuleMediaType() throws Exception {
        WatchRule rule = rule();
        rule.setMediaType(WatchRule.RuleMediaType.MOVIE);
        assertThat(service.parseSuggestion(mapper.readTree("""
                {"status":"identified","title":"剧集","type":"episode","confidence":0.99}
                """), rule, new ParseResult())).isEmpty();
    }

    @Test
    void directoryPreservesEachFileCoordinatesAndEpisodeRange() throws Exception {
        ParseResult first = new ParseResult();
        first.setSeason(2);
        first.setEpisode(8);
        ParseResult second = new ParseResult();
        var response = mapper.readTree("""
                {"status":"identified","title":"正式剧名","type":"episode","year":2026,
                 "confidence":0.96,"reason":"目录依据","files":[
                 {"filename":"01.mkv","season":1,"episode":1,"episode_end":null},
                 {"filename":"02-03.mkv","season":null,"episode":2,"episode_end":3}]}
                """);
        var results = service.parseDirectorySuggestions(response, rule(), Map.of("01.mkv", first, "02-03.mkv", second));
        assertThat(results).hasSize(2);
        assertThat(results.get("01.mkv").parsed().getSeason()).isEqualTo(2);
        assertThat(results.get("01.mkv").parsed().getEpisode()).isEqualTo(8);
        assertThat(results.get("02-03.mkv").parsed().getSeason()).isEqualTo(1);
        assertThat(results.get("02-03.mkv").parsed().getEpisodeEnd()).isEqualTo(3);
    }

    @Test
    void directoryRejectsMissingDuplicateForeignOrInvalidFiles() throws Exception {
        var originals = Map.of("01.mkv", new ParseResult(), "02.mkv", new ParseResult());
        for (String files : new String[]{
                "[{\"filename\":\"01.mkv\",\"season\":1,\"episode\":1}]",
                "[{\"filename\":\"01.mkv\"},{\"filename\":\"01.mkv\"}]",
                "[{\"filename\":\"01.mkv\"},{\"filename\":\"other.mkv\"}]",
                "[{\"filename\":\"01.mkv\",\"episode\":true},{\"filename\":\"02.mkv\"}]"}) {
            var response = mapper.readTree("""
                    {"status":"identified","title":"剧名","type":"episode","confidence":0.96,"files":%s}
                    """.formatted(files));
            assertThat(service.parseDirectorySuggestions(response, rule(), originals)).isEmpty();
        }
    }

    @Test
    void contextIsBoundedToWatchedRoot(@TempDir Path root) throws Exception {
        WatchRule rule = rule();
        rule.setSourceDir(root.toString());
        Path season = Files.createDirectories(root.resolve("剧名/Season 01"));
        Path video = Files.writeString(season.resolve("01.mkv"), "video");
        Files.writeString(season.resolve("02.mkv"), "video");
        Files.writeString(season.resolve("secret.txt"), "不应发送的内容");
        var context = service.buildContext(video, rule, new ParseResult());
        assertThat(context.get("parents").toString()).contains("剧名", "Season 01").doesNotContain(root.toString());
        assertThat(context.get("siblings").toString()).contains("01.mkv", "02.mkv").doesNotContain("secret.txt");
        assertThatThrownBy(() -> service.buildContext(root.resolve("../outside.mkv"), rule, new ParseResult()))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void clusterScopeSharesSeriesAcrossSeasonsButNotOtherPathsOrRules(@TempDir Path root) throws Exception {
        WatchRule rule = rule();
        rule.setId(1L);
        rule.setSourceDir(root.toString());
        Path first = Files.writeString(Files.createDirectories(root.resolve("小城日常/S01")).resolve("01.mp4"), "video");
        Path second = Files.writeString(Files.createDirectories(root.resolve("小城日常/Season 02")).resolve("02.mp4"), "video");
        String scope = service.buildContext(first, rule, new ParseResult()).get("cluster_scope").toString();
        assertThat(scope).matches("[a-f0-9]{64}");
        assertThat(service.buildContext(second, rule, new ParseResult()).get("cluster_scope")).isEqualTo(scope);
        for (String name : new String[]{"第三季", "特别篇", "Specials"}) {
            Path video = Files.writeString(Files.createDirectories(root.resolve("小城日常/" + name)).resolve("01.mp4"), "video");
            assertThat(service.buildContext(video, rule, new ParseResult()).get("cluster_scope")).isEqualTo(scope);
        }
        rule.setId(2L);
        assertThat(service.buildContext(first, rule, new ParseResult()).get("cluster_scope")).isNotEqualTo(scope);
        rule.setId(1L);
        Path other = Files.writeString(Files.createDirectories(root.resolve("另一部剧/S01")).resolve("01.mp4"), "video");
        assertThat(service.buildContext(other, rule, new ParseResult()).get("cluster_scope")).isNotEqualTo(scope);
    }

    @Test
    void clusterContextMarksTruncatedSiblings(@TempDir Path root) throws Exception {
        WatchRule rule = rule();
        rule.setSourceDir(root.toString());
        Path directory = Files.createDirectories(root.resolve("长篇动画/S01"));
        for (int n = 1; n <= 81; n++) Files.writeString(directory.resolve(n + ".mp4"), "video");
        var context = service.buildContext(directory.resolve("1.mp4"), rule, new ParseResult());
        assertThat(context.get("siblings_truncated")).isEqualTo(true);
        assertThat((java.util.List<?>) context.get("siblings")).hasSize(80);
    }

    @Test
    void clusterBridgePreservesExplicitCoordinatesAndReturnsHandledUnknown(@TempDir Path root) throws Exception {
        WatchRule rule = rule();
        rule.setSourceDir(root.toString());
        Path source = Files.writeString(root.resolve("01.mp4"), "video");
        var response = new java.util.concurrent.atomic.AtomicReference<>("""
                {"clustered":true,"status":"identified","title":"同一作品","type":"episode","year":2025,
                 "season":9,"episode":8,"episode_end":null,"confidence":0.87,"reason":"同簇身份"}
                """);
        var request = new java.util.concurrent.atomic.AtomicReference<com.fasterxml.jackson.databind.JsonNode>();
        var server = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/recognize-cluster", exchange -> {
            request.set(mapper.readTree(exchange.getRequestBody().readAllBytes()));
            byte[] data = response.get().getBytes(java.nio.charset.StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, data.length);
            exchange.getResponseBody().write(data);
            exchange.close();
        });
        server.start();
        try {
            when(settings.get(anyString(), anyString())).thenAnswer(invocation -> invocation.getArgument(1));
            when(settings.get("codex.enabled", "false")).thenReturn("true");
            when(settings.get("codex.bridge-token", "")).thenReturn("test-token");
            when(settings.get("codex.bridge-url", "http://host.docker.internal:18081"))
                    .thenReturn("http://127.0.0.1:" + server.getAddress().getPort());
            var client = new CodexRecognitionService(settings, WebClient.builder());
            ParseResult original = new ParseResult();
            original.setSeason(2);
            original.setEpisode(3);
            original.setEpisodeEnd(4);
            var result = client.recognizeCluster(source, rule, original);
            assertThat(result.clustered()).isTrue();
            assertThat(result.suggestion().orElseThrow().parsed().getSeason()).isEqualTo(2);
            assertThat(result.suggestion().orElseThrow().parsed().getEpisode()).isEqualTo(3);
            assertThat(result.suggestion().orElseThrow().parsed().getEpisodeEnd()).isEqualTo(4);
            assertThat(request.get().path("cluster_scope").asText()).hasSize(64);
            original = new ParseResult();
            response.set("""
                    {"clustered":true,"status":"identified","title":"同一作品","type":"episode",
                     "season":2,"episode":3,"episode_end":4,"confidence":0.87}
                    """);
            var merged = client.recognizeCluster(source, rule, original).suggestion().orElseThrow().parsed();
            assertThat(merged.getSeason()).isEqualTo(2);
            assertThat(merged.getEpisode()).isEqualTo(3);
            assertThat(merged.getEpisodeEnd()).isEqualTo(4);
            for (String invalidEnd : new String[]{"true", "2", "10001", "\"4\""}) {
                response.set("""
                        {"clustered":true,"status":"identified","title":"同一作品","type":"episode",
                         "season":2,"episode":3,"episode_end":%s,"confidence":0.87}
                        """.formatted(invalidEnd));
                var invalid = client.recognizeCluster(source, rule, original);
                assertThat(invalid.clustered()).isTrue();
                assertThat(invalid.suggestion()).isEmpty();
            }
            response.set("""
                    {"clustered":true,"status":"identified","title":"电影","type":"movie","confidence":0.99}
                    """);
            assertThat(client.recognizeCluster(source, rule, original).suggestion()).isEmpty();
            response.set("{\"clustered\":true,\"status\":\"unknown\"}");
            var unknown = client.recognizeCluster(source, rule, original);
            assertThat(unknown.clustered()).isTrue();
            assertThat(unknown.suggestion()).isEmpty();
            response.set("{\"clustered\":false,\"status\":\"unknown\"}");
            assertThat(client.recognizeCluster(source, rule, original).clustered()).isFalse();
        } finally {
            server.stop(0);
        }
    }
}
