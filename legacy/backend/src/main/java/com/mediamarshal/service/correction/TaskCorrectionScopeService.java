package com.mediamarshal.service.correction;

import com.mediamarshal.model.dto.TaskCorrectionScopesResponse;
import com.mediamarshal.model.entity.MediaAssetType;
import com.mediamarshal.model.entity.MediaTask;
import com.mediamarshal.model.entity.TaskCorrectionBatch;
import com.mediamarshal.repository.MediaTaskRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;

@Service
@RequiredArgsConstructor
public class TaskCorrectionScopeService {

    private final MediaTaskRepository taskRepository;

    public TaskCorrectionScopesResponse getScopes(Long anchorTaskId) {
        MediaTask anchor = loadAnchor(anchorTaskId);
        List<String> unsupportedReasons = anchorUnsupportedReasons(anchor);
        List<MediaTask> seriesTasks = canResolveSeries(anchor)
                ? loadSeriesTasks(anchor)
                : List.of();
        List<MediaTask> seasonTasks = anchor.getParsedSeason() == null
                ? List.of()
                : seriesTasks.stream()
                        .filter(task -> anchor.getParsedSeason().equals(task.getParsedSeason()))
                        .toList();
        List<Integer> seasons = seriesTasks.stream()
                .map(MediaTask::getParsedSeason)
                .filter(java.util.Objects::nonNull)
                .sorted()
                .toList();
        List<String> warnings = scopeWarnings(seriesTasks);
        return new TaskCorrectionScopesResponse(
                anchor.getId(),
                unsupportedReasons.isEmpty(),
                1,
                seasonTasks.size(),
                seriesTasks.size(),
                anchor.getParsedSeason(),
                seasons.isEmpty() ? null : seasons.getFirst(),
                seasons.isEmpty() ? null : seasons.getLast(),
                List.copyOf(warnings),
                List.copyOf(unsupportedReasons)
        );
    }

    TaskCorrectionResolvedScope resolve(Long anchorTaskId, String scopeValue) {
        MediaTask anchor = loadAnchor(anchorTaskId);
        List<String> unsupportedReasons = anchorUnsupportedReasons(anchor);
        if (!unsupportedReasons.isEmpty()) {
            throw new IllegalArgumentException(String.join("；", unsupportedReasons));
        }
        TaskCorrectionBatch.Scope scope = parseScope(scopeValue);
        if (TaskCorrectionBatch.Scope.SAME_SEASON.equals(scope) && anchor.getParsedSeason() == null) {
            throw new IllegalArgumentException("同季批量修正要求锚点任务具有季号");
        }
        List<MediaTask> tasks = TaskCorrectionBatch.Scope.SAME_SEASON.equals(scope)
                ? taskRepository.findByStatusAndMediaTypeAndTmdbIdAndRuleIdAndParsedSeason(
                        MediaTask.TaskStatus.DONE,
                        MediaTask.MediaType.TV_SHOW,
                        anchor.getTmdbId(),
                        anchor.getRuleId(),
                        anchor.getParsedSeason()
                )
                : loadSeriesTasks(anchor);
        List<MediaTask> sorted = tasks.stream().sorted(taskComparator()).toList();
        if (sorted.stream().noneMatch(task -> anchor.getId().equals(task.getId()))) {
            throw new IllegalStateException("锚点任务已不在当前批量修正范围，请刷新后重试");
        }
        return new TaskCorrectionResolvedScope(anchor, scope, sorted, fingerprint(sorted));
    }

    private MediaTask loadAnchor(Long anchorTaskId) {
        return taskRepository.findById(anchorTaskId)
                .orElseThrow(() -> new IllegalArgumentException("修正锚点任务不存在：" + anchorTaskId));
    }

    private List<MediaTask> loadSeriesTasks(MediaTask anchor) {
        return taskRepository.findByStatusAndMediaTypeAndTmdbIdAndRuleId(
                MediaTask.TaskStatus.DONE,
                MediaTask.MediaType.TV_SHOW,
                anchor.getTmdbId(),
                anchor.getRuleId()
        );
    }

    private boolean canResolveSeries(MediaTask anchor) {
        return anchor.getTmdbId() != null && anchor.getRuleId() != null;
    }

    private List<String> anchorUnsupportedReasons(MediaTask anchor) {
        List<String> reasons = new ArrayList<>();
        if (!MediaTask.TaskStatus.DONE.equals(anchor.getStatus())) {
            reasons.add("只有已完成任务支持批量修正");
        }
        if (!MediaTask.MediaType.TV_SHOW.equals(anchor.getMediaType())) {
            reasons.add("只有剧集任务支持同季或同剧集批量修正");
        }
        if (!MediaAssetType.VIDEO_FILE.equals(assetType(anchor))) {
            reasons.add("批量修正第一版只支持普通视频文件");
        }
        if (anchor.getTmdbId() == null) {
            reasons.add("锚点任务缺少 TMDB ID");
        }
        if (anchor.getRuleId() == null) {
            reasons.add("锚点任务缺少监控规则");
        }
        if (anchor.getTargetPath() == null || anchor.getTargetPath().isBlank()) {
            reasons.add("锚点任务缺少当前目标路径");
        }
        return reasons;
    }

    private List<String> scopeWarnings(List<MediaTask> tasks) {
        List<String> warnings = new ArrayList<>();
        if (tasks.stream().anyMatch(task -> task.getParsedSeason() == null)) {
            warnings.add("范围内存在缺少季号的任务，批量预览时会阻断该任务");
        }
        if (tasks.stream().anyMatch(task -> task.getParsedEpisode() == null)) {
            warnings.add("范围内存在缺少集号的任务，批量预览时会阻断该任务");
        }
        if (tasks.stream().anyMatch(task -> task.getTargetPath() == null || task.getTargetPath().isBlank())) {
            warnings.add("范围内存在缺少目标路径的任务，批量预览时会阻断该任务");
        }
        return warnings;
    }

    private TaskCorrectionBatch.Scope parseScope(String value) {
        try {
            TaskCorrectionBatch.Scope scope = TaskCorrectionBatch.Scope.valueOf(value == null ? "" : value.trim());
            if (TaskCorrectionBatch.Scope.SAME_SEASON.equals(scope)
                    || TaskCorrectionBatch.Scope.SAME_SERIES.equals(scope)) {
                return scope;
            }
        } catch (IllegalArgumentException ignored) {
            // Fall through to the stable API error below.
        }
        throw new IllegalArgumentException("批量修正范围必须是 SAME_SEASON 或 SAME_SERIES");
    }

    private Comparator<MediaTask> taskComparator() {
        Comparator<Integer> integers = Comparator.nullsLast(Integer::compareTo);
        return (left, right) -> {
            int result = integers.compare(left.getParsedSeason(), right.getParsedSeason());
            if (result == 0) {
                result = integers.compare(left.getParsedEpisode(), right.getParsedEpisode());
            }
            if (result == 0) {
                result = integers.compare(left.getParsedEpisodeEnd(), right.getParsedEpisodeEnd());
            }
            if (result == 0) {
                result = compareNatural(fileName(left.getTargetPath()), fileName(right.getTargetPath()));
            }
            if (result == 0) {
                result = Comparator.nullsLast(Long::compareTo).compare(left.getId(), right.getId());
            }
            return result;
        };
    }

    private String fingerprint(List<MediaTask> tasks) {
        StringBuilder value = new StringBuilder();
        for (MediaTask task : tasks) {
            value.append(task.getId()).append('|')
                    .append(task.getUpdatedAt()).append('|')
                    .append(task.getStatus()).append('|')
                    .append(task.getTargetPath()).append('|')
                    .append(task.getAssetType()).append('|')
                    .append(task.getTmdbId()).append('|')
                    .append(task.getRuleId()).append('|')
                    .append(task.getParsedSeason()).append('|')
                    .append(task.getParsedEpisode()).append('|')
                    .append(task.getParsedEpisodeEnd()).append('\n');
        }
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(value.toString().getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("当前 Java 环境不支持 SHA-256", e);
        }
    }

    private MediaAssetType assetType(MediaTask task) {
        return task.getAssetType() == null ? MediaAssetType.VIDEO_FILE : task.getAssetType();
    }

    private String fileName(String path) {
        if (path == null || path.isBlank()) {
            return "";
        }
        try {
            Path fileName = Paths.get(path).getFileName();
            return fileName == null ? path : fileName.toString();
        } catch (RuntimeException e) {
            return path;
        }
    }

    private int compareNatural(String left, String right) {
        String a = left == null ? "" : left.toLowerCase(Locale.ROOT);
        String b = right == null ? "" : right.toLowerCase(Locale.ROOT);
        int leftIndex = 0;
        int rightIndex = 0;
        while (leftIndex < a.length() && rightIndex < b.length()) {
            char leftChar = a.charAt(leftIndex);
            char rightChar = b.charAt(rightIndex);
            if (Character.isDigit(leftChar) && Character.isDigit(rightChar)) {
                int leftEnd = digitEnd(a, leftIndex);
                int rightEnd = digitEnd(b, rightIndex);
                String leftNumber = stripLeadingZeros(a.substring(leftIndex, leftEnd));
                String rightNumber = stripLeadingZeros(b.substring(rightIndex, rightEnd));
                int result = Integer.compare(leftNumber.length(), rightNumber.length());
                if (result == 0) {
                    result = leftNumber.compareTo(rightNumber);
                }
                if (result != 0) {
                    return result;
                }
                leftIndex = leftEnd;
                rightIndex = rightEnd;
                continue;
            }
            if (leftChar != rightChar) {
                return Character.compare(leftChar, rightChar);
            }
            leftIndex++;
            rightIndex++;
        }
        return Integer.compare(a.length(), b.length());
    }

    private int digitEnd(String value, int start) {
        int end = start;
        while (end < value.length() && Character.isDigit(value.charAt(end))) {
            end++;
        }
        return end;
    }

    private String stripLeadingZeros(String value) {
        int index = 0;
        while (index < value.length() - 1 && value.charAt(index) == '0') {
            index++;
        }
        return value.substring(index);
    }
}
