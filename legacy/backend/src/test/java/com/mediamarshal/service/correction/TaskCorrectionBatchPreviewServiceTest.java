package com.mediamarshal.service.correction;

import com.mediamarshal.model.dto.MatchResult;
import com.mediamarshal.model.dto.TaskCorrectionBatchPreview;
import com.mediamarshal.model.dto.TaskCorrectionBatchRequest;
import com.mediamarshal.model.dto.TaskCorrectionPreview;
import com.mediamarshal.model.entity.MediaAssetType;
import com.mediamarshal.model.entity.MediaTask;
import com.mediamarshal.model.entity.TaskCorrectionBatch;
import com.mediamarshal.repository.MediaTaskRepository;
import com.mediamarshal.repository.TaskCorrectionBatchItemRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class TaskCorrectionBatchPreviewServiceTest {

    private TaskCorrectionScopeService scopeService;
    private TaskCorrectionService correctionService;
    private MediaTaskRepository taskRepository;
    private TaskCorrectionBatchPreviewService service;
    private MediaTask first;
    private MediaTask second;
    private MatchResult match;

    @BeforeEach
    void setUp() {
        scopeService = mock(TaskCorrectionScopeService.class);
        correctionService = mock(TaskCorrectionService.class);
        taskRepository = mock(MediaTaskRepository.class);
        TaskCorrectionBatchItemRepository itemRepository = mock(TaskCorrectionBatchItemRepository.class);
        service = new TaskCorrectionBatchPreviewService(scopeService, correctionService, taskRepository, itemRepository);

        first = task(1L, 1, 1, "/library/Old/Show.S01E01.mkv");
        second = task(2L, 1, 2, "/library/Old/Show.S01E02.mkv");
        when(scopeService.resolve(1L, "SAME_SEASON")).thenReturn(new TaskCorrectionResolvedScope(
                first,
                TaskCorrectionBatch.Scope.SAME_SEASON,
                List.of(first, second),
                "fingerprint"
        ));
        when(taskRepository.findByStatus(MediaTask.TaskStatus.DONE)).thenReturn(List.of(first, second));
        match = match();
        when(correctionService.loadSelectedMatch(2020L, MediaTask.MediaType.TV_SHOW)).thenReturn(match);
    }

    @Test
    void excludedBlockedItemRemainsVisibleButDoesNotBlockSelectedItems() {
        when(correctionService.prepare(eq(1L), any(), eq(match)))
                .thenReturn(plan(first, "/library/New/Show.S01E01.mkv", List.of()));
        when(correctionService.prepare(eq(2L), any(), eq(match)))
                .thenReturn(plan(second, null, List.of("任务缺少集号")));
        TaskCorrectionBatchRequest request = request();
        request.setExcludedTaskIds(List.of(2L));

        TaskCorrectionBatchPreview preview = service.preview(1L, request);

        assertThat(preview.canApply()).isTrue();
        assertThat(preview.totalCount()).isEqualTo(2);
        assertThat(preview.selectedCount()).isEqualTo(1);
        assertThat(preview.applicableCount()).isEqualTo(1);
        assertThat(preview.items()).hasSize(2);
        assertThat(preview.items().get(1).selected()).isFalse();
        assertThat(preview.items().get(1).blockers()).contains("任务缺少集号");
        verify(correctionService).loadSelectedMatch(2020L, MediaTask.MediaType.TV_SHOW);
    }

    @Test
    void duplicateCorrectedTargetsBlockEveryConflictingSelectedItem() {
        String duplicate = "/library/New/Show.S01E01.mkv";
        when(correctionService.prepare(eq(1L), any(), eq(match))).thenReturn(plan(first, duplicate, List.of()));
        when(correctionService.prepare(eq(2L), any(), eq(match))).thenReturn(plan(second, duplicate, List.of()));

        TaskCorrectionBatchPreview preview = service.preview(1L, request());

        assertThat(preview.canApply()).isFalse();
        assertThat(preview.blockerCount()).isGreaterThanOrEqualTo(2);
        assertThat(preview.items()).allSatisfy(item -> assertThat(item.blockers())
                .contains("批次中多个任务生成了相同修正目标路径"));
    }

    private TaskCorrectionBatchRequest request() {
        TaskCorrectionBatchRequest request = new TaskCorrectionBatchRequest();
        request.setScope("SAME_SEASON");
        request.setParsedTitle("万物生灵");
        request.setParsedYear(2020);
        request.setTmdbId(2020L);
        request.setRegenerateNfo(false);
        request.setExcludedTaskIds(List.of());
        return request;
    }

    private TaskCorrectionPlan plan(MediaTask task, String correctedTarget, List<String> blockers) {
        TaskCorrectionPreview preview = new TaskCorrectionPreview();
        preview.setCurrentTargetPath(task.getTargetPath());
        preview.setCorrectedTargetPath(correctedTarget);
        preview.getBlockers().addAll(blockers);
        preview.setCanApply(blockers.isEmpty());
        Path target = correctedTarget == null ? null : Path.of(correctedTarget);
        MediaTask corrected = new MediaTask();
        corrected.setTargetPath(correctedTarget);
        return new TaskCorrectionPlan(
                task,
                corrected,
                match,
                target,
                List.of(),
                null,
                null,
                false,
                preview
        );
    }

    private MediaTask task(Long id, int season, int episode, String targetPath) {
        MediaTask task = new MediaTask();
        task.setId(id);
        task.setStatus(MediaTask.TaskStatus.DONE);
        task.setMediaType(MediaTask.MediaType.TV_SHOW);
        task.setAssetType(MediaAssetType.VIDEO_FILE);
        task.setTmdbId(1978L);
        task.setRuleId(9L);
        task.setParsedSeason(season);
        task.setParsedEpisode(episode);
        task.setTargetPath(targetPath);
        return task;
    }

    private MatchResult match() {
        MatchResult result = new MatchResult();
        result.setSource("tmdb");
        result.setSourceId("2020");
        result.setTitle("万物生灵");
        result.setOriginalTitle("All Creatures Great and Small");
        result.setYear(2020);
        result.setMediaType(MediaTask.MediaType.TV_SHOW.name());
        result.setGenres(List.of("Drama"));
        return result;
    }
}
