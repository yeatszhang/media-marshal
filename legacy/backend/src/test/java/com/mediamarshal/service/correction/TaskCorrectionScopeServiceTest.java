package com.mediamarshal.service.correction;

import com.mediamarshal.model.dto.TaskCorrectionScopesResponse;
import com.mediamarshal.model.entity.MediaAssetType;
import com.mediamarshal.model.entity.MediaTask;
import com.mediamarshal.repository.MediaTaskRepository;
import org.junit.jupiter.api.Test;

import java.time.LocalDateTime;
import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class TaskCorrectionScopeServiceTest {

    @Test
    void resolvesCompleteSeasonAndSeriesRangesInStableEpisodeOrder() {
        MediaTaskRepository repository = mock(MediaTaskRepository.class);
        TaskCorrectionScopeService service = new TaskCorrectionScopeService(repository);
        MediaTask episode2 = task(1L, 1, 2, "Show.S01E02.mkv");
        MediaTask episode10 = task(2L, 1, 10, "Show.S01E10.mkv");
        MediaTask season2 = task(3L, 2, 1, "Show.S02E01.mkv");
        when(repository.findById(1L)).thenReturn(Optional.of(episode2));
        when(repository.findByStatusAndMediaTypeAndTmdbIdAndRuleId(
                MediaTask.TaskStatus.DONE, MediaTask.MediaType.TV_SHOW, 1978L, 9L
        )).thenReturn(List.of(season2, episode10, episode2));
        when(repository.findByStatusAndMediaTypeAndTmdbIdAndRuleIdAndParsedSeason(
                MediaTask.TaskStatus.DONE, MediaTask.MediaType.TV_SHOW, 1978L, 9L, 1
        )).thenReturn(List.of(episode10, episode2));

        TaskCorrectionScopesResponse scopes = service.getScopes(1L);
        TaskCorrectionResolvedScope season = service.resolve(1L, "SAME_SEASON");
        TaskCorrectionResolvedScope series = service.resolve(1L, "SAME_SERIES");

        assertThat(scopes.batchSupported()).isTrue();
        assertThat(scopes.sameSeasonCount()).isEqualTo(2);
        assertThat(scopes.sameSeriesCount()).isEqualTo(3);
        assertThat(scopes.minSeason()).isEqualTo(1);
        assertThat(scopes.maxSeason()).isEqualTo(2);
        assertThat(season.tasks()).extracting(MediaTask::getId).containsExactly(1L, 2L);
        assertThat(series.tasks()).extracting(MediaTask::getId).containsExactly(1L, 2L, 3L);
        assertThat(series.groupFingerprint()).hasSize(64);
    }

    @Test
    void fingerprintChangesWhenTaskSnapshotChanges() {
        MediaTaskRepository repository = mock(MediaTaskRepository.class);
        TaskCorrectionScopeService service = new TaskCorrectionScopeService(repository);
        MediaTask anchor = task(1L, 1, 1, "Show.S01E01.mkv");
        when(repository.findById(1L)).thenReturn(Optional.of(anchor));
        when(repository.findByStatusAndMediaTypeAndTmdbIdAndRuleId(
                MediaTask.TaskStatus.DONE, MediaTask.MediaType.TV_SHOW, 1978L, 9L
        )).thenAnswer(ignored -> List.of(anchor));

        String before = service.resolve(1L, "SAME_SERIES").groupFingerprint();
        anchor.setTargetPath("/library/Changed.S01E01.mkv");
        anchor.setUpdatedAt(anchor.getUpdatedAt().plusSeconds(1));
        String after = service.resolve(1L, "SAME_SERIES").groupFingerprint();

        assertThat(after).isNotEqualTo(before);
    }

    private MediaTask task(Long id, int season, int episode, String filename) {
        MediaTask task = new MediaTask();
        task.setId(id);
        task.setStatus(MediaTask.TaskStatus.DONE);
        task.setMediaType(MediaTask.MediaType.TV_SHOW);
        task.setAssetType(MediaAssetType.VIDEO_FILE);
        task.setTmdbId(1978L);
        task.setRuleId(9L);
        task.setParsedSeason(season);
        task.setParsedEpisode(episode);
        task.setTargetPath("/library/" + filename);
        task.setUpdatedAt(LocalDateTime.of(2026, 8, 29, 1, 0));
        return task;
    }
}
