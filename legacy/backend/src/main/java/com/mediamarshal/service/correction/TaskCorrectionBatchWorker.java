package com.mediamarshal.service.correction;

import com.mediamarshal.model.dto.MatchResult;
import com.mediamarshal.model.dto.TaskCorrectionApplyResponse;
import com.mediamarshal.model.dto.TaskCorrectionRequest;
import com.mediamarshal.model.entity.MediaTask;
import com.mediamarshal.model.entity.TaskCorrectionBatch;
import com.mediamarshal.model.entity.TaskCorrectionBatchItem;
import com.mediamarshal.repository.MediaTaskRepository;
import com.mediamarshal.repository.TaskCorrectionBatchItemRepository;
import com.mediamarshal.repository.TaskCorrectionBatchRepository;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

@Slf4j
@Component
@RequiredArgsConstructor
class TaskCorrectionBatchWorker {

    private final TaskCorrectionBatchRepository batchRepository;
    private final TaskCorrectionBatchItemRepository itemRepository;
    private final MediaTaskRepository taskRepository;
    private final TaskCorrectionService correctionService;
    private final TaskCorrectionBatchStateService stateService;
    private final TaskCorrectionConcurrencyGuard concurrencyGuard;
    private final TaskCorrectionFileExecutor fileExecutor;

    void execute(Long batchId) {
        boolean started = false;
        try {
            stateService.markRunning(batchId);
            started = true;
            TaskCorrectionBatch batch = loadBatch(batchId);
            MatchResult selectedMatch = correctionService.loadSelectedMatch(
                    batch.getTargetTmdbId(),
                    MediaTask.MediaType.TV_SHOW
            );
            if (!MediaTask.MediaType.TV_SHOW.name().equals(selectedMatch.getMediaType())) {
                throw new IllegalStateException("批量修正所选 TMDB 候选不再是剧集");
            }
            List<TaskCorrectionBatchItem> pendingItems = itemRepository.findByBatchIdAndStatusInOrderByExecutionOrderAsc(
                    batchId,
                    List.of(TaskCorrectionBatchItem.Status.PENDING)
            );
            List<CleanupTarget> cleanupTargets = new ArrayList<>();
            for (TaskCorrectionBatchItem item : pendingItems) {
                executeItem(batch, item, selectedMatch, cleanupTargets);
            }
            cleanupAfterBatch(cleanupTargets);
            TaskCorrectionBatch finished = stateService.finish(batchId);
            log.info("Correction batch finished: batchId={}, status={}, success={}, failed={}, excluded={}",
                    batchId,
                    finished.getStatus(),
                    finished.getSuccessCount(),
                    finished.getFailedCount(),
                    finished.getExcludedCount());
        } catch (Exception e) {
            String message = messageOrFallback(e, "批量修正执行失败");
            log.error("Correction batch failed: batchId={}, error={}", batchId, message, e);
            if (started) {
                try {
                    stateService.failBatch(batchId, message);
                } catch (Exception stateError) {
                    log.error("Failed to persist correction batch failure: batchId={}", batchId, stateError);
                }
            }
        }
    }

    private void executeItem(
            TaskCorrectionBatch batch,
            TaskCorrectionBatchItem item,
            MatchResult selectedMatch,
            List<CleanupTarget> cleanupTargets
    ) {
        try {
            stateService.markItemRunning(item.getId());
            ItemExecution execution = concurrencyGuard.executeReserved(
                    item.getOriginalTaskId(),
                    () -> executeReservedItem(batch, item, selectedMatch)
            );
            stateService.markItemSucceeded(
                    item.getId(),
                    execution.response().correctedTask().getId(),
                    execution.response().correctedTask().getTargetPath()
            );
            if (execution.plan().cleanupStartDir() != null && execution.plan().cleanupStopDir() != null) {
                cleanupTargets.add(new CleanupTarget(
                        execution.plan().cleanupStartDir(),
                        execution.plan().cleanupStopDir()
                ));
            }
        } catch (Exception e) {
            String error = messageOrFallback(e, "单条批量修正失败");
            String recovery = "原路径=" + item.getCurrentTargetPath()
                    + (item.getCorrectedTargetPath() == null ? "" : "；计划目标=" + item.getCorrectedTargetPath());
            stateService.markItemFailed(item.getId(), error, recovery);
            log.warn("Correction batch item failed: batchId={}, itemId={}, taskId={}, error={}",
                    batch.getId(), item.getId(), item.getOriginalTaskId(), error);
        }
    }

    private ItemExecution executeReservedItem(
            TaskCorrectionBatch batch,
            TaskCorrectionBatchItem item,
            MatchResult selectedMatch
    ) {
        MediaTask current = taskRepository.findById(item.getOriginalTaskId())
                .orElseThrow(() -> new IllegalStateException("原任务不存在：" + item.getOriginalTaskId()));
        if (!MediaTask.TaskStatus.DONE.equals(current.getStatus())) {
            throw new IllegalStateException("原任务状态已变化，不再是 DONE");
        }
        if (!samePath(current.getTargetPath(), item.getCurrentTargetPath())) {
            throw new IllegalStateException("原任务目标路径已变化，请重新预览");
        }
        TaskCorrectionRequest request = new TaskCorrectionRequest();
        request.setMediaType(MediaTask.MediaType.TV_SHOW.name());
        request.setParsedTitle(batch.getParsedTitle());
        request.setParsedYear(batch.getParsedYear());
        request.setParsedSeason(item.getSeason());
        request.setParsedEpisode(item.getEpisode());
        request.setParsedEpisodeEnd(item.getEpisodeEnd());
        request.setTmdbId(batch.getTargetTmdbId());
        request.setRegenerateNfo(batch.isRegenerateNfo());

        TaskCorrectionPlan plan = correctionService.prepare(item.getOriginalTaskId(), request, selectedMatch);
        if (!plan.preview().isCanApply()) {
            throw new IllegalStateException(String.join("；", plan.preview().getBlockers()));
        }
        if (item.getCorrectedTargetPath() != null
                && !samePath(item.getCorrectedTargetPath(), plan.preview().getCorrectedTargetPath())) {
            throw new IllegalStateException("修正目标路径与作业快照不一致，请重新预览");
        }
        TaskCorrectionApplyResponse response = correctionService.executePrepared(plan, false);
        return new ItemExecution(plan, response);
    }

    private void cleanupAfterBatch(List<CleanupTarget> cleanupTargets) {
        Map<String, CleanupTarget> unique = new LinkedHashMap<>();
        cleanupTargets.stream()
                .sorted(Comparator.comparingInt((CleanupTarget target) -> target.start().getNameCount()).reversed())
                .forEach(target -> unique.putIfAbsent(pathKey(target.start()), target));
        List<String> warnings = new ArrayList<>();
        for (CleanupTarget target : unique.values()) {
            fileExecutor.cleanupEmptyTargetDirs(target.start(), target.stop(), warnings);
        }
        warnings.forEach(warning -> log.warn("Correction batch cleanup warning: {}", warning));
    }

    private TaskCorrectionBatch loadBatch(Long batchId) {
        return batchRepository.findById(batchId)
                .orElseThrow(() -> new IllegalArgumentException("批量修正作业不存在：" + batchId));
    }

    private boolean samePath(String left, String right) {
        if (left == null || right == null) {
            return false;
        }
        return pathKey(Paths.get(left).toAbsolutePath().normalize())
                .equals(pathKey(Paths.get(right).toAbsolutePath().normalize()));
    }

    private String pathKey(Path path) {
        String value = path.toAbsolutePath().normalize().toString();
        return isWindows() ? value.toLowerCase(Locale.ROOT) : value;
    }

    private boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
    }

    private String messageOrFallback(Throwable error, String fallback) {
        return error.getMessage() == null || error.getMessage().isBlank() ? fallback : error.getMessage();
    }

    private record ItemExecution(TaskCorrectionPlan plan, TaskCorrectionApplyResponse response) {
    }

    private record CleanupTarget(Path start, Path stop) {
    }
}
