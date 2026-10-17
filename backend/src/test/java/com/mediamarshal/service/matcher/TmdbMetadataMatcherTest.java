package com.mediamarshal.service.matcher;

import com.mediamarshal.model.dto.ParseResult;
import com.mediamarshal.model.dto.TmdbEpisode;
import com.mediamarshal.model.dto.TmdbSeason;
import com.mediamarshal.service.settings.SettingsService;
import com.mediamarshal.service.settings.TmdbProxySettingsService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.reactive.function.client.ClientResponse;
import org.springframework.web.reactive.function.client.ExchangeFunction;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class TmdbMetadataMatcherTest {
    private final SettingsService settings = mock(SettingsService.class);
    private final TmdbProxySettingsService proxy = mock(TmdbProxySettingsService.class);
    private final ExchangeFunction exchange = mock(ExchangeFunction.class);
    private TmdbMetadataMatcher matcher;

    @BeforeEach
    void setUp() {
        when(settings.get(anyString(), anyString())).thenAnswer(call -> call.getArgument(1));
        when(proxy.resolve()).thenReturn(new TmdbProxySettingsService.TmdbProxyConfig(false, "", null, -1));
        matcher = new TmdbMetadataMatcher(settings, proxy, WebClient.builder().exchangeFunction(exchange),
                mock(TitleSearchPlanBuilder.class), new TmdbInMemoryCache(settings), new TmdbConfidenceScorer());
    }

    @Test
    void fetchesTmdbSeasonStructureAndKeepsCachedDetailsIsolated() {
        when(exchange.exchange(any())).thenReturn(response("""
                {"id":207347,"name":"青之箱","original_name":"アオのハコ","first_air_date":"2024-10-03",
                 "seasons":[{"season_number":1,"episode_count":37}]}
                """));
        var first = matcher.getById("207347", "TV_SHOW");
        first.setTitle("被任务修改的标题");
        first.setEpisodeTitle("某一集");
        var second = matcher.getById("207347", "TV_SHOW");
        assertThat(second.getTitle()).isEqualTo("青之箱");
        assertThat(second.getEpisodeTitle()).isNull();
        assertThat(second.getSeasons()).containsExactly(new TmdbSeason(1, 37));
        verify(exchange, times(1)).exchange(any());
    }

    @Test
    void fetchesAndCachesSeasonEpisodesIncludingMissingTitles() {
        when(exchange.exchange(any())).thenReturn(response("""
                {"season_number":1,"episodes":[
                  {"season_number":1,"episode_number":26,"name":"似曾相识"},
                  {"season_number":1,"episode_number":27,"name":null}]}
                """));
        assertThat(matcher.getSeasonEpisodes("207347", 1)).containsExactly(
                new TmdbEpisode(1, 26, "似曾相识"), new TmdbEpisode(1, 27, null));
        matcher.getSeasonEpisodes("207347", 1);
        verify(exchange).exchange(argThat(request -> request.url().getPath().equals("/3/tv/207347/season/1")));
    }

    @Test
    void rejectsWrongSeasonInTmdbResponse() {
        when(exchange.exchange(any())).thenReturn(response("""
                {"season_number":2,"episodes":[{"season_number":2,"episode_number":1,"name":"错误季"}]}
                """));
        assertThatThrownBy(() -> matcher.getSeasonEpisodes("207347", 1)).hasMessageContaining("有效分集信息");
    }

    @Test
    void tmdb404CannotBecomeAnEmptySuccessfulSeason() {
        when(exchange.exchange(any())).thenReturn(Mono.just(ClientResponse.create(HttpStatus.NOT_FOUND).build()));
        assertThatThrownBy(() -> matcher.getSeasonEpisodes("207347", 2)).hasMessageContaining("404");
    }

    private Mono<ClientResponse> response(String json) {
        return Mono.just(ClientResponse.create(HttpStatus.OK).header("Content-Type", "application/json").body(json).build());
    }

    @Test
    void omitsSearchYearForLaterSeasonTv() {
        assertThat(TmdbMetadataMatcher.resolveSearchYear("tv", parse("episode", 2025, 2))).isNull();
    }

    @Test
    void reportsRateLimitAndRetryDelay() {
        when(exchange.exchange(any())).thenReturn(Mono.just(ClientResponse.create(HttpStatus.TOO_MANY_REQUESTS)
                .header("Retry-After", "15").build()));
        assertThatThrownBy(() -> matcher.getSeasonEpisodes("95479", 1)).hasMessageContaining("限流").hasMessageContaining("15");
    }

    @Test
    void readsLargeSeasonResponseAndSharesItAcrossEpisodeRequests() throws Exception {
        var requests = new java.util.concurrent.atomic.AtomicInteger();
        var server = com.sun.net.httpserver.HttpServer.create(new java.net.InetSocketAddress("127.0.0.1", 0), 0);
        String episodes = java.util.stream.IntStream.rangeClosed(1, 59).mapToObj(number ->
                "{\"season_number\":1,\"episode_number\":" + number + ",\"name\":\"第" + number
                        + "集\",\"overview\":\"" + "a".repeat(6000) + "\"}")
                .collect(java.util.stream.Collectors.joining(","));
        byte[] body = ("{\"season_number\":1,\"episodes\":[" + episodes + "]}")
                .getBytes(java.nio.charset.StandardCharsets.UTF_8);
        assertThat(body.length).isGreaterThan(262144);
        server.createContext("/tv/95479/season/1", call -> {
            requests.incrementAndGet();
            call.getResponseHeaders().add("Content-Type", "application/json");
            call.sendResponseHeaders(200, body.length);
            try (var output = call.getResponseBody()) { output.write(body); }
        });
        server.start();
        try {
            when(settings.get(eq("tmdb.base-url"), anyString())).thenReturn("http://127.0.0.1:" + server.getAddress().getPort());
            var actual = new TmdbMetadataMatcher(settings, proxy, WebClient.builder(), new TitleSearchPlanBuilder(),
                    new TmdbInMemoryCache(settings), new TmdbConfidenceScorer());
            assertThat(actual.getSeasonEpisodes("95479", 1)).hasSize(59);
            assertThat(actual.getSeasonEpisodes("95479", 1)).hasSize(59);
            assertThat(requests).hasValue(1);
        } finally {
            server.stop(0);
        }
    }

    @Test
    void keepsSearchYearForFirstSeasonTv() {
        assertThat(TmdbMetadataMatcher.resolveSearchYear("tv", parse("episode", 2025, 1))).isEqualTo(2025);
    }

    @Test
    void keepsSearchYearForMovies() {
        assertThat(TmdbMetadataMatcher.resolveSearchYear("movie", parse("movie", 2025, null))).isEqualTo(2025);
    }

    @Test
    void searchesCleanAnimeTitleWhenGuessitDidNotReturnTitle() {
        matcher = new TmdbMetadataMatcher(settings, proxy, WebClient.builder().exchangeFunction(exchange),
                new TitleSearchPlanBuilder(), new TmdbInMemoryCache(settings), new TmdbConfidenceScorer());
        when(exchange.exchange(any())).thenReturn(response("""
                {"results":[{"id":95479,"name":"咒术回战","original_name":"呪術廻戦",
                  "first_air_date":"2020-10-03"}]}
                """));
        ParseResult parsed = parse("episode", null, null);
        parsed.setOriginalFilename("[BeanSub&FZSD][Jujutsu_Kaisen][48][GB][1080P][x264_AAC].mp4");
        parsed.setReleaseGroup("BeanSub&FZSD");
        parsed.setEpisode(48);

        var matches = matcher.search(parsed);

        assertThat(matches).singleElement().satisfies(match -> {
            assertThat(match.getSourceId()).isEqualTo("95479");
            assertThat(match.getTitle()).isEqualTo("咒术回战");
            assertThat(match.getMediaType()).isEqualTo("TV_SHOW");
        });
        verify(exchange, times(1)).exchange(argThat(request ->
                request.url().getPath().equals("/3/search/tv")
                        && request.url().getQuery().contains("query=Jujutsu Kaisen&")));
    }

    private ParseResult parse(String type, Integer year, Integer season) {
        ParseResult parseResult = new ParseResult();
        parseResult.setType(type);
        parseResult.setYear(year);
        parseResult.setSeason(season);
        return parseResult;
    }
}
