package com.mediamarshal.service.correction;

import com.mediamarshal.model.dto.MatchResult;
import com.mediamarshal.model.dto.TaskCorrectionBatchPreview;
import com.mediamarshal.model.dto.TaskCorrectionBatchPreviewItem;
import com.mediamarshal.model.dto.TaskCorrectionBatchRequest;
import com.mediamarshal.model.dto.TaskCorrectionOperation;
import com.mediamarshal.model.dto.TaskCorrectionPreview;
import com.mediamarshal.model.dto.TaskCorrectionRequest;
import com.mediamarshal.model.entity.MediaTask;
import com.mediamarshal.model.entity.TaskCorrectionBatchItem;
import com.mediamarshal.repository.MediaTaskRepository;
import com.mediamarshal.repository.TaskCorrectionBatchItemRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class TaskCorrectionBatchPreviewService {

    private static final List<TaskCorrectionBatchItem.Status> ACTIVE_ITEM_STATUSES = List.of(
            TaskCorrectionBatchItem.Status.PENDING,
            TaskCorrectionBatchItem.Status.RUNNING
    );

    private final TaskCorrectionScopeService scopeService;
    private final TaskCorrectionService correctionService;
    private final MediaTaskRepository taskRepository;
    private final TaskCorrectionBatchItemRepository batchItemRepository;

    public TaskCorrectionBatchPreview preview(Long anchorTaskId, TaskCorrectionBatchRequest request) {
        if (request == null) {
            throw new IllegalArgumentException("批量修正请求不能为空");
        }
        TaskCorrectionResolvedScope resolved = scopeService.resolve(anchorTaskId, request.getScope());
        LinkedHashSet<String> batchBlockers = new LinkedHashSet<>();
        LinkedHashSet<String> batchWarnings = new LinkedHashSet<>();
        Set<Long> excludedTaskIds = normalizeExcludedTaskIds(request.getExcludedTaskIds());
        Set<Long> scopeTaskIds = resolved.tasks().stream().map(MediaTask::getId).collect(Collectors.toSet());
        Set<Long> invalidExcludedIds = excludedTaskIds.stream()
                .filter(taskId -> !scopeTaskIds.contains(taskId))
                .collect(Collectors.toCollection(LinkedHashSet::new));
        if (!invalidExcludedIds.isEmpty()) {
            batchBlockers.add("排除任务不属于当前修正范围：" + invalidExcludedIds);
        }

        String parsedTitle = request.getParsedTitle() == null ? "" : request.getParsedTitle().trim();
        if (parsedTitle.isBlank()) {
            batchBlockers.add("公共解析标题不能为空");
        }
        if (request.getTmdbId() == null) {
            batchBlockers.add("请选择 TMDB 剧集候选");
        }

        MatchResult selectedMatch = loadSelectedMatch(request.getTmdbId(), batchBlockers);
        if (selectedMatch != null && !MediaTask.MediaType.TV_SHOW.name().equals(selectedMatch.getMediaType())) {
            batchBlockers.add("批量剧集修正只能选择 TV_SHOW 候选");
            selectedMatch = null;
        }

        List<MutablePreviewItem> mutableItems = new ArrayList<>();
        Map<Long, TaskCorrectionPlan> plansByTaskId = new LinkedHashMap<>();
        for (MediaTask task : resolved.tasks()) {
            boolean selected = !excludedTaskIds.contains(task.getId());
            MutablePreviewItem item;
            if (selectedMatch == null || parsedTitle.isBlank()) {
                item = MutablePreviewItem.withoutPlan(task, selected);
            } else {
                TaskCorrectionRequest singleRequest = singleRequest(task, request, parsedTitle);
                try {
                    TaskCorrectionPlan plan = correctionService.prepare(task.getId(), singleRequest, selectedMatch);
                    plansByTaskId.put(task.getId(), plan);
                    item = MutablePreviewItem.fromPlan(task, plan, selected);
                } catch (RuntimeException e) {
                    item = MutablePreviewItem.withoutPlan(task, selected);
                    item.blockers.add(messageOrFallback(e, "任务修正预览计算失败"));
                }
            }
            if (selected && batchItemRepository.existsByOriginalTaskIdAndStatusIn(task.getId(), ACTIVE_ITEM_STATUSES)) {
                item.blockers.add("任务已被其它批量修正作业占用");
            }
            mutableItems.add(item);
        }

        addGlobalPathConflicts(mutableItems, plansByTaskId);
        addSharedFileWarning(resolved.tasks(), batchWarnings);
        if (resolved.tasks().stream().map(MediaTask::getParsedSeason).filter(Objects::nonNull).distinct().count() > 1) {
            batchWarnings.add("当前修正范围跨越多个季");
        }
        if (!excludedTaskIds.isEmpty()) {
            batchWarnings.add("本次显式排除了 " + excludedTaskIds.size() + " 个任务");
        }
        batchWarnings.add("批量作业可能部分成功，失败条目需要单独重试");

        List<MutablePreviewItem> selectedItems = mutableItems.stream().filter(item -> item.selected).toList();
        if (selectedItems.isEmpty()) {
            batchBlockers.add("至少保留一个任务用于批量修正");
        }
        int applicableCount = (int) selectedItems.stream().filter(item -> item.blockers.isEmpty()).count();
        int blockerCount = batchBlockers.size()
                + selectedItems.stream().mapToInt(item -> item.blockers.size()).sum();
        int warningCount = batchWarnings.size()
                + selectedItems.stream().mapToInt(item -> item.warnings.size()).sum();
        boolean canApply = batchBlockers.isEmpty()
                && !selectedItems.isEmpty()
                && selectedItems.stream().allMatch(item -> item.blockers.isEmpty());

        return new TaskCorrectionBatchPreview(
                resolved.scope().name(),
                mutableItems.size(),
                selectedItems.size(),
                applicableCount,
                blockerCount,
                warningCount,
                canApply,
                resolved.groupFingerprint(),
                copySeriesMatch(selectedMatch),
                List.copyOf(batchBlockers),
                List.copyOf(batchWarnings),
                mutableItems.stream().map(MutablePreviewItem::toDto).toList()
        );
    }

    private MatchResult loadSelectedMatch(Long tmdbId, Set<String> batchBlockers) {
        if (tmdbId == null) {
            return null;
        }
        try {
            return correctionService.loadSelectedMatch(tmdbId, MediaTask.MediaType.TV_SHOW);
        } catch (RuntimeException e) {
            batchBlockers.add("TMDB 剧集详情获取失败：" + messageOrFallback(e, String.valueOf(tmdbId)));
            return null;
        }
    }

    private TaskCorrectionRequest singleRequest(
            MediaTask task,
            TaskCorrectionBatchRequest batchRequest,
            String parsedTitle
    ) {
        TaskCorrectionRequest request = new TaskCorrectionRequest();
        request.setMediaType(MediaTask.MediaType.TV_SHOW.name());
        request.setParsedTitle(parsedTitle);
        request.setParsedYear(batchRequest.getParsedYear());
        request.setParsedSeason(task.getParsedSeason());
        request.setParsedEpisode(task.getParsedEpisode());
        request.setParsedEpisodeEnd(task.getParsedEpisodeEnd());
        request.setTmdbId(batchRequest.getTmdbId());
        request.setRegenerateNfo(Boolean.TRUE.equals(batchRequest.getRegenerateNfo()));
        return request;
    }

    private Set<Long> normalizeExcludedTaskIds(List<Long> taskIds) {
        if (taskIds == null) {
            return Set.of();
        }
        return taskIds.stream()
                .filter(Objects::nonNull)
                .collect(Collectors.toCollection(LinkedHashSet::new));
    }

    private void addGlobalPathConflicts(
            List<MutablePreviewItem> items,
            Map<Long, TaskCorrectionPlan> plansByTaskId
    ) {
        List<MutablePreviewItem> selected = items.stream().filter(item -> item.selected).toList();
        Map<String, List<MutablePreviewItem>> currentPathOwners = selected.stream()
                .filter(item -> item.currentTargetPath != null)
                .collect(Collectors.groupingBy(
                        item -> pathKey(item.currentTargetPath),
                        LinkedHashMap::new,
                        Collectors.toList()
                ));
        currentPathOwners.values().stream()
                .filter(owners -> owners.size() > 1)
                .forEach(owners -> owners.forEach(item -> item.blockers.add("批次中多个任务声明了相同当前目标路径")));

        Map<String, List<MutablePreviewItem>> correctedPathOwners = selected.stream()
                .filter(item -> item.correctedTargetPath != null)
                .collect(Collectors.groupingBy(
                        item -> pathKey(item.correctedTargetPath),
                        LinkedHashMap::new,
                        Collectors.toList()
                ));
        correctedPathOwners.values().stream()
                .filter(owners -> owners.size() > 1)
                .forEach(owners -> owners.forEach(item -> item.blockers.add("批次中多个任务生成了相同修正目标路径")));

        Map<String, List<MutablePreviewItem>> moveTargetOwners = new HashMap<>();
        for (MutablePreviewItem item : selected) {
            TaskCorrectionPlan plan = plansByTaskId.get(item.taskId);
            if (plan == null) {
                continue;
            }
            for (TaskCorrectionFileMove move : plan.moves()) {
                moveTargetOwners.computeIfAbsent(pathKey(move.target().toString()), ignored -> new ArrayList<>()).add(item);
            }
        }
        moveTargetOwners.values().stream()
                .filter(owners -> owners.stream().map(item -> item.taskId).distinct().count() > 1)
                .forEach(owners -> owners.forEach(item -> item.blockers.add("批次中主资产或附属文件生成了重复目标路径")));

        Map<String, List<Long>> effectiveCurrentOwners = taskRepository.findByStatus(MediaTask.TaskStatus.DONE).stream()
                .filter(task -> task.getTargetPath() != null && !task.getTargetPath().isBlank())
                .collect(Collectors.groupingBy(
                        task -> pathKey(task.getTargetPath()),
                        Collectors.mapping(MediaTask::getId, Collectors.toList())
                ));
        for (MutablePreviewItem item : selected) {
            if (item.correctedTargetPath == null) {
                continue;
            }
            List<Long> owners = effectiveCurrentOwners.getOrDefault(pathKey(item.correctedTargetPath), List.of());
            if (owners.stream().anyMatch(ownerId -> !ownerId.equals(item.taskId))) {
                item.blockers.add("修正目标路径是其它当前有效任务的主资产路径");
            }
        }
    }

    private void addSharedFileWarning(List<MediaTask> tasks, Set<String> warnings) {
        Set<Path> inspectedDirs = new HashSet<>();
        for (MediaTask task : tasks) {
            Path target = parsePath(task.getTargetPath());
            Path parent = target == null ? null : target.getParent();
            if (parent == null || !Files.isDirectory(parent) || !inspectedDirs.add(parent)) {
                continue;
            }
            try (var stream = Files.list(parent)) {
                if (stream.filter(Files::isRegularFile).anyMatch(this::isSharedTvFile)) {
                    warnings.add("检测到剧集共享封面、fanart、季海报或 tvshow.nfo，第一版不会自动移动");
                    return;
                }
            } catch (IOException ignored) {
                // Individual plan validation reports path access failures; shared-file discovery is warning-only.
            }
        }
    }

    private boolean isSharedTvFile(Path file) {
        String name = file.getFileName().toString().toLowerCase(Locale.ROOT);
        return name.equals("poster.jpg")
                || name.equals("folder.jpg")
                || name.equals("cover.jpg")
                || name.equals("tvshow.nfo")
                || name.startsWith("fanart.")
                || (name.startsWith("season") && (name.endsWith(".jpg") || name.endsWith(".png") || name.endsWith(".webp")));
    }

    private Path parsePath(String value) {
        if (value == null || value.isBlank()) {
            return null;
        }
        try {
            return Paths.get(value).toAbsolutePath().normalize();
        } catch (RuntimeException e) {
            return null;
        }
    }

    private String pathKey(String path) {
        Path parsed = parsePath(path);
        String value = parsed == null ? String.valueOf(path) : parsed.toString();
        return isWindows() ? value.toLowerCase(Locale.ROOT) : value;
    }

    private boolean isWindows() {
        return System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win");
    }

    private MatchResult copySeriesMatch(MatchResult source) {
        if (source == null) {
            return null;
        }
        MatchResult copy = new MatchResult();
        copy.setSource(source.getSource());
        copy.setSourceId(source.getSourceId());
        copy.setTitle(source.getTitle());
        copy.setOriginalTitle(source.getOriginalTitle());
        copy.setYear(source.getYear());
        copy.setMediaType(source.getMediaType());
        copy.setOverview(source.getOverview());
        copy.setPosterUrl(source.getPosterUrl());
        copy.setGenres(source.getGenres() == null ? List.of() : List.copyOf(source.getGenres()));
        copy.setCountry(source.getCountry());
        copy.setConfidence(source.getConfidence());
        copy.setEpisodeTitle(null);
        return copy;
    }

    private String messageOrFallback(Throwable error, String fallback) {
        return error.getMessage() == null || error.getMessage().isBlank() ? fallback : error.getMessage();
    }

    private static final class MutablePreviewItem {
        private final Long taskId;
        private final Integer season;
        private final Integer episode;
        private final Integer episodeEnd;
        private final String currentTargetPath;
        private String correctedTargetPath;
        private boolean sameTargetPath;
        private int associatedFileCount;
        private List<TaskCorrectionOperation> operations = List.of();
        private final List<String> blockers = new ArrayList<>();
        private final List<String> warnings = new ArrayList<>();
        private final boolean selected;

        private MutablePreviewItem(MediaTask task, boolean selected) {
            this.taskId = task.getId();
            this.season = task.getParsedSeason();
            this.episode = task.getParsedEpisode();
            this.episodeEnd = task.getParsedEpisodeEnd();
            this.currentTargetPath = task.getTargetPath();
            this.selected = selected;
        }

        static MutablePreviewItem withoutPlan(MediaTask task, boolean selected) {
            return new MutablePreviewItem(task, selected);
        }

        static MutablePreviewItem fromPlan(MediaTask task, TaskCorrectionPlan plan, boolean selected) {
            MutablePreviewItem item = new MutablePreviewItem(task, selected);
            TaskCorrectionPreview preview = plan.preview();
            item.correctedTargetPath = preview.getCorrectedTargetPath();
            item.sameTargetPath = preview.isSameTargetPath();
            item.operations = List.copyOf(preview.getOperations());
            item.associatedFileCount = (int) preview.getOperations().stream()
                    .filter(operation -> TaskCorrectionOperation.OperationType.MOVE_ASSOCIATED_FILE.equals(operation.getType()))
                    .count();
            item.blockers.addAll(preview.getBlockers());
            item.warnings.addAll(preview.getWarnings());
            return item;
        }

        TaskCorrectionBatchPreviewItem toDto() {
            return new TaskCorrectionBatchPreviewItem(
                    taskId,
                    season,
                    episode,
                    episodeEnd,
                    currentTargetPath,
                    correctedTargetPath,
                    sameTargetPath,
                    associatedFileCount,
                    operations,
                    List.copyOf(new LinkedHashSet<>(blockers)),
                    List.copyOf(new LinkedHashSet<>(warnings)),
                    selected
            );
        }
    }
}
