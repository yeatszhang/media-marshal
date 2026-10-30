package com.mediamarshal.service.correction;

import com.mediamarshal.model.dto.TaskCorrectionBatchApplyResponse;
import com.mediamarshal.model.dto.TaskCorrectionBatchPreview;
import com.mediamarshal.model.dto.TaskCorrectionBatchPreviewItem;
import com.mediamarshal.model.dto.TaskCorrectionBatchRequest;
import com.mediamarshal.model.dto.TaskCorrectionBatchResponse;
import com.mediamarshal.model.entity.MediaAssetType;
import com.mediamarshal.model.entity.MediaTask;
import com.mediamarshal.model.entity.TaskCorrectionBatch;
import com.mediamarshal.model.entity.TaskCorrectionBatchItem;
import com.mediamarshal.repository.MediaTaskRepository;
import com.mediamarshal.repository.TaskCorrectionBatchItemRepository;
import com.mediamarshal.repository.TaskCorrectionBatchRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class TaskCorrectionBatchServiceTest {

    private TaskCorrectionBatchPreviewService previewService;
    private TaskCorrectionScopeService scopeService;
    private TaskCorrectionBatchRepository batchRepository;
    private TaskCorrectionBatchItemRepository itemRepository;
    private MediaTaskRepository taskRepository;
    private TaskCorrectionBatchPersistenceService persistenceService;
    private TaskCorrectionBatchExecutor executor;
    private TaskCorrectionBatchWorker worker;
    private TaskCorrectionBatchService service;
    private MediaTask anchor;

    @BeforeEach
    void setUp() {
        previewService = mock(TaskCorrectionBatchPreviewService.class);
        scopeService = mock(TaskCorrectionScopeService.class);
        batchRepository = mock(TaskCorrectionBatchRepository.class);
        itemRepository = mock(TaskCorrectionBatchItemRepository.class);
        taskRepository = mock(MediaTaskRepository.class);
        persistenceService = mock(TaskCorrectionBatchPersistenceService.class);
        executor = mock(TaskCorrectionBatchExecutor.class);
        worker = mock(TaskCorrectionBatchWorker.class);
        TaskCorrectionConcurrencyGuard guard = new TaskCorrectionConcurrencyGuard(itemRepository);
        service = new TaskCorrectionBatchService(
                previewService,
                scopeService,
                batchRepository,
                itemRepository,
                taskRepository,
                persistenceService,
                guard,
                executor,
                worker,
                mock(TaskCorrectionBatchStateService.class)
        );
        anchor = task(1L, "/library/Old/Show.S01E01.mkv");
    }

    @Test
    void duplicateIdempotencyKeyReturnsExistingBatchWithoutNewPreview() {
        TaskCorrectionBatch existing = batch(9L, TaskCorrectionBatch.Status.RUNNING);
        when(batchRepository.findByIdempotencyKey("request-1")).thenReturn(Optional.of(existing));

        TaskCorrectionBatchApplyResponse response = service.apply(1L, request("fingerprint"));

        assertThat(response.batchId()).isEqualTo(9L);
        assertThat(response.status()).isEqualTo("RUNNING");
        verify(previewService, never()).preview(any(), any());
    }

    @Test
    void staleFingerprintIsRejectedBeforeJobCreation() {
        when(batchRepository.findByIdempotencyKey("request-1")).thenReturn(Optional.empty());
        when(previewService.preview(eq(1L), any())).thenReturn(preview("new-fingerprint"));

        assertThatThrownBy(() -> service.apply(1L, request("old-fingerprint")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("发生变化");
        verify(persistenceService, never()).create(any(), any(), any(), any());
    }

    @Test
    void createsPersistedJobAndSubmitsOnlyAfterReservation() {
        TaskCorrectionBatchRequest request = request("fingerprint");
        TaskCorrectionBatchPreview preview = preview("fingerprint");
        TaskCorrectionResolvedScope resolved = new TaskCorrectionResolvedScope(
                anchor,
                TaskCorrectionBatch.Scope.SAME_SEASON,
                List.of(anchor),
                "fingerprint"
        );
        TaskCorrectionBatch created = batch(10L, TaskCorrectionBatch.Status.QUEUED);
        when(batchRepository.findByIdempotencyKey("request-1")).thenReturn(Optional.empty());
        when(previewService.preview(1L, request)).thenReturn(preview);
        when(scopeService.resolve(1L, "SAME_SEASON")).thenReturn(resolved);
        when(persistenceService.create(resolved, request, preview, "request-1")).thenReturn(created);

        TaskCorrectionBatchApplyResponse response = service.apply(1L, request);

        assertThat(response.batchId()).isEqualTo(10L);
        assertThat(response.status()).isEqualTo("QUEUED");
        verify(executor).submit(eq(10L), any(Runnable.class));
    }

    @Test
    void retryResetsAndSubmitsOnlyFailedItems() {
        TaskCorrectionBatch failedBatch = batch(12L, TaskCorrectionBatch.Status.PARTIAL_FAILED);
        TaskCorrectionBatchItem failedItem = new TaskCorrectionBatchItem();
        failedItem.setId(21L);
        failedItem.setBatchId(12L);
        failedItem.setOriginalTaskId(1L);
        failedItem.setCurrentTargetPath(anchor.getTargetPath());
        failedItem.setStatus(TaskCorrectionBatchItem.Status.FAILED);
        TaskCorrectionBatch queued = batch(12L, TaskCorrectionBatch.Status.QUEUED);
        when(batchRepository.findById(12L)).thenReturn(Optional.of(failedBatch));
        when(itemRepository.findByBatchIdAndStatusInOrderByExecutionOrderAsc(
                12L, List.of(TaskCorrectionBatchItem.Status.FAILED)
        )).thenReturn(List.of(failedItem));
        when(taskRepository.findById(1L)).thenReturn(Optional.of(anchor));
        when(persistenceService.prepareRetry(12L)).thenReturn(queued);

        TaskCorrectionBatchApplyResponse response = service.retryFailed(12L);

        assertThat(response.status()).isEqualTo("QUEUED");
        verify(persistenceService).prepareRetry(12L);
        verify(executor).submit(eq(12L), any(Runnable.class));
    }

    @Test
    void queryDerivesLiveProgressCountsAndCurrentItemFromPersistedItems() {
        TaskCorrectionBatch running = batch(15L, TaskCorrectionBatch.Status.RUNNING);
        running.setScope(TaskCorrectionBatch.Scope.SAME_SERIES);
        running.setOriginalTmdbId(1978L);
        running.setTargetTmdbId(2020L);
        running.setRuleId(9L);
        running.setParsedTitle("万物生灵");
        running.setGroupFingerprint("fingerprint");
        running.setTotalCount(4);
        TaskCorrectionBatchItem succeeded = batchItem(1L, TaskCorrectionBatchItem.Status.SUCCEEDED);
        TaskCorrectionBatchItem failed = batchItem(2L, TaskCorrectionBatchItem.Status.FAILED);
        TaskCorrectionBatchItem excluded = batchItem(3L, TaskCorrectionBatchItem.Status.EXCLUDED);
        TaskCorrectionBatchItem current = batchItem(4L, TaskCorrectionBatchItem.Status.RUNNING);
        when(batchRepository.findById(15L)).thenReturn(Optional.of(running));
        when(itemRepository.findByBatchIdOrderByExecutionOrderAsc(15L))
                .thenReturn(List.of(succeeded, failed, excluded, current));

        TaskCorrectionBatchResponse response = service.get(15L);

        assertThat(response.successCount()).isEqualTo(1);
        assertThat(response.failedCount()).isEqualTo(1);
        assertThat(response.excludedCount()).isEqualTo(1);
        assertThat(response.currentItem().id()).isEqualTo(4L);
    }

    private TaskCorrectionBatchRequest request(String fingerprint) {
        TaskCorrectionBatchRequest request = new TaskCorrectionBatchRequest();
        request.setScope("SAME_SEASON");
        request.setParsedTitle("万物生灵");
        request.setParsedYear(2020);
        request.setTmdbId(2020L);
        request.setRegenerateNfo(false);
        request.setExcludedTaskIds(List.of());
        request.setGroupFingerprint(fingerprint);
        request.setIdempotencyKey("request-1");
        return request;
    }

    private TaskCorrectionBatchPreview preview(String fingerprint) {
        TaskCorrectionBatchPreviewItem item = new TaskCorrectionBatchPreviewItem(
                1L, 1, 1, null,
                anchor.getTargetPath(),
                "/library/New/Show.S01E01.mkv",
                false,
                0,
                List.of(),
                List.of(),
                List.of(),
                true
        );
        return new TaskCorrectionBatchPreview(
                "SAME_SEASON", 1, 1, 1, 0, 0, true, fingerprint,
                null, List.of(), List.of(), List.of(item)
        );
    }

    private TaskCorrectionBatch batch(Long id, TaskCorrectionBatch.Status status) {
        TaskCorrectionBatch batch = new TaskCorrectionBatch();
        batch.setId(id);
        batch.setStatus(status);
        return batch;
    }

    private TaskCorrectionBatchItem batchItem(Long id, TaskCorrectionBatchItem.Status status) {
        TaskCorrectionBatchItem item = new TaskCorrectionBatchItem();
        item.setId(id);
        item.setBatchId(15L);
        item.setOriginalTaskId(100L + id);
        item.setCurrentTargetPath("/library/Show.S01E0" + id + ".mkv");
        item.setStatus(status);
        item.setExecutionOrder(id.intValue());
        return item;
    }

    private MediaTask task(Long id, String targetPath) {
        MediaTask task = new MediaTask();
        task.setId(id);
        task.setStatus(MediaTask.TaskStatus.DONE);
        task.setMediaType(MediaTask.MediaType.TV_SHOW);
        task.setAssetType(MediaAssetType.VIDEO_FILE);
        task.setTmdbId(1978L);
        task.setRuleId(9L);
        task.setParsedSeason(1);
        task.setParsedEpisode(1);
        task.setTargetPath(targetPath);
        return task;
    }
}
