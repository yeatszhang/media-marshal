package com.mediamarshal.service.correction;

import com.mediamarshal.model.dto.TaskCorrectionBatchPreview;
import com.mediamarshal.model.dto.TaskCorrectionBatchPreviewItem;
import com.mediamarshal.model.dto.TaskCorrectionBatchRequest;
import com.mediamarshal.model.entity.TaskCorrectionBatch;
import com.mediamarshal.model.entity.TaskCorrectionBatchItem;
import com.mediamarshal.repository.TaskCorrectionBatchItemRepository;
import com.mediamarshal.repository.TaskCorrectionBatchRepository;
import jakarta.transaction.Transactional;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;

@Service
@RequiredArgsConstructor
class TaskCorrectionBatchPersistenceService {

    private final TaskCorrectionBatchRepository batchRepository;
    private final TaskCorrectionBatchItemRepository itemRepository;

    @Transactional
    TaskCorrectionBatch create(
            TaskCorrectionResolvedScope resolved,
            TaskCorrectionBatchRequest request,
            TaskCorrectionBatchPreview preview,
            String idempotencyKey
    ) {
        TaskCorrectionBatch batch = new TaskCorrectionBatch();
        batch.setAnchorTaskId(resolved.anchor().getId());
        batch.setScope(resolved.scope());
        batch.setOriginalTmdbId(resolved.anchor().getTmdbId());
        batch.setTargetTmdbId(request.getTmdbId());
        batch.setRuleId(resolved.anchor().getRuleId());
        batch.setParsedTitle(request.getParsedTitle().trim());
        batch.setParsedYear(request.getParsedYear());
        batch.setRegenerateNfo(false);
        batch.setGroupFingerprint(preview.groupFingerprint());
        batch.setIdempotencyKey(idempotencyKey);
        batch.setStatus(TaskCorrectionBatch.Status.QUEUED);
        batch.setTotalCount(preview.totalCount());
        batch.setSuccessCount(0);
        batch.setFailedCount(0);
        batch.setExcludedCount(preview.totalCount() - preview.selectedCount());
        batch = batchRepository.saveAndFlush(batch);

        List<TaskCorrectionBatchItem> items = new ArrayList<>();
        int executionOrder = 1;
        for (TaskCorrectionBatchPreviewItem previewItem : preview.items()) {
            TaskCorrectionBatchItem item = new TaskCorrectionBatchItem();
            item.setBatchId(batch.getId());
            item.setOriginalTaskId(previewItem.taskId());
            item.setSeason(previewItem.season());
            item.setEpisode(previewItem.episode());
            item.setEpisodeEnd(previewItem.episodeEnd());
            item.setCurrentTargetPath(requireCurrentPath(previewItem));
            item.setCorrectedTargetPath(previewItem.correctedTargetPath());
            item.setStatus(previewItem.selected()
                    ? TaskCorrectionBatchItem.Status.PENDING
                    : TaskCorrectionBatchItem.Status.EXCLUDED);
            item.setExecutionOrder(executionOrder++);
            item.setRetryCount(0);
            items.add(item);
        }
        itemRepository.saveAll(items);
        itemRepository.flush();
        return batch;
    }

    @Transactional
    TaskCorrectionBatch prepareRetry(Long batchId) {
        TaskCorrectionBatch batch = batchRepository.findById(batchId)
                .orElseThrow(() -> new IllegalArgumentException("批量修正作业不存在：" + batchId));
        List<TaskCorrectionBatchItem> failedItems = itemRepository.findByBatchIdAndStatusInOrderByExecutionOrderAsc(
                batchId,
                List.of(TaskCorrectionBatchItem.Status.FAILED)
        );
        if (failedItems.isEmpty()) {
            throw new IllegalStateException("当前批次没有可重试的失败条目");
        }
        for (TaskCorrectionBatchItem item : failedItems) {
            item.setStatus(TaskCorrectionBatchItem.Status.PENDING);
            item.setRetryCount(item.getRetryCount() + 1);
            item.setErrorMessage(null);
            item.setRecoveryDetails(null);
            item.setStartedAt(null);
            item.setCompletedAt(null);
        }
        itemRepository.saveAll(failedItems);
        itemRepository.flush();
        batch.setStatus(TaskCorrectionBatch.Status.QUEUED);
        batch.setFailedCount(0);
        batch.setErrorMessage(null);
        batch.setStartedAt(null);
        batch.setCompletedAt(null);
        return batchRepository.save(batch);
    }

    private String requireCurrentPath(TaskCorrectionBatchPreviewItem item) {
        if (item.currentTargetPath() == null || item.currentTargetPath().isBlank()) {
            throw new IllegalStateException("批次条目缺少当前目标路径：" + item.taskId());
        }
        return item.currentTargetPath();
    }
}
