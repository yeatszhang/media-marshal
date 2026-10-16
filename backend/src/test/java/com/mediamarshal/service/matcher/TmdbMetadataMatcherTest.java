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
    void keepsSearchYearForFirstSeasonTv() {
        assertThat(TmdbMetadataMatcher.resolveSearchYear("tv", parse("episode", 2025, 1))).isEqualTo(2025);
    }

    @Test
    void keepsSearchYearForMovies() {
        assertThat(TmdbMetadataMatcher.resolveSearchYear("movie", parse("movie", 2025, null))).isEqualTo(2025);
    }

    private ParseResult parse(String type, Integer year, Integer season) {
        ParseResult parseResult = new ParseResult();
        parseResult.setType(type);
        parseResult.setYear(year);
        parseResult.setSeason(season);
        return parseResult;
    }
}
