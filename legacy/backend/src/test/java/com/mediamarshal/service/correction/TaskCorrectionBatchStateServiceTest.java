package com.mediamarshal.service.correction;

import com.mediamarshal.model.entity.TaskCorrectionBatch;
import com.mediamarshal.model.entity.TaskCorrectionBatchItem;
import com.mediamarshal.repository.TaskCorrectionBatchItemRepository;
import com.mediamarshal.repository.TaskCorrectionBatchRepository;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class TaskCorrectionBatchStateServiceTest {

    @Test
    void startupRecoveryInterruptsQueuedAndRunningItemsButKeepsSucceededItems() {
        TaskCorrectionBatchRepository batchRepository = mock(TaskCorrectionBatchRepository.class);
        TaskCorrectionBatchItemRepository itemRepository = mock(TaskCorrectionBatchItemRepository.class);
        TaskCorrectionBatchStateService service = new TaskCorrectionBatchStateService(batchRepository, itemRepository);

        TaskCorrectionBatch batch = batch(5L, TaskCorrectionBatch.Status.RUNNING);
        TaskCorrectionBatchItem pending = item(1L, TaskCorrectionBatchItem.Status.PENDING);
        TaskCorrectionBatchItem running = item(2L, TaskCorrectionBatchItem.Status.RUNNING);
        TaskCorrectionBatchItem succeeded = item(3L, TaskCorrectionBatchItem.Status.SUCCEEDED);
        List<TaskCorrectionBatchItem> unfinished = List.of(pending, running);
        List<TaskCorrectionBatchItem> all = List.of(pending, running, succeeded);

        when(batchRepository.findByStatusIn(any())).thenReturn(List.of(batch));
        when(itemRepository.findByBatchIdAndStatusInOrderByExecutionOrderAsc(eq(5L), any())).thenReturn(unfinished);
        when(itemRepository.findByBatchIdOrderByExecutionOrderAsc(5L)).thenReturn(all);

        int count = service.interruptActiveBatches();

        assertThat(count).isEqualTo(1);
        assertThat(batch.getStatus()).isEqualTo(TaskCorrectionBatch.Status.INTERRUPTED);
        assertThat(batch.getFailedCount()).isEqualTo(2);
        assertThat(pending.getStatus()).isEqualTo(TaskCorrectionBatchItem.Status.FAILED);
        assertThat(running.getStatus()).isEqualTo(TaskCorrectionBatchItem.Status.FAILED);
        assertThat(succeeded.getStatus()).isEqualTo(TaskCorrectionBatchItem.Status.SUCCEEDED);
        assertThat(running.getRecoveryDetails()).contains("原路径=");
        verify(itemRepository).saveAll(unfinished);
        verify(batchRepository).save(batch);
    }

    @Test
    void finishDerivesPartialFailureCountsFromItems() {
        TaskCorrectionBatchRepository batchRepository = mock(TaskCorrectionBatchRepository.class);
        TaskCorrectionBatchItemRepository itemRepository = mock(TaskCorrectionBatchItemRepository.class);
        TaskCorrectionBatchStateService service = new TaskCorrectionBatchStateService(batchRepository, itemRepository);
        TaskCorrectionBatch batch = batch(8L, TaskCorrectionBatch.Status.RUNNING);
        when(batchRepository.findById(8L)).thenReturn(java.util.Optional.of(batch));
        when(batchRepository.save(any(TaskCorrectionBatch.class))).thenAnswer(invocation -> invocation.getArgument(0));
        when(itemRepository.findByBatchIdOrderByExecutionOrderAsc(8L)).thenReturn(List.of(
                item(1L, TaskCorrectionBatchItem.Status.SUCCEEDED),
                item(2L, TaskCorrectionBatchItem.Status.FAILED),
                item(3L, TaskCorrectionBatchItem.Status.EXCLUDED)
        ));

        TaskCorrectionBatch finished = service.finish(8L);

        assertThat(finished.getStatus()).isEqualTo(TaskCorrectionBatch.Status.PARTIAL_FAILED);
        assertThat(finished.getSuccessCount()).isEqualTo(1);
        assertThat(finished.getFailedCount()).isEqualTo(1);
        assertThat(finished.getExcludedCount()).isEqualTo(1);
    }

    private TaskCorrectionBatch batch(Long id, TaskCorrectionBatch.Status status) {
        TaskCorrectionBatch batch = new TaskCorrectionBatch();
        batch.setId(id);
        batch.setStatus(status);
        return batch;
    }

    private TaskCorrectionBatchItem item(Long id, TaskCorrectionBatchItem.Status status) {
        TaskCorrectionBatchItem item = new TaskCorrectionBatchItem();
        item.setId(id);
        item.setBatchId(5L);
        item.setOriginalTaskId(id + 100);
        item.setCurrentTargetPath("/library/S01E0" + id + ".mkv");
        item.setStatus(status);
        return item;
    }
}
