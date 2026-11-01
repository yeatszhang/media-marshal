package com.mediamarshal.service.correction;

import com.mediamarshal.model.dto.TaskCorrectionBatchPreview;
import com.mediamarshal.model.dto.TaskCorrectionBatchPreviewItem;
import com.mediamarshal.model.dto.TaskCorrectionBatchRequest;
import com.mediamarshal.model.entity.MediaTask;
import com.mediamarshal.model.entity.TaskCorrectionBatch;
import com.mediamarshal.model.entity.TaskCorrectionBatchItem;
import com.mediamarshal.repository.TaskCorrectionBatchItemRepository;
import com.mediamarshal.repository.TaskCorrectionBatchRepository;
import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;

import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class TaskCorrectionBatchPersistenceServiceTest {

    @Test
    void createPersistsSelectedAndExcludedItemsInPreviewOrder() {
        TaskCorrectionBatchRepository batchRepository = mock(TaskCorrectionBatchRepository.class);
        TaskCorrectionBatchItemRepository itemRepository = mock(TaskCorrectionBatchItemRepository.class);
        TaskCorrectionBatchPersistenceService service = new TaskCorrectionBatchPersistenceService(
                batchRepository, itemRepository
        );
        MediaTask anchor = anchor();
        TaskCorrectionResolvedScope resolved = new TaskCorrectionResolvedScope(
                anchor,
                TaskCorrectionBatch.Scope.SAME_SERIES,
                List.of(anchor),
                "fingerprint"
        );
        TaskCorrectionBatchRequest request = request();
        TaskCorrectionBatchPreview preview = new TaskCorrectionBatchPreview(
                "SAME_SERIES", 2, 1, 1, 0, 0, true, "fingerprint", null, List.of(), List.of(),
                List.of(
                        itemPreview(1L, true, "/old/S01E01.mkv", "/new/S01E01.mkv"),
                        itemPreview(2L, false, "/old/S01E02.mkv", "/new/S01E02.mkv")
                )
        );
        when(batchRepository.saveAndFlush(any(TaskCorrectionBatch.class))).thenAnswer(invocation -> {
            TaskCorrectionBatch batch = invocation.getArgument(0);
            batch.setId(7L);
            return batch;
        });

        TaskCorrectionBatch created = service.create(resolved, request, preview, "request-1");

        assertThat(created.getStatus()).isEqualTo(TaskCorrectionBatch.Status.QUEUED);
        assertThat(created.getExcludedCount()).isEqualTo(1);
        ArgumentCaptor<List<TaskCorrectionBatchItem>> itemsCaptor = ArgumentCaptor.forClass(List.class);
        verify(itemRepository).saveAll(itemsCaptor.capture());
        assertThat(itemsCaptor.getValue()).extracting(TaskCorrectionBatchItem::getStatus)
                .containsExactly(TaskCorrectionBatchItem.Status.PENDING, TaskCorrectionBatchItem.Status.EXCLUDED);
        assertThat(itemsCaptor.getValue()).extracting(TaskCorrectionBatchItem::getExecutionOrder)
                .containsExactly(1, 2);
    }

    @Test
    void retryOnlyResetsFailedItemsAndIncrementsRetryCount() {
        TaskCorrectionBatchRepository batchRepository = mock(TaskCorrectionBatchRepository.class);
        TaskCorrectionBatchItemRepository itemRepository = mock(TaskCorrectionBatchItemRepository.class);
        TaskCorrectionBatchPersistenceService service = new TaskCorrectionBatchPersistenceService(
                batchRepository, itemRepository
        );
        TaskCorrectionBatch batch = new TaskCorrectionBatch();
        batch.setId(7L);
        batch.setStatus(TaskCorrectionBatch.Status.PARTIAL_FAILED);
        batch.setFailedCount(1);
        TaskCorrectionBatchItem failed = new TaskCorrectionBatchItem();
        failed.setStatus(TaskCorrectionBatchItem.Status.FAILED);
        failed.setRetryCount(2);
        failed.setErrorMessage("disk unavailable");
        when(batchRepository.findById(7L)).thenReturn(Optional.of(batch));
        when(itemRepository.findByBatchIdAndStatusInOrderByExecutionOrderAsc(
                7L, List.of(TaskCorrectionBatchItem.Status.FAILED)
        )).thenReturn(List.of(failed));
        when(batchRepository.save(any(TaskCorrectionBatch.class))).thenAnswer(invocation -> invocation.getArgument(0));

        TaskCorrectionBatch retried = service.prepareRetry(7L);

        assertThat(retried.getStatus()).isEqualTo(TaskCorrectionBatch.Status.QUEUED);
        assertThat(failed.getStatus()).isEqualTo(TaskCorrectionBatchItem.Status.PENDING);
        assertThat(failed.getRetryCount()).isEqualTo(3);
        assertThat(failed.getErrorMessage()).isNull();
    }

    private MediaTask anchor() {
        MediaTask task = new MediaTask();
        task.setId(1L);
        task.setTmdbId(1978L);
        task.setRuleId(9L);
        return task;
    }

    private TaskCorrectionBatchRequest request() {
        TaskCorrectionBatchRequest request = new TaskCorrectionBatchRequest();
        request.setParsedTitle("万物生灵");
        request.setParsedYear(2020);
        request.setTmdbId(2020L);
        return request;
    }

    private TaskCorrectionBatchPreviewItem itemPreview(
            Long taskId,
            boolean selected,
            String current,
            String corrected
    ) {
        return new TaskCorrectionBatchPreviewItem(
                taskId, 1, taskId.intValue(), null, current, corrected, false,
                0, List.of(), List.of(), List.of(), selected
        );
    }
}
