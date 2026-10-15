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
        original.setSeason(2);
        original.setEpisode(3);
        original.setEpisodeEnd(4);
        var result = service.parseSuggestion(mapper.readTree("""
                {"status":"identified","title":"示例剧集","type":"episode","year":2024,
                 "season":9,"episode":8,"confidence":0.95,"reason":"目录中含正式片名"}
                """), rule(), original).orElseThrow().parsed();
        assertThat(result.getTitle()).isEqualTo("示例剧集");
        assertThat(result.getSeason()).isEqualTo(2);
        assertThat(result.getEpisode()).isEqualTo(3);
        assertThat(result.getEpisodeEnd()).isEqualTo(4);
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
