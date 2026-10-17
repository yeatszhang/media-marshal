package com.mediamarshal.service.matcher;

import com.mediamarshal.model.dto.MatchResult;
import com.mediamarshal.model.dto.TmdbEpisode;
import com.mediamarshal.model.dto.TmdbSeason;
import com.mediamarshal.model.entity.MediaTask;
import com.mediamarshal.model.exception.EpisodeMetadataException;
import com.mediamarshal.service.parser.EpisodeSeasonResolver;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.Mockito.*;

class TmdbEpisodeServiceTest {
    private final MetadataMatcher matcher = mock(MetadataMatcher.class);
    private final TmdbEpisodeService service = new TmdbEpisodeService(matcher);

    @Test
    void jujutsuKaisenRetainsEpisode48WhenSourceSeasonThreeMapsToSingleMetadataSeason() {
        Path source = Path.of("/咒术回战/S03/[BeanSub&FZSD][Jujutsu_Kaisen][48][GB][1080P][x264_AAC].mp4");
        MediaTask task = task(EpisodeSeasonResolver.resolve(null, null, source), 48, null);
        task.setSourcePath(source.toString());
        MatchResult detail = detail(new TmdbSeason(0, 1), new TmdbSeason(1, 48));
        detail.setSourceId("95479");
        detail.setTitle("咒术回战");
        // 按反馈构造单季元数据，验证编号规则，不依赖线上季列表。
        when(matcher.getSeasonEpisodes("95479", 1)).thenReturn(List.of(new TmdbEpisode(1, 48, "")));

        assertThat(task.getParsedSeason()).isEqualTo(3);
        assertThat(service.reconcile(task, detail)).isTrue();
        assertThat(task.getParsedSeason()).isEqualTo(1);
        assertThat(task.getParsedEpisode()).isEqualTo(48);
        assertThat(task.getSourcePath()).isEqualTo(source.toString());
        assertThat(task.getMetadataWarning()).contains("S03E48", "S01E48");
        verify(matcher).getSeasonEpisodes("95479", 1);
    }

    @Test
    void blueBoxUsesTmdbSeasonOneAndRetainsAbsoluteEpisodeNumber() {
        MediaTask task = task(2, 26, null);
        MatchResult detail = detail(new TmdbSeason(1, 37));
        when(matcher.getSeasonEpisodes("207347", 1)).thenReturn(List.of(new TmdbEpisode(1, 26, "似曾相识")));

        assertThat(service.reconcile(task, detail)).isTrue();
        assertThat(task.getParsedSeason()).isEqualTo(1);
        assertThat(task.getParsedEpisode()).isEqualTo(26);
        assertThat(detail.getEpisodeTitle()).isEqualTo("似曾相识");
        assertThat(task.getMetadataWarning()).contains("S02E26", "S01E26", "TMDB");
        assertThat(service.reconcile(task, detail)).isFalse();
        assertThat(task.getMetadataWarning()).contains("S02E26");
    }

    @Test
    void validSeasonIsNotChangedEvenWhenOtherSeasonsHaveSameEpisode() {
        MediaTask task = task(2, 1, null);
        MatchResult detail = detail(new TmdbSeason(1, 25), new TmdbSeason(2, 12));
        when(matcher.getSeasonEpisodes("207347", 2)).thenReturn(List.of(new TmdbEpisode(2, 1, "第二季首集")));
        assertThat(service.reconcile(task, detail)).isFalse();
        assertThat(task.getParsedSeason()).isEqualTo(2);
        assertThat(task.getMetadataWarning()).isNull();
    }

    @Test
    void missingTitleDoesNotMeanEpisodeDoesNotExist() {
        MediaTask task = task(1, 26, null);
        MatchResult detail = detail(new TmdbSeason(1, 37));
        when(matcher.getSeasonEpisodes("207347", 1)).thenReturn(List.of(new TmdbEpisode(1, 26, "")));
        assertThat(service.reconcile(task, detail)).isFalse();
        assertThat(detail.getEpisodeTitle()).isNull();
    }

    @Test
    void doesNotGuessOffsetsForMultiSeasonSeries() {
        MediaTask task = task(2, 26, null);
        MatchResult detail = detail(new TmdbSeason(1, 25), new TmdbSeason(2, 12));
        when(matcher.getSeasonEpisodes("207347", 2)).thenReturn(List.of(new TmdbEpisode(2, 1, "首集")));
        assertThatThrownBy(() -> service.reconcile(task, detail))
                .isInstanceOf(EpisodeMetadataException.class).hasMessageContaining("不存在第 26 集");
        assertThat(task.getParsedEpisode()).isEqualTo(26);
    }

    @Test
    void missingSeasonInMultiSeasonSeriesIsAmbiguous() {
        MediaTask task = task(3, 1, null);
        assertThatThrownBy(() -> service.reconcile(task, detail(new TmdbSeason(1, 25), new TmdbSeason(2, 12))))
                .hasMessageContaining("无法唯一映射");
        verify(matcher).getSeasonEpisodes("207347", 1);
        verify(matcher).getSeasonEpisodes("207347", 2);
    }

    @Test
    void existingPathSeasonWithoutEpisodeIsCorrectedUsingActualEpisodeLists() {
        MediaTask task = task(3, 48, null);
        MatchResult detail = detail(new TmdbSeason(1, 48), new TmdbSeason(2, 12), new TmdbSeason(3, 12));
        when(matcher.getSeasonEpisodes("207347", 3)).thenReturn(List.of(new TmdbEpisode(3, 1, "第三季首集")));
        when(matcher.getSeasonEpisodes("207347", 2)).thenReturn(List.of(new TmdbEpisode(2, 1, "第二季首集")));
        when(matcher.getSeasonEpisodes("207347", 1)).thenReturn(List.of(new TmdbEpisode(1, 48, "累计第48集")));

        assertThat(service.reconcile(task, detail)).isTrue();
        assertThat(task.getParsedSeason()).isEqualTo(1);
        assertThat(task.getParsedEpisode()).isEqualTo(48);
        assertThat(detail.getEpisodeTitle()).isEqualTo("累计第48集");
    }

    @Test
    void multipleSeasonsContainingTheEpisodeRemainAmbiguous() {
        MediaTask task = task(3, 48, null);
        MatchResult detail = detail(new TmdbSeason(1, 48), new TmdbSeason(2, 48));
        when(matcher.getSeasonEpisodes("207347", 1)).thenReturn(List.of(new TmdbEpisode(1, 48, "第一季")));
        when(matcher.getSeasonEpisodes("207347", 2)).thenReturn(List.of(new TmdbEpisode(2, 48, "第二季")));

        assertThatThrownBy(() -> service.reconcile(task, detail)).hasMessageContaining("多个正片季", "无法唯一映射");
        assertThat(task.getParsedSeason()).isEqualTo(3);
        assertThat(task.getMetadataWarning()).isNull();
    }

    @Test
    void seasonEpisodeCountAloneCannotProveTheEpisodeExists() {
        MediaTask task = task(3, 48, null);
        when(matcher.getSeasonEpisodes("207347", 1)).thenReturn(List.of(new TmdbEpisode(1, 47, "第47集")));
        assertThatThrownBy(() -> service.reconcile(task, detail(new TmdbSeason(1, 100))))
                .hasMessageContaining("不存在第 48 集", "已暂停文件整理");
        assertThat(task.getParsedSeason()).isEqualTo(3);
    }

    @Test
    void anotherSeasonMustBeAvailableToProveTheMappingIsUnique() {
        MediaTask task = task(3, 48, null);
        when(matcher.getSeasonEpisodes("207347", 1)).thenReturn(List.of(new TmdbEpisode(1, 48, "第48集")));
        when(matcher.getSeasonEpisodes("207347", 2)).thenThrow(new IllegalStateException("HTTP 503"));
        assertThatThrownBy(() -> service.reconcile(task, detail(new TmdbSeason(1, 48), new TmdbSeason(2, 48))))
                .hasMessageContaining("HTTP 503", "已暂停文件整理");
        assertThat(task.getParsedSeason()).isEqualTo(3);
    }

    @Test
    void specialsAreNeverMappedToRegularSeason() {
        assertThatThrownBy(() -> service.reconcile(task(0, 1, null), detail(new TmdbSeason(1, 37))))
                .hasMessageContaining("无法唯一映射");
        verifyNoInteractions(matcher);
    }

    @Test
    void validatesEveryEpisodeInMergedRangeBeforeChangingSeason() {
        MediaTask task = task(2, 26, 28);
        MatchResult detail = detail(new TmdbSeason(1, 37));
        when(matcher.getSeasonEpisodes("207347", 1)).thenReturn(List.of(
                new TmdbEpisode(1, 26, "首集"), new TmdbEpisode(1, 28, "末集")));
        assertThatThrownBy(() -> service.reconcile(task, detail)).hasMessageContaining("不存在第 27 集");
        assertThat(task.getParsedSeason()).isEqualTo(2);
        assertThat(task.getMetadataWarning()).isNull();
    }

    @Test
    void mapsMergedRangeWhenEveryEpisodeExists() {
        MediaTask task = task(2, 26, 27);
        MatchResult detail = detail(new TmdbSeason(1, 37));
        when(matcher.getSeasonEpisodes("207347", 1)).thenReturn(List.of(
                new TmdbEpisode(1, 26, "首集"), new TmdbEpisode(1, 27, "次集")));
        assertThat(service.reconcile(task, detail)).isTrue();
        assertThat(task.getParsedEpisodeEnd()).isEqualTo(27);
        assertThat(detail.getEpisodeTitle()).isNull();
    }

    @Test
    void missingTmdbSeasonListCannotBypassValidation() {
        assertThatThrownBy(() -> service.reconcile(task(1, 1, null), detail()))
                .hasMessageContaining("TMDB 未提供季列表");
    }

    @Test
    void networkFailureDoesNotFallBackToFilename() {
        MediaTask task = task(2, 26, null);
        when(matcher.getSeasonEpisodes("207347", 1)).thenThrow(new IllegalStateException("HTTP 503"));
        assertThatThrownBy(() -> service.reconcile(task, detail(new TmdbSeason(1, 37))))
                .hasMessageContaining("获取失败").hasMessageContaining("HTTP 503");
        assertThat(task.getParsedSeason()).isEqualTo(2);
    }

    @Test
    void seasonZeroCanBeValidatedNormally() {
        MediaTask task = task(0, 1, null);
        when(matcher.getSeasonEpisodes("207347", 0)).thenReturn(List.of(new TmdbEpisode(0, 1, "特别篇")));
        assertThat(service.reconcile(task, detail(new TmdbSeason(0, 1), new TmdbSeason(1, 37)))).isFalse();
    }

    private MediaTask task(int season, int episode, Integer end) {
        MediaTask task = new MediaTask();
        task.setMediaType(MediaTask.MediaType.TV_SHOW);
        task.setParsedSeason(season);
        task.setParsedEpisode(episode);
        task.setParsedEpisodeEnd(end);
        return task;
    }

    private MatchResult detail(TmdbSeason... seasons) {
        MatchResult result = new MatchResult();
        result.setSourceId("207347");
        result.setMediaType("TV_SHOW");
        result.setSeasons(List.of(seasons));
        return result;
    }
}
