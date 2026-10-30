package com.mediamarshal.service.correction;

import com.mediamarshal.model.dto.TaskCorrectionBatchApplyResponse;
import com.mediamarshal.model.dto.TaskCorrectionBatchItemResponse;
import com.mediamarshal.model.dto.TaskCorrectionBatchPreview;
import com.mediamarshal.model.dto.TaskCorrectionBatchRequest;
import com.mediamarshal.model.dto.TaskCorrectionBatchResponse;
import com.mediamarshal.model.entity.MediaTask;
import com.mediamarshal.model.entity.TaskCorrectionBatch;
import com.mediamarshal.model.entity.TaskCorrectionBatchItem;
import com.mediamarshal.repository.MediaTaskRepository;
import com.mediamarshal.repository.TaskCorrectionBatchItemRepository;
import com.mediamarshal.repository.TaskCorrectionBatchRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;

@Service
@RequiredArgsConstructor
public class TaskCorrectionBatchService {

    private final TaskCorrectionBatchPreviewService previewService;
    private final TaskCorrectionScopeService scopeService;
    private final TaskCorrectionBatchRepository batchRepository;
    private final TaskCorrectionBatchItemRepository itemRepository;
    private final MediaTaskRepository taskRepository;
    private final TaskCorrectionBatchPersistenceService persistenceService;
    private final TaskCorrectionConcurrencyGuard concurrencyGuard;
    private final TaskCorrectionBatchExecutor executor;
    private final TaskCorrectionBatchWorker worker;
    private final TaskCorrectionBatchStateService stateService;

    public TaskCorrectionBatchApplyResponse apply(Long anchorTaskId, TaskCorrectionBatchRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("批量修正请求不能为空");
        }
        String idempotencyKey = normalizeIdempotencyKey(request.getIdempotencyKey());
        Optional<TaskCorrectionBatch> existing = batchRepository.findByIdempotencyKey(idempotencyKey);
        if (existing.isPresent()) {
            return applyResponse(existing.get());
        }
        String expectedFingerprint = requireFingerprint(request.getGroupFingerprint());
        TaskCorrectionBatchPreview preview = previewService.preview(anchorTaskId, request);
        ensureCanApply(preview);
        if (!expectedFingerprint.equals(preview.groupFingerprint())) {
            throw new IllegalStateException("修正范围在预览后发生变化，请重新预览");
        }
        List<Long> selectedTaskIds = preview.items().stream()
                .filter(item -> item.selected())
                .map(item -> item.taskId())
                .toList();

        BatchReservation reservation = concurrencyGuard.createReservations(selectedTaskIds, () -> {
            Optional<TaskCorrectionBatch> duplicate = batchRepository.findByIdempotencyKey(idempotencyKey);
            if (duplicate.isPresent()) {
                return new BatchReservation(duplicate.get(), false);
            }
            TaskCorrectionResolvedScope resolved = scopeService.resolve(anchorTaskId, request.getScope());
            if (!expectedFingerprint.equals(resolved.groupFingerprint())
                    || !preview.groupFingerprint().equals(resolved.groupFingerprint())) {
                throw new IllegalStateException("修正范围在预览后发生变化，请重新预览");
            }
            return new BatchReservation(
                    persistenceService.create(resolved, request, preview, idempotencyKey),
                    true
            );
        });
        if (reservation.created()) {
            submit(reservation.batch().getId());
        }
        return applyResponse(reservation.batch());
    }

    public TaskCorrectionBatchResponse get(Long batchId) {
        TaskCorrectionBatch batch = batchRepository.findById(batchId)
                .orElseThrow(() -> new IllegalArgumentException("批量修正作业不存在：" + batchId));
        List<TaskCorrectionBatchItem> items = itemRepository.findByBatchIdOrderByExecutionOrderAsc(batchId);
        return toResponse(batch, items);
    }

    public TaskCorrectionBatchApplyResponse retryFailed(Long batchId) {
        TaskCorrectionBatch batch = batchRepository.findById(batchId)
                .orElseThrow(() -> new IllegalArgumentException("批量修正作业不存在：" + batchId));
        if (!List.of(
                TaskCorrectionBatch.Status.PARTIAL_FAILED,
                TaskCorrectionBatch.Status.FAILED,
                TaskCorrectionBatch.Status.INTERRUPTED
        ).contains(batch.getStatus())) {
            throw new IllegalStateException("只有失败、部分失败或中断的批次可以重试失败项");
        }
        List<TaskCorrectionBatchItem> failedItems = itemRepository.findByBatchIdAndStatusInOrderByExecutionOrderAsc(
                batchId,
                List.of(TaskCorrectionBatchItem.Status.FAILED)
        );
        if (failedItems.isEmpty()) {
            throw new IllegalStateException("当前批次没有可重试的失败条目");
        }
        for (TaskCorrectionBatchItem item : failedItems) {
            validateRetryItem(item);
        }
        List<Long> taskIds = failedItems.stream().map(TaskCorrectionBatchItem::getOriginalTaskId).toList();
        TaskCorrectionBatch queued = concurrencyGuard.createReservations(
                taskIds,
                () -> persistenceService.prepareRetry(batchId)
        );
        submit(batchId);
        return applyResponse(queued);
    }

    private void submit(Long batchId) {
        try {
            executor.submit(batchId, () -> worker.execute(batchId));
        } catch (RuntimeException e) {
            stateService.failBatch(batchId, "后台执行队列不可用：" + messageOrFallback(e));
            throw new IllegalStateException("批量修正作业已创建，但后台执行队列不可用", e);
        }
    }

    private void validateRetryItem(TaskCorrectionBatchItem item) {
        MediaTask task = taskRepository.findById(item.getOriginalTaskId())
                .orElseThrow(() -> new IllegalStateException("失败条目的原任务不存在：" + item.getOriginalTaskId()));
        if (!MediaTask.TaskStatus.DONE.equals(task.getStatus())) {
            throw new IllegalStateException("失败条目的原任务不再是 DONE，请人工核对：" + item.getOriginalTaskId());
        }
        if (!samePath(task.getTargetPath(), item.getCurrentTargetPath())) {
            throw new IllegalStateException("失败条目的当前目标路径已变化，请人工核对：" + item.getOriginalTaskId());
        }
    }

    private void ensureCanApply(TaskCorrectionBatchPreview preview) {
        if (preview.canApply()) {
            return;
        }
        StringBuilder message = new StringBuilder(String.join("；", preview.blockers()));
        preview.items().stream()
                .filter(item -> item.selected() && !item.blockers().isEmpty())
                .forEach(item -> {
                    if (!message.isEmpty()) {
                        message.append('；');
                    }
                    message.append("任务 ").append(item.taskId()).append('：')
                            .append(String.join("；", item.blockers()));
                });
        throw new IllegalStateException(message.isEmpty() ? "批量修正预览存在阻断项" : message.toString());
    }

    private TaskCorrectionBatchResponse toResponse(
            TaskCorrectionBatch batch,
            List<TaskCorrectionBatchItem> items
    ) {
        List<TaskCorrectionBatchItemResponse> itemResponses = items.stream().map(this::toItemResponse).toList();
        int liveSuccessCount = (int) items.stream()
                .filter(item -> TaskCorrectionBatchItem.Status.SUCCEEDED.equals(item.getStatus()))
                .count();
        int liveFailedCount = (int) items.stream()
                .filter(item -> TaskCorrectionBatchItem.Status.FAILED.equals(item.getStatus()))
                .count();
        int liveExcludedCount = (int) items.stream()
                .filter(item -> TaskCorrectionBatchItem.Status.EXCLUDED.equals(item.getStatus()))
                .count();
        TaskCorrectionBatchItemResponse current = itemResponses.stream()
                .filter(item -> TaskCorrectionBatchItem.Status.RUNNING.name().equals(item.status()))
                .findFirst()
                .orElse(null);
        return new TaskCorrectionBatchResponse(
                batch.getId(),
                batch.getAnchorTaskId(),
                batch.getScope().name(),
                batch.getOriginalTmdbId(),
                batch.getTargetTmdbId(),
                batch.getRuleId(),
                batch.getParsedTitle(),
                batch.getParsedYear(),
                batch.isRegenerateNfo(),
                batch.getGroupFingerprint(),
                batch.getStatus().name(),
                batch.getTotalCount(),
                liveSuccessCount,
                liveFailedCount,
                liveExcludedCount,
                batch.getErrorMessage(),
                batch.getCreatedAt(),
                batch.getStartedAt(),
                batch.getCompletedAt(),
                current,
                itemResponses
        );
    }

    private TaskCorrectionBatchItemResponse toItemResponse(TaskCorrectionBatchItem item) {
        return new TaskCorrectionBatchItemResponse(
                item.getId(),
                item.getOriginalTaskId(),
                item.getCorrectedTaskId(),
                item.getSeason(),
                item.getEpisode(),
                item.getEpisodeEnd(),
                item.getCurrentTargetPath(),
                item.getCorrectedTargetPath(),
                item.getStatus().name(),
                item.getExecutionOrder(),
                item.getRetryCount(),
                item.getErrorMessage(),
                item.getRecoveryDetails(),
                item.getStartedAt(),
                item.getCompletedAt()
        );
    }

    private TaskCorrectionBatchApplyResponse applyResponse(TaskCorrectionBatch batch) {
        return new TaskCorrectionBatchApplyResponse(batch.getId(), batch.getStatus().name());
    }

    private String normalizeIdempotencyKey(String value) {
        String key = value == null ? "" : value.trim();
        if (key.isBlank()) {
            throw new IllegalArgumentException("批量应用必须提供 idempotencyKey");
        }
        if (key.length() > 100) {
            throw new IllegalArgumentException("idempotencyKey 长度不能超过 100");
        }
        return key;
    }

    private String requireFingerprint(String value) {
        String fingerprint = value == null ? "" : value.trim();
        if (fingerprint.isBlank()) {
            throw new IllegalArgumentException("批量应用必须提供预览返回的 groupFingerprint");
        }
        return fingerprint;
    }

    private boolean samePath(String left, String right) {
        if (left == null || right == null) {
            return false;
        }
        try {
            return pathKey(Paths.get(left)).equals(pathKey(Paths.get(right)));
        } catch (RuntimeException e) {
            return Objects.equals(left, right);
        }
    }

    private String pathKey(Path path) {
        String value = path.toAbsolutePath().normalize().toString();
        return isWindows() ? value.toLowerCase(Locale.ROOT) : value;
    }

    private boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
    }

    private String messageOrFallback(Throwable error) {
        return error.getMessage() == null || error.getMessage().isBlank()
                ? error.getClass().getSimpleName()
                : error.getMessage();
    }

    private record BatchReservation(TaskCorrectionBatch batch, boolean created) {
    }
}
