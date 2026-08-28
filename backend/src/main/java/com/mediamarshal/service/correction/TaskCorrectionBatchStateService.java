package com.mediamarshal.service.correction;

import com.mediamarshal.model.entity.TaskCorrectionBatch;
import com.mediamarshal.model.entity.TaskCorrectionBatchItem;
import com.mediamarshal.repository.TaskCorrectionBatchItemRepository;
import com.mediamarshal.repository.TaskCorrectionBatchRepository;
import jakarta.transaction.Transactional;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.List;

@Service
@RequiredArgsConstructor
class TaskCorrectionBatchStateService {

    private static final String INTERRUPTION_MESSAGE = "服务在批量修正完成前中断，请核对文件状态后重试未成功条目";

    private final TaskCorrectionBatchRepository batchRepository;
    private final TaskCorrectionBatchItemRepository itemRepository;

    @Transactional
    void markRunning(Long batchId) {
        TaskCorrectionBatch batch = loadBatch(batchId);
        requireStatus(batch, TaskCorrectionBatch.Status.QUEUED, TaskCorrectionBatch.Status.INTERRUPTED);
        batch.setStatus(TaskCorrectionBatch.Status.RUNNING);
        batch.setStartedAt(LocalDateTime.now());
        batch.setCompletedAt(null);
        batch.setErrorMessage(null);
        batchRepository.save(batch);
    }

    @Transactional
    void markItemRunning(Long itemId) {
        TaskCorrectionBatchItem item = loadItem(itemId);
        if (!TaskCorrectionBatchItem.Status.PENDING.equals(item.getStatus())
                && !TaskCorrectionBatchItem.Status.FAILED.equals(item.getStatus())) {
            throw new IllegalStateException("批次条目状态不允许开始执行：" + item.getStatus());
        }
        item.setStatus(TaskCorrectionBatchItem.Status.RUNNING);
        item.setStartedAt(LocalDateTime.now());
        item.setCompletedAt(null);
        item.setErrorMessage(null);
        item.setRecoveryDetails(null);
        itemRepository.save(item);
    }

    @Transactional
    void markItemSucceeded(Long itemId, Long correctedTaskId, String correctedTargetPath) {
        TaskCorrectionBatchItem item = loadItem(itemId);
        requireItemRunning(item);
        item.setStatus(TaskCorrectionBatchItem.Status.SUCCEEDED);
        item.setCorrectedTaskId(correctedTaskId);
        item.setCorrectedTargetPath(correctedTargetPath);
        item.setCompletedAt(LocalDateTime.now());
        item.setErrorMessage(null);
        item.setRecoveryDetails(null);
        itemRepository.save(item);
    }

    @Transactional
    void markItemFailed(Long itemId, String errorMessage, String recoveryDetails) {
        TaskCorrectionBatchItem item = loadItem(itemId);
        if (TaskCorrectionBatchItem.Status.SUCCEEDED.equals(item.getStatus())
                || TaskCorrectionBatchItem.Status.EXCLUDED.equals(item.getStatus())) {
            throw new IllegalStateException("成功或已排除条目不能标记失败");
        }
        item.setStatus(TaskCorrectionBatchItem.Status.FAILED);
        item.setCompletedAt(LocalDateTime.now());
        item.setErrorMessage(errorMessage);
        item.setRecoveryDetails(recoveryDetails);
        itemRepository.save(item);
    }

    @Transactional
    TaskCorrectionBatch finish(Long batchId) {
        TaskCorrectionBatch batch = loadBatch(batchId);
        List<TaskCorrectionBatchItem> items = itemRepository.findByBatchIdOrderByExecutionOrderAsc(batchId);
        int successCount = (int) items.stream().filter(item -> TaskCorrectionBatchItem.Status.SUCCEEDED.equals(item.getStatus())).count();
        int failedCount = (int) items.stream().filter(item -> TaskCorrectionBatchItem.Status.FAILED.equals(item.getStatus())).count();
        int excludedCount = (int) items.stream().filter(item -> TaskCorrectionBatchItem.Status.EXCLUDED.equals(item.getStatus())).count();
        batch.setSuccessCount(successCount);
        batch.setFailedCount(failedCount);
        batch.setExcludedCount(excludedCount);
        batch.setCompletedAt(LocalDateTime.now());
        if (successCount > 0 && failedCount == 0) {
            batch.setStatus(TaskCorrectionBatch.Status.SUCCEEDED);
        } else if (successCount > 0) {
            batch.setStatus(TaskCorrectionBatch.Status.PARTIAL_FAILED);
        } else {
            batch.setStatus(TaskCorrectionBatch.Status.FAILED);
        }
        return batchRepository.save(batch);
    }

    @Transactional
    int interruptActiveBatches() {
        List<TaskCorrectionBatch> activeBatches = batchRepository.findByStatusIn(List.of(
                TaskCorrectionBatch.Status.QUEUED,
                TaskCorrectionBatch.Status.RUNNING
        ));
        for (TaskCorrectionBatch batch : activeBatches) {
            List<TaskCorrectionBatchItem> unfinished = itemRepository.findByBatchIdAndStatusInOrderByExecutionOrderAsc(
                    batch.getId(),
                    List.of(TaskCorrectionBatchItem.Status.PENDING, TaskCorrectionBatchItem.Status.RUNNING)
            );
            for (TaskCorrectionBatchItem item : unfinished) {
                item.setStatus(TaskCorrectionBatchItem.Status.FAILED);
                item.setCompletedAt(LocalDateTime.now());
                item.setErrorMessage(INTERRUPTION_MESSAGE);
                item.setRecoveryDetails("原路径=" + item.getCurrentTargetPath()
                        + (item.getCorrectedTargetPath() == null ? "" : "；计划目标=" + item.getCorrectedTargetPath()));
            }
            itemRepository.saveAll(unfinished);
            batch.setStatus(TaskCorrectionBatch.Status.INTERRUPTED);
            batch.setFailedCount((int) itemRepository.findByBatchIdOrderByExecutionOrderAsc(batch.getId()).stream()
                    .filter(item -> TaskCorrectionBatchItem.Status.FAILED.equals(item.getStatus()))
                    .count());
            batch.setCompletedAt(LocalDateTime.now());
            batch.setErrorMessage(INTERRUPTION_MESSAGE);
            batchRepository.save(batch);
        }
        return activeBatches.size();
    }

    private TaskCorrectionBatch loadBatch(Long batchId) {
        return batchRepository.findById(batchId)
                .orElseThrow(() -> new IllegalArgumentException("批量修正作业不存在：" + batchId));
    }

    private TaskCorrectionBatchItem loadItem(Long itemId) {
        return itemRepository.findById(itemId)
                .orElseThrow(() -> new IllegalArgumentException("批量修正条目不存在：" + itemId));
    }

    private void requireStatus(TaskCorrectionBatch batch, TaskCorrectionBatch.Status... allowed) {
        for (TaskCorrectionBatch.Status status : allowed) {
            if (status.equals(batch.getStatus())) {
                return;
            }
        }
        throw new IllegalStateException("批量修正作业状态不允许开始执行：" + batch.getStatus());
    }

    private void requireItemRunning(TaskCorrectionBatchItem item) {
        if (!TaskCorrectionBatchItem.Status.RUNNING.equals(item.getStatus())) {
            throw new IllegalStateException("批次条目不在执行中：" + item.getStatus());
        }
    }
}
