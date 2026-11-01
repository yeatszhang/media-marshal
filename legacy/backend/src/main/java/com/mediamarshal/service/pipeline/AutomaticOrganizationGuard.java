package com.mediamarshal.service.pipeline;

import com.mediamarshal.model.dto.ParseResult;
import com.mediamarshal.model.entity.MediaTask;
import com.mediamarshal.repository.MediaTaskRepository;
import com.mediamarshal.service.discovery.asset.VideoFileAssetDetector;
import com.mediamarshal.service.parser.EpisodeSeasonResolver;
import com.mediamarshal.service.parser.GuessitParserClient;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.regex.Pattern;

/** 在任何文件移动前检查整批计划，也检查尚未来得及入队的同目录副本。 */
@Service
@RequiredArgsConstructor
public class AutomaticOrganizationGuard {
    private static final Pattern SEASON_EPISODE = Pattern.compile("(?i)(?:^|[^a-z0-9])S(\\d{1,3})E(\\d{1,4})(?:[-~–]E?(\\d{1,4}))?(?=$|[^0-9])");
    private static final Pattern BRACKET_EPISODE = Pattern.compile("\\[(\\d{1,4})(?:[-~–](\\d{1,4}))?]");
    private static final Pattern NUMERIC_EPISODE = Pattern.compile("^(\\d{1,4})(?:[-~–](\\d{1,4}))?\\.[^.]+$");
    private final MediaTaskRepository taskRepository;
    private final GuessitParserClient parserClient;
    private final VideoFileAssetDetector videoDetector;

    public Map<Long, String> conflicts(List<MediaTask> tasks, Map<Long, Path> targets) {
        return conflicts(tasks, targets, Map.of());
    }

    public Map<Long, String> conflicts(List<MediaTask> tasks, Map<Long, Path> targets, Map<Long, List<Integer>> sourceSeasons) {
        Map<Long, String> issues = new LinkedHashMap<>();
        Map<Path, List<MediaTask>> directories = new LinkedHashMap<>();
        Map<Path, List<MediaTask>> destinations = new LinkedHashMap<>();
        for (MediaTask task : tasks) {
            Path source = Path.of(task.getSourcePath()).toAbsolutePath().normalize();
            directories.computeIfAbsent(source.getParent(), ignored -> new ArrayList<>()).add(task);
            Path target = targets.get(task.getId());
            if (target != null) {
                target = target.toAbsolutePath().normalize();
                destinations.computeIfAbsent(target, ignored -> new ArrayList<>()).add(task);
                if (Files.exists(target)) addIssue(issues, task, "目标路径已存在：" + target + "。请检查已有文件或修改路径模板。");
            }
        }
        destinations.forEach((target, group) -> {
            if (group.size() < 2) return;
            String files = group.stream().map(this::filename).reduce((a, b) -> a + "、" + b).orElse("");
            for (MediaTask task : group) addIssue(issues, task,
                    "多个文件指向同一目标：" + target + "（" + files + "）。请排除副本或修改路径模板。");
        });
        directories.forEach((directory, group) -> {
            if (group.stream().noneMatch(t -> t.getMediaType() == MediaTask.MediaType.TV_SHOW)) return;
            try {
                Map<Path, MediaTask> siblings = new LinkedHashMap<>();
                // 已有解析优先，避免把用户修正过的坐标重新用文件名覆盖。
                for (Long ruleId : group.stream().map(MediaTask::getRuleId).distinct().toList()) {
                    for (MediaTask known : taskRepository.findByRuleIdAndStatusIn(ruleId, List.of(
                            MediaTask.TaskStatus.PENDING, MediaTask.TaskStatus.PROCESSING,
                            MediaTask.TaskStatus.AWAITING_CONFIRMATION))) {
                        Path path = Path.of(known.getSourcePath()).toAbsolutePath().normalize();
                        if (directory.equals(path.getParent()) && Files.isRegularFile(path)) siblings.put(path, known);
                    }
                }
                for (MediaTask task : group) siblings.put(Path.of(task.getSourcePath()).toAbsolutePath().normalize(), task);
                try (var stream = Files.list(directory)) {
                    for (Path path : stream.filter(Files::isRegularFile).filter(videoDetector::isVideoFile).toList()) {
                        MediaTask known = siblings.get(path);
                        if (known != null && known.getParsedEpisode() != null) continue;
                        ParseResult parsed = parseCoordinates(path);
                        if (parsed == null) throw new IllegalStateException("无法解析 " + path.getFileName());
                        MediaTask sibling = new MediaTask();
                        sibling.setSourcePath(path.toString());
                        sibling.setParsedSeason(EpisodeSeasonResolver.resolve(parsed.getSeason(), null, path));
                        sibling.setParsedEpisode(parsed.getEpisode());
                        sibling.setParsedEpisodeEnd(parsed.getEpisodeEnd());
                        siblings.put(path, sibling);
                    }
                }
                for (MediaTask task : group) {
                    if (task.getMediaType() != MediaTask.MediaType.TV_SHOW || task.getParsedEpisode() == null) continue;
                    for (MediaTask other : siblings.values()) {
                        if (Path.of(task.getSourcePath()).equals(Path.of(other.getSourcePath()))
                                || !(Objects.equals(task.getParsedSeason(), other.getParsedSeason())
                                    // 未入队或尚未重识别的副本仍携带修正前的季号。
                                    || (other.getParsedSeason() != null
                                        && sourceSeasons.getOrDefault(task.getId(), List.of()).contains(other.getParsedSeason())))
                                || (task.getTmdbId() != null && other.getTmdbId() != null
                                    && !task.getTmdbId().equals(other.getTmdbId()))
                                || other.getParsedEpisode() == null) continue;
                        int start = Math.max(task.getParsedEpisode(), other.getParsedEpisode());
                        int end = Math.min(end(task), end(other));
                        if (start <= end) addIssue(issues, task, "季集号重复或重叠 "
                                + "S%02dE%02d".formatted(task.getParsedSeason(), start)
                                + (start == end ? "" : "–E%02d".formatted(end)) + "："
                                + filename(task) + "、" + filename(other) + "。请修正季集号或排除重复文件。");
                    }
                }
            } catch (IOException | RuntimeException e) {
                for (MediaTask task : group) addIssue(issues, task,
                        "无法完成目录重复文件检查：" + directory + "（" + e.getMessage() + "）。请重试或手动核对。");
            }
        });
        return issues;
    }

    private ParseResult parseCoordinates(Path path) {
        String filename = path.getFileName().toString();
        ParseResult parsed = new ParseResult();
        var explicit = SEASON_EPISODE.matcher(filename);
        if (explicit.find()) {
            parsed.setSeason(Integer.parseInt(explicit.group(1)));
            parsed.setEpisode(Integer.parseInt(explicit.group(2)));
            parsed.setEpisodeEnd(explicit.group(3) == null ? null : Integer.parseInt(explicit.group(3)));
            return parsed;
        }
        var brackets = BRACKET_EPISODE.matcher(filename);
        while (brackets.find()) {
            parsed.setEpisode(Integer.parseInt(brackets.group(1)));
            parsed.setEpisodeEnd(brackets.group(2) == null ? null : Integer.parseInt(brackets.group(2)));
        }
        if (parsed.getEpisode() != null) return parsed;
        String withoutHash = filename.replaceFirst("-[a-fA-F0-9]{8,}(?=\\.[^.]+$)", "");
        var numeric = NUMERIC_EPISODE.matcher(withoutHash);
        if (numeric.matches()) {
            parsed.setEpisode(Integer.parseInt(numeric.group(1)));
            parsed.setEpisodeEnd(numeric.group(2) == null ? null : Integer.parseInt(numeric.group(2)));
            return parsed;
        }
        return parserClient.parse(filename);
    }

    private int end(MediaTask task) {
        return task.getParsedEpisodeEnd() == null ? task.getParsedEpisode() : task.getParsedEpisodeEnd();
    }

    private String filename(MediaTask task) {
        return Path.of(task.getSourcePath()).getFileName().toString();
    }

    private void addIssue(Map<Long, String> issues, MediaTask task, String issue) {
        issues.merge(task.getId(), issue, (previous, next) -> previous + "\n" + next);
    }
}
