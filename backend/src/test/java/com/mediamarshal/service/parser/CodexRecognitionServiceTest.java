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
    void disabledDoesNotCallBridge() {
        when(settings.get("codex.enabled", "false")).thenReturn("false");
        assertThat(service.recognize(Path.of("/missing"), rule(), new ParseResult())).isEmpty();
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
}
