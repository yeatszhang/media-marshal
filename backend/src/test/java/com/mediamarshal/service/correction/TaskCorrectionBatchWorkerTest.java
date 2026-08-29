package com.mediamarshal.service.correction;

import com.mediamarshal.model.dto.MatchResult;
import com.mediamarshal.model.dto.TaskCorrectionApplyResponse;
import com.mediamarshal.model.dto.TaskCorrectionPreview;
import com.mediamarshal.model.entity.MediaTask;
import com.mediamarshal.model.entity.MediaAssetType;
import com.mediamarshal.model.entity.TaskCandidate;
import com.mediamarshal.model.entity.TaskCorrectionBatch;
import com.mediamarshal.model.entity.TaskCorrectionBatchItem;
import com.mediamarshal.model.entity.WatchRule;
import com.mediamarshal.repository.MediaTaskRepository;
import com.mediamarshal.repository.TaskCandidateRepository;
import com.mediamarshal.repository.TaskCorrectionBatchItemRepository;
import com.mediamarshal.repository.TaskCorrectionBatchRepository;
import com.mediamarshal.repository.WatchRuleRepository;
import com.mediamarshal.service.matcher.MetadataMatcher;
import com.mediamarshal.service.nfo.NfoGeneratorService;
import com.mediamarshal.service.rename.RenameService;
import com.mediamarshal.service.rename.TemplatePathSafetyService;
import com.mediamarshal.service.rename.TemplateRenderer;
import com.mediamarshal.service.settings.SettingsService;
import com.mediamarshal.websocket.EventPublisher;
import org.junit.jupiter.api.io.TempDir;
import org.junit.jupiter.api.Test;

import java.nio.file.Path;
import java.nio.file.Files;
import java.util.Map;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicLong;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class TaskCorrectionBatchWorkerTest {

    @TempDir
    Path tempDir;

    @Test
    void continuesAfterOneItemFailsAndLoadsSeriesDetailOnce() {
        TaskCorrectionBatchRepository batchRepository = mock(TaskCorrectionBatchRepository.class);
        TaskCorrectionBatchItemRepository itemRepository = mock(TaskCorrectionBatchItemRepository.class);
        MediaTaskRepository taskRepository = mock(MediaTaskRepository.class);
        TaskCorrectionService correctionService = mock(TaskCorrectionService.class);
        TaskCorrectionBatchStateService stateService = mock(TaskCorrectionBatchStateService.class);
        TaskCorrectionConcurrencyGuard guard = new TaskCorrectionConcurrencyGuard(itemRepository);
        TaskCorrectionFileExecutor fileExecutor = mock(TaskCorrectionFileExecutor.class);
        TaskCorrectionBatchWorker worker = new TaskCorrectionBatchWorker(
                batchRepository,
                itemRepository,
                taskRepository,
                correctionService,
                stateService,
                guard,
                fileExecutor
        );

        TaskCorrectionBatch batch = batch();
        TaskCorrectionBatchItem firstItem = item(11L, 1L, 1, "/library/Old/Show.S01E01.mkv", "/library/New/Show.S01E01.mkv");
        TaskCorrectionBatchItem secondItem = item(12L, 2L, 2, "/library/Old/Show.S01E02.mkv", "/library/New/Show.S01E02.mkv");
        MediaTask firstTask = task(1L, firstItem.getCurrentTargetPath());
        MediaTask secondTask = task(2L, secondItem.getCurrentTargetPath());
        MatchResult match = match();
        TaskCorrectionPlan firstPlan = plan(firstTask, firstItem.getCorrectedTargetPath());
        TaskCorrectionPlan secondPlan = plan(secondTask, secondItem.getCorrectedTargetPath());
        MediaTask corrected = task(101L, firstItem.getCorrectedTargetPath());
        TaskCorrectionApplyResponse firstResponse = new TaskCorrectionApplyResponse(firstTask, corrected, firstPlan.preview());

        when(batchRepository.findById(5L)).thenReturn(Optional.of(batch));
        when(itemRepository.findByBatchIdAndStatusInOrderByExecutionOrderAsc(
                5L, List.of(TaskCorrectionBatchItem.Status.PENDING)
        )).thenReturn(List.of(firstItem, secondItem));
        when(taskRepository.findById(1L)).thenReturn(Optional.of(firstTask));
        when(taskRepository.findById(2L)).thenReturn(Optional.of(secondTask));
        when(correctionService.loadSelectedMatch(2020L, MediaTask.MediaType.TV_SHOW)).thenReturn(match);
        when(correctionService.prepare(eq(1L), any(), eq(match))).thenReturn(firstPlan);
        when(correctionService.prepare(eq(2L), any(), eq(match))).thenReturn(secondPlan);
        when(correctionService.executePrepared(firstPlan, false)).thenReturn(firstResponse);
        when(correctionService.executePrepared(secondPlan, false)).thenThrow(new IllegalStateException("disk unavailable"));
        TaskCorrectionBatch finished = batch();
        finished.setStatus(TaskCorrectionBatch.Status.PARTIAL_FAILED);
        finished.setSuccessCount(1);
        finished.setFailedCount(1);
        when(stateService.finish(5L)).thenReturn(finished);

        worker.execute(5L);

        verify(correctionService, times(1)).loadSelectedMatch(2020L, MediaTask.MediaType.TV_SHOW);
        verify(stateService).markItemSucceeded(11L, 101L, firstItem.getCorrectedTargetPath());
        verify(stateService).markItemFailed(eq(12L), eq("disk unavailable"), any());
        verify(stateService).finish(5L);
    }

    @Test
    void correctsSameSeriesAcrossSeasonsUsingTemporaryMediaLibrary() throws Exception {
        Path library = tempDir.resolve("library");
        Path oldRoot = library.resolve("万物生灵 (1978)");
        Path firstFile = oldRoot.resolve("S01/万物生灵 (1978) - S01E01.mkv");
        Path secondFile = oldRoot.resolve("S02/万物生灵 (1978) - S02E01.mkv");
        Files.createDirectories(firstFile.getParent());
        Files.createDirectories(secondFile.getParent());
        Files.writeString(firstFile, "season-one");
        Files.writeString(secondFile, "season-two");
        Files.writeString(firstFile.resolveSibling("万物生灵 (1978) - S01E01.srt"), "subtitle");
        Files.writeString(oldRoot.resolve("poster.jpg"), "shared-poster");

        MediaTask firstTask = completedTvTask(1L, firstFile, 1, 1);
        MediaTask secondTask = completedTvTask(2L, secondFile, 2, 1);
        TaskCorrectionBatch batch = batch();
        batch.setStatus(TaskCorrectionBatch.Status.QUEUED);
        batch.setScope(TaskCorrectionBatch.Scope.SAME_SERIES);
        TaskCorrectionBatchItem firstItem = item(11L, 1L, 1, firstFile.toString(), null);
        firstItem.setSeason(1);
        TaskCorrectionBatchItem secondItem = item(12L, 2L, 1, secondFile.toString(), null);
        secondItem.setSeason(2);

        TaskCorrectionBatchRepository batchRepository = mock(TaskCorrectionBatchRepository.class);
        TaskCorrectionBatchItemRepository itemRepository = mock(TaskCorrectionBatchItemRepository.class);
        MediaTaskRepository taskRepository = mock(MediaTaskRepository.class);
        TaskCandidateRepository candidateRepository = mock(TaskCandidateRepository.class);
        WatchRuleRepository watchRuleRepository = mock(WatchRuleRepository.class);
        MetadataMatcher metadataMatcher = mock(MetadataMatcher.class);
        SettingsService settingsService = mock(SettingsService.class);
        EventPublisher eventPublisher = mock(EventPublisher.class);
        TaskCorrectionBatchStateService stateService = mock(TaskCorrectionBatchStateService.class);
        TemplateRenderer templateRenderer = new TemplateRenderer();
        RenameService renameService = new RenameService(
                Map.of(), watchRuleRepository, settingsService, templateRenderer, new TemplatePathSafetyService()
        );
        TaskCorrectionFileExecutor fileExecutor = new TaskCorrectionFileExecutor(mock(NfoGeneratorService.class));
        TaskCorrectionPersistenceService persistenceService = new TaskCorrectionPersistenceService(
                taskRepository, candidateRepository
        );
        TaskCorrectionConcurrencyGuard guard = new TaskCorrectionConcurrencyGuard(itemRepository);
        TaskCorrectionService correctionService = new TaskCorrectionService(
                taskRepository,
                watchRuleRepository,
                metadataMatcher,
                renameService,
                templateRenderer,
                settingsService,
                eventPublisher,
                fileExecutor,
                persistenceService,
                guard
        );
        TaskCorrectionBatchWorker worker = new TaskCorrectionBatchWorker(
                batchRepository,
                itemRepository,
                taskRepository,
                correctionService,
                stateService,
                guard,
                fileExecutor
        );

        WatchRule rule = new WatchRule();
        rule.setId(9L);
        rule.setTargetDir(library.toString());
        rule.setTvPathTemplate("{title} ({year})/S{season:02d}/{title} ({year}) - S{season:02d}E{episode:02d}{ext}");
        MatchResult detail = match();
        detail.setOriginalTitle("All Creatures Great and Small");
        detail.setYear(2020);
        detail.setGenres(List.of("Drama"));
        AtomicLong generatedId = new AtomicLong(100);

        when(batchRepository.findById(5L)).thenReturn(Optional.of(batch));
        when(itemRepository.findByBatchIdAndStatusInOrderByExecutionOrderAsc(
                5L, List.of(TaskCorrectionBatchItem.Status.PENDING)
        )).thenReturn(List.of(firstItem, secondItem));
        when(taskRepository.findById(1L)).thenReturn(Optional.of(firstTask));
        when(taskRepository.findById(2L)).thenReturn(Optional.of(secondTask));
        when(taskRepository.saveAndFlush(any(MediaTask.class))).thenAnswer(invocation -> {
            MediaTask task = invocation.getArgument(0);
            if (task.getId() == null) {
                task.setId(generatedId.incrementAndGet());
            }
            return task;
        });
        when(watchRuleRepository.findById(9L)).thenReturn(Optional.of(rule));
        when(metadataMatcher.getById("2020", "TV_SHOW")).thenReturn(detail);
        when(metadataMatcher.getEpisodeTitle("2020", 1, 1)).thenReturn("Horse Sense");
        when(metadataMatcher.getEpisodeTitle("2020", 2, 1)).thenReturn("Where the Heart Is");
        when(settingsService.get("tmdb.confirm-retry-attempts", "3")).thenReturn("1");
        TaskCorrectionBatch finished = batch();
        finished.setStatus(TaskCorrectionBatch.Status.SUCCEEDED);
        finished.setSuccessCount(2);
        when(stateService.finish(5L)).thenReturn(finished);

        worker.execute(5L);

        Path newRoot = library.resolve("万物生灵 (2020)");
        Path correctedFirst = newRoot.resolve("S01/万物生灵 (2020) - S01E01.mkv");
        Path correctedSecond = newRoot.resolve("S02/万物生灵 (2020) - S02E01.mkv");
        assertThat(Files.readString(correctedFirst)).isEqualTo("season-one");
        assertThat(Files.readString(correctedSecond)).isEqualTo("season-two");
        assertThat(
                Files.readString(correctedFirst.resolveSibling("万物生灵 (2020) - S01E01.srt"))
        ).isEqualTo("subtitle");
        assertThat(Files.exists(oldRoot.resolve("poster.jpg"))).isTrue();
        assertThat(Files.exists(newRoot.resolve("poster.jpg"))).isFalse();
        assertThat(firstTask.getStatus()).isEqualTo(MediaTask.TaskStatus.CORRECTED);
        assertThat(secondTask.getStatus()).isEqualTo(MediaTask.TaskStatus.CORRECTED);
        verify(metadataMatcher, times(1)).getById("2020", "TV_SHOW");
        verify(candidateRepository, times(2)).save(any(TaskCandidate.class));
        verify(stateService, times(2)).markItemSucceeded(any(), any(), any());
    }

    private TaskCorrectionBatch batch() {
        TaskCorrectionBatch batch = new TaskCorrectionBatch();
        batch.setId(5L);
        batch.setStatus(TaskCorrectionBatch.Status.RUNNING);
        batch.setTargetTmdbId(2020L);
        batch.setParsedTitle("万物生灵");
        batch.setParsedYear(2020);
        return batch;
    }

    private TaskCorrectionBatchItem item(Long id, Long taskId, int episode, String current, String corrected) {
        TaskCorrectionBatchItem item = new TaskCorrectionBatchItem();
        item.setId(id);
        item.setBatchId(5L);
        item.setOriginalTaskId(taskId);
        item.setSeason(1);
        item.setEpisode(episode);
        item.setCurrentTargetPath(current);
        item.setCorrectedTargetPath(corrected);
        item.setStatus(TaskCorrectionBatchItem.Status.PENDING);
        return item;
    }

    private MediaTask task(Long id, String targetPath) {
        MediaTask task = new MediaTask();
        task.setId(id);
        task.setStatus(MediaTask.TaskStatus.DONE);
        task.setTargetPath(targetPath);
        return task;
    }

    private MediaTask completedTvTask(Long id, Path targetPath, int season, int episode) {
        MediaTask task = task(id, targetPath.toString());
        task.setSourcePath(tempDir.resolve("missing-source-" + id + ".mkv").toString());
        task.setMediaType(MediaTask.MediaType.TV_SHOW);
        task.setAssetType(MediaAssetType.VIDEO_FILE);
        task.setParsedTitle("万物生灵");
        task.setParsedYear(1978);
        task.setParsedSeason(season);
        task.setParsedEpisode(episode);
        task.setTmdbId(1978L);
        task.setRuleId(9L);
        return task;
    }

    private MatchResult match() {
        MatchResult match = new MatchResult();
        match.setSourceId("2020");
        match.setMediaType(MediaTask.MediaType.TV_SHOW.name());
        match.setTitle("万物生灵");
        return match;
    }

    private TaskCorrectionPlan plan(MediaTask task, String correctedTarget) {
        TaskCorrectionPreview preview = new TaskCorrectionPreview();
        preview.setCurrentTargetPath(task.getTargetPath());
        preview.setCorrectedTargetPath(correctedTarget);
        preview.setCanApply(true);
        MediaTask corrected = task(null, correctedTarget);
        return new TaskCorrectionPlan(
                task,
                corrected,
                match(),
                Path.of(correctedTarget),
                List.of(),
                null,
                null,
                false,
                preview
        );
    }
}
