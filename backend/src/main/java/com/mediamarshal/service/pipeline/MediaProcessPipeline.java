package com.mediamarshal.service.pipeline;

import com.mediamarshal.model.dto.MatchResult;
import com.mediamarshal.model.dto.ParseResult;
import com.mediamarshal.model.dto.QueueRecognitionRequest;
import com.mediamarshal.model.dto.QueueRecognitionResponse;
import com.mediamarshal.model.dto.QueueDirectoryRecognitionResponse;
import com.mediamarshal.model.entity.MediaAssetType;
import com.mediamarshal.model.entity.MediaTask;
import com.mediamarshal.model.entity.TaskCandidate;
import com.mediamarshal.model.entity.WatchRule;
import com.mediamarshal.model.exception.MediaTaskFailureException;
import com.mediamarshal.notification.EmailNotificationService;
import com.mediamarshal.repository.MediaTaskRepository;
import com.mediamarshal.repository.TaskCandidateRepository;
import com.mediamarshal.repository.WatchRuleRepository;
import com.mediamarshal.service.discovery.asset.MediaAsset;
import com.mediamarshal.service.matcher.MetadataMatcher;
import com.mediamarshal.service.matcher.TmdbEpisodeService;
import com.mediamarshal.model.exception.EpisodeMetadataException;
import com.mediamarshal.service.matcher.ParentFolderMatchEnhancer;
import com.mediamarshal.service.parser.GuessitParserClient;
import com.mediamarshal.service.parser.CodexRecognitionService;
import com.mediamarshal.service.parser.EpisodeSeasonResolver;
import com.mediamarshal.service.rename.AssetOrganizerService;
import com.mediamarshal.service.rename.FileOperationStrategy;
import com.mediamarshal.service.rename.RenameService;
import com.mediamarshal.service.settings.SettingsService;
import com.mediamarshal.websocket.EventPublisher;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import jakarta.annotation.PreDestroy;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * 媒体处理流水线（核心业务协调层）
 *
 * 编排各服务，按以下步骤处理一个新发现的媒体文件：
 *
 *   Step 1: 入库（创建 MediaTask，记录触发规则 ruleId，状态 PENDING）
 *   Step 2: 解析文件名（调用 GuessitParserClient）
 *   Step 3: 判断媒体类型
 *             - 规则 mediaType = MOVIE/TV_SHOW：直接使用规则指定类型
 *             - 规则 mediaType = AUTO：使用 guessit 解析结果
 *             - AUTO 且 guessit 无法判断：进 AWAITING_CONFIRMATION 队列
 *   Step 4: TMDB 搜索匹配并保存候选
 *             - Step 4a: 调用 TMDB 搜索，获得候选列表
 *             - Step 4b: 将候选列表按置信度降序写入 task_candidate 表，记录 rank
 *   Step 5: 置信度判断
 *             - 高置信度：直接继续
 *             - 低置信度：状态改为 AWAITING_CONFIRMATION，推送 WebSocket + 邮件通知
 *             - 前端收到通知后，通过 Queue API 拉取 Step 4b 已保存的候选列表
 *   Step 6: 重命名文件（调用 RenameService，使用规则 targetDir + 对应媒体类型路径模板）
 *   Step 7: 整理同名附属文件，元数据刮削交给媒体服务器
 *   Step 8: 状态改为 DONE，推送 WebSocket 完成通知
 */
@Slf4j
@Service
@RequiredArgsConstructor
public class MediaProcessPipeline {

    public static final String SOURCE_MISSING_ERROR_MESSAGE = "源文件不存在，无法继续处理";

    private final GuessitParserClient parserClient;
    private final CodexRecognitionService codexRecognitionService;
    private final MetadataMatcher metadataMatcher;
    private final TmdbEpisodeService tmdbEpisodeService;
    private final AssetOrganizerService assetOrganizerService;
    private final RenameService renameService;
    private final MediaTaskRepository taskRepository;
    private final TaskCandidateRepository candidateRepository;
    private final WatchRuleRepository watchRuleRepository;
    private final SettingsService settingsService;
    private final EventPublisher eventPublisher;
    private final EmailNotificationService emailNotificationService;
    private final ParentFolderMatchEnhancer parentFolderMatchEnhancer;
    private final Map<String, FileOperationStrategy> fileOperationStrategies;
    private final AutomaticOrganizationGuard automaticOrganizationGuard;
    private final Map<Path, Long> automaticTargets = new LinkedHashMap<>();
    private final ExecutorService manualConfirmationExecutor = Executors.newFixedThreadPool(
            4,
            Thread.ofVirtual().name("manual-confirm-", 0).factory()
    );

    @PreDestroy
    public void shutdownManualConfirmationExecutor() {
        manualConfirmationExecutor.shutdown();
    }

    /**
     * 处理一个新发现的媒体文件（由 FileDiscoveryService 调用）
     *
     * @param file 媒体文件绝对路径
     * @param rule 触发此次处理的监控规则
     */
    public void process(Path file, WatchRule rule) {
        process(new MediaAsset(
                file.toAbsolutePath().normalize(),
                MediaAssetType.VIDEO_FILE,
                file.getFileName().toString(),
                false
        ), rule);
    }

    /**
     * 处理一个新发现的媒体资产（由 FileDiscoveryService 调用）。
     */
    public void process(MediaAsset asset, WatchRule rule) {
        log.info("Pipeline started: asset={}, type={}, rule='{}'",
                asset.rootPath(), asset.type(), rule.getName());

        boolean isDebug = Boolean.parseBoolean(settingsService.get("debug", "false"));

        // Step 1: 入库，记录触发规则
        MediaTask task = new MediaTask();
        task.setSourcePath(asset.rootPath().toAbsolutePath().normalize().toString());
        task.setAssetType(asset.type());
        task.setRuleId(rule.getId());
        task.setOperationType(rule.getOperation().name());
        task.setStatus(MediaTask.TaskStatus.PENDING);
        taskRepository.save(task);
        eventPublisher.publishTaskCreated(task);

        if (isDebug) {
            log.debug("Task created: id={}, ruleId={}, sourcePath={}, assetType={}",
                    task.getId(), rule.getId(), task.getSourcePath(), task.getAssetType());
        }

        try {
            task.setStatus(MediaTask.TaskStatus.PROCESSING);
            taskRepository.save(task);
            eventPublisher.publishTaskProcessing(task);

            // Step 2: guessit 解析文件名
            ParseResult parseResult;
            try {
                parseResult = parserClient.parse(asset.displayName());
            } catch (RuntimeException parserError) {
                if (!codexRecognitionService.isEnabled()) throw parserError;
                parseResult = new ParseResult();
                parseResult.setOriginalFilename(asset.displayName());
                log.warn("常规名称解析失败，尝试 Codex 兜底");
            }
            fillParsedFields(task, parseResult);

            CodexRecognitionService.Suggestion codexSuggestion = null;
            boolean clusterHandled = false;
            if (asset.type() == MediaAssetType.VIDEO_FILE) {
                var cluster = codexRecognitionService.recognizeCluster(asset.rootPath(), rule, parseResult);
                if (cluster != null) {
                    clusterHandled = cluster.clustered();
                    codexSuggestion = cluster.suggestion().orElse(null);
                    if (codexSuggestion != null) {
                        parseResult = codexSuggestion.parsed();
                        fillParsedFields(task, parseResult);
                    }
                }
            }

            // Step 3: 确定媒体类型
            Optional<MediaTask.MediaType> mediaType = resolveMediaType(rule, parseResult, task.getAssetType());
            if (mediaType.isEmpty() && !clusterHandled) {
                codexSuggestion = codexRecognitionService.recognize(asset.rootPath(), rule, parseResult).orElse(null);
                if (codexSuggestion != null) {
                    parseResult = codexSuggestion.parsed();
                    fillParsedFields(task, parseResult);
                    mediaType = resolveMediaType(rule, parseResult, task.getAssetType());
                }
            }
            if (mediaType.isEmpty()) {
                moveToAwaitingConfirmation(task, "Unable to detect media type from filename");
                return;
            }
            task.setMediaType(mediaType.get());
            applyMediaTypeToParseResult(parseResult, mediaType.get());
            taskRepository.save(task);

            // Step 4: TMDB 搜索并保存候选
            double confidenceThreshold = getConfidenceThreshold();
            List<MatchResult> candidates = parentFolderMatchEnhancer.enhanceIfNeeded(
                    asset,
                    parseResult,
                    metadataMatcher.search(parseResult),
                    confidenceThreshold
            );
            if (codexSuggestion == null && !clusterHandled && bestConfidence(candidates) < confidenceThreshold) {
                var suggestion = codexRecognitionService.recognize(asset.rootPath(), rule, parseResult);
                if (suggestion.isPresent()) {
                    var proposed = suggestion.get();
                    List<MatchResult> proposedMatches;
                    try {
                        proposedMatches = metadataMatcher.search(proposed.parsed());
                    } catch (RuntimeException unavailable) {
                        log.warn("Codex 建议的 TMDB 校验暂不可用，保留原有候选");
                        proposedMatches = List.of();
                    }
                    // 模型只提供解析建议；必须有 TMDB 候选，且不能降低已有匹配质量。
                    if (!proposedMatches.isEmpty() && bestConfidence(proposedMatches) >= bestConfidence(candidates)) {
                        codexSuggestion = proposed;
                        parseResult = proposed.parsed();
                        fillParsedFields(task, parseResult);
                        mediaType = resolveMediaType(rule, parseResult, task.getAssetType());
                        task.setMediaType(mediaType.orElseThrow());
                        taskRepository.save(task);
                        candidates = proposedMatches;
                    }
                }
            }
            if (task.getMediaType() == MediaTask.MediaType.TV_SHOW) {
                parseResult.setSeason(EpisodeSeasonResolver.resolve(parseResult.getSeason(), null, asset.rootPath()));
                task.setParsedSeason(parseResult.getSeason());
                taskRepository.save(task);
            }
            List<TaskCandidate> savedCandidates = saveCandidates(task, candidates);
            if (savedCandidates.isEmpty()) {
                moveToAwaitingConfirmation(task, "没有 TMDB 作品候选，请手动搜索作品或重新识别。");
                return;
            }

            reviewAutomaticOrganization(List.of(new AutomaticReview(task, savedCandidates, codexSuggestion)), false);

        } catch (EpisodeMetadataException e) {
            moveToAwaitingConfirmation(task, e.getMessage());
        } catch (Exception e) {
            log.error("Pipeline failed: asset={}, taskId={}", asset.rootPath(), task.getId(), e);
            recordFailure(task, e);
        }
    }

    private double bestConfidence(List<MatchResult> matches) {
        return matches == null ? 0 : matches.stream().map(MatchResult::getConfidence)
                .filter(Objects::nonNull).mapToDouble(Double::doubleValue).max().orElse(0);
    }

    /**
     * 人工确认低置信度任务（由 QueueController 调用）
     *
     * ADR-006 确认流程：
     *   1. 加载任务，校验状态必须为 AWAITING_CONFIRMATION
     *   2. 判断用户选择的 tmdbId 是否已存在于 task_candidate：
     *      - 若存在：将该候选 selected=true
     *      - 若不存在：说明来自用户重新搜索，新增一条 task_candidate 并 selected=true
     *   3. 优先使用已保存的 TaskCandidate 快照作为确认元数据
     *      - 只有用户确认的 TMDB ID 不在候选表中时，才调用 MetadataMatcher.getById() 创建手动候选
     *   4. 更新 MediaTask 的 tmdbId、mediaType、confirmedTitle、confirmedYear 等字段
     *   5. 继续执行 Step 6-8：重命名 -> 整理附属文件 -> DONE + WebSocket 通知
     *
     * @param taskId    任务 ID
     * @param tmdbId    用户选择的 TMDB ID
     * @param mediaType 用户确认的媒体类型
     */
    @SuppressWarnings("null")
    public void confirm(Long taskId, Long tmdbId, String mediaType) {
        confirm(taskId, tmdbId, mediaType, MediaTask.ConfirmationSource.MANUAL_SINGLE);
    }

    @SuppressWarnings("null")
    public void confirm(Long taskId, Long tmdbId, String mediaType, MediaTask.ConfirmationSource confirmationSource) {
        MediaTask task = taskRepository.findById(taskId)
                .orElseThrow(() -> new IllegalArgumentException("Task not found: " + taskId));

        if (!MediaTask.TaskStatus.AWAITING_CONFIRMATION.equals(task.getStatus())) {
            throw new IllegalStateException("Task is not awaiting confirmation: " + taskId);
        }
        ensureSourceFileExists(task);

        MediaTask.MediaType confirmedType = MediaTask.MediaType.valueOf(mediaType);
        ensureEpisodeCoordinates(task, confirmedType);
        TaskCandidate selectedCandidate = candidateRepository
                .findByTask_IdAndTmdbIdAndMediaType(taskId, tmdbId, confirmedType)
                .orElseGet(() -> createManualCandidate(task, tmdbId, confirmedType));

        MatchResult match;
        try {
            match = enrichSelectedMatch(task, selectedCandidate);
        } catch (EpisodeMetadataException e) {
            moveToAwaitingConfirmation(task, e.getMessage());
            throw e;
        }
        markCandidateSelected(taskId, selectedCandidate);
        applyMatchToTask(task, match);
        task.setConfirmationSource(confirmationSource);
        taskRepository.save(task);
        continueAfterMetadataConfirmed(task, match);
    }

    /**
     * 批量确认使用异步整理，避免一个 HTTP 请求等待多条任务的 TMDB 详情和文件操作。
     * 该方法只负责接收确认并把任务移出待确认队列；后续完成/失败通过任务状态和 WebSocket 体现。
     */
    @SuppressWarnings("null")
    public void submitConfirm(Long taskId, Long tmdbId, String mediaType, MediaTask.ConfirmationSource confirmationSource) {
        MediaTask task = taskRepository.findById(taskId)
                .orElseThrow(() -> new IllegalArgumentException("Task not found: " + taskId));

        if (!MediaTask.TaskStatus.AWAITING_CONFIRMATION.equals(task.getStatus())) {
            throw new IllegalStateException("Task is not awaiting confirmation: " + taskId);
        }
        ensureSourceFileExists(task);

        ensureEpisodeCoordinates(task, MediaTask.MediaType.valueOf(mediaType));
        task.setStatus(MediaTask.TaskStatus.PROCESSING);
        task.setErrorMessage(null);
        task.setConfirmationSource(confirmationSource);
        taskRepository.save(task);
        eventPublisher.publishTaskProcessing(task);

        manualConfirmationExecutor.submit(() -> completeSubmittedConfirm(taskId, tmdbId, mediaType, confirmationSource));
    }

    public QueueRecognitionResponse updateRecognition(Long taskId, QueueRecognitionRequest request) {
        MediaTask task = updateRecognitionFields(taskId, request);
        return new QueueRecognitionResponse(task, candidateRepository.findByTask_IdOrderByRankAsc(taskId));
    }

    public QueueRecognitionResponse updateRecognitionAndRematch(Long taskId, QueueRecognitionRequest request) {
        MediaTask task = updateRecognitionFields(taskId, request);
        ParseResult parseResult = toParseResult(task);
        List<TaskCandidate> candidates = saveCandidates(task, metadataMatcher.search(parseResult));
        task.setMatchConfidence(candidates.isEmpty() ? null : candidates.getFirst().getConfidence());
        taskRepository.save(task);
        return new QueueRecognitionResponse(task, candidates);
    }

    /** 重新识别后统一校验，仅无冲突的可靠结果继续自动整理。 */
    public QueueRecognitionResponse recognizeWithCodex(Long taskId) {
        MediaTask task = taskRepository.findById(taskId)
                .orElseThrow(() -> new IllegalArgumentException("任务不存在"));
        if (task.getStatus() != MediaTask.TaskStatus.AWAITING_CONFIRMATION) {
            throw new IllegalStateException("仅支持待确认任务");
        }
        Path source = Path.of(task.getSourcePath());
        if (!Files.exists(source)) throw new IllegalStateException(SOURCE_MISSING_ERROR_MESSAGE);
        var suggestion = codexRecognitionService.recognize(source, loadRule(task), toParseResult(task), true)
                .orElseThrow(() -> new IllegalStateException("Codex 未能确定作品身份，请补充正式片名或手动选择作品"));
        ParseResult parsed = suggestion.parsed();
        List<MatchResult> matches = metadataMatcher.search(parsed);
        if (matches.isEmpty()) throw new IllegalStateException("Codex 建议未通过 TMDB 校验，请手动选择作品");
        QueueRecognitionResponse response = applyCodexSuggestion(taskId, suggestion, matches);
        reviewAutomaticOrganization(List.of(new AutomaticReview(response.task(), response.candidates(), suggestion)), true);
        return response;
    }

    /** 整目录先回填全部解析，再检查冲突，避免先移动其中一个重复副本。 */
    public QueueDirectoryRecognitionResponse recognizeDirectoryWithCodex(Long taskId) {
        MediaTask anchor = taskRepository.findById(taskId).orElseThrow(() -> new IllegalArgumentException("任务不存在"));
        if (anchor.getStatus() != MediaTask.TaskStatus.AWAITING_CONFIRMATION
                || (anchor.getAssetType() != null && anchor.getAssetType() != MediaAssetType.VIDEO_FILE)) {
            throw new IllegalStateException("仅支持待确认的普通视频文件");
        }
        WatchRule rule = loadRule(anchor);
        Path source = Path.of(anchor.getSourcePath()).toAbsolutePath().normalize();
        if (!Files.isRegularFile(source)) throw new IllegalStateException(SOURCE_MISSING_ERROR_MESSAGE);
        Path parent = source.getParent();
        List<MediaTask> tasks = taskRepository.findByRuleIdAndStatusIn(anchor.getRuleId(),
                        List.of(MediaTask.TaskStatus.AWAITING_CONFIRMATION)).stream()
                .filter(t -> t.getAssetType() == null || t.getAssetType() == MediaAssetType.VIDEO_FILE)
                .filter(t -> parent.equals(Path.of(t.getSourcePath()).toAbsolutePath().normalize().getParent()))
                .sorted(Comparator.comparing(MediaTask::getSourcePath)).toList();
        if (tasks.size() > 80) throw new IllegalStateException("同目录待确认任务超过 80 个，请拆分目录后识别");
        Map<String, ParseResult> originals = new LinkedHashMap<>();
        List<QueueDirectoryRecognitionResponse.SkippedTask> skipped = new ArrayList<>();
        for (MediaTask task : tasks) {
            Path path = Path.of(task.getSourcePath());
            if (!Files.isRegularFile(path)) {
                skipped.add(new QueueDirectoryRecognitionResponse.SkippedTask(task.getId(), SOURCE_MISSING_ERROR_MESSAGE));
            } else {
                if (originals.put(path.getFileName().toString(), toParseResult(task)) != null) {
                    throw new IllegalStateException("目录存在重复任务，请先刷新队列");
                }
            }
        }
        Map<String, CodexRecognitionService.Suggestion> suggestions = codexRecognitionService.recognizeDirectory(source, rule, originals);
        ParseResult first = suggestions.values().iterator().next().parsed();
        ParseResult identity = new ParseResult();
        identity.setTitle(first.getTitle());
        identity.setOriginalFilename(first.getTitle());
        identity.setYear(first.getYear());
        identity.setType(first.getType());
        List<MatchResult> matches = metadataMatcher.search(identity);
        if (matches.isEmpty()) throw new IllegalStateException("Codex 目录建议未通过 TMDB 校验，已保留原识别信息");
        List<QueueRecognitionResponse> updated = new ArrayList<>();
        List<AutomaticReview> reviews = new ArrayList<>();
        for (MediaTask task : tasks) {
            var suggestion = suggestions.get(Path.of(task.getSourcePath()).getFileName().toString());
            if (suggestion == null) continue;
            try {
                QueueRecognitionResponse response = applyCodexSuggestion(task.getId(), suggestion, matches);
                updated.add(response);
                reviews.add(new AutomaticReview(response.task(), response.candidates(), suggestion));
            } catch (Exception e) {
                skipped.add(new QueueDirectoryRecognitionResponse.SkippedTask(task.getId(), "更新 " + Path.of(task.getSourcePath()).getFileName()
                        + " 失败：" + e.getMessage() + "。请刷新后重试"));
                log.warn("目录识别更新失败：taskId={}, error={}", task.getId(), e.getClass().getSimpleName());
            }
        }
        reviewAutomaticOrganization(reviews, true);
        return new QueueDirectoryRecognitionResponse(parent.toString(), updated, skipped);
    }

    private QueueRecognitionResponse applyCodexSuggestion(Long taskId, CodexRecognitionService.Suggestion suggestion,
                                                           List<MatchResult> matches) {
        // 网络请求期间可能有人确认任务，再次检查状态，避免覆盖新状态。
        MediaTask task = taskRepository.findById(taskId).orElseThrow();
        if (task.getStatus() != MediaTask.TaskStatus.AWAITING_CONFIRMATION) {
            throw new IllegalStateException("任务状态已变化，请刷新列表");
        }
        if (!Files.exists(Path.of(task.getSourcePath()))) throw new IllegalStateException(SOURCE_MISSING_ERROR_MESSAGE);
        ParseResult parsed = suggestion.parsed();
        task.setMediaType("episode".equals(parsed.getType()) ? MediaTask.MediaType.TV_SHOW : MediaTask.MediaType.MOVIE);
        fillParsedFields(task, parsed);
        if (task.getMediaType() == MediaTask.MediaType.TV_SHOW) {
            task.setParsedSeason(EpisodeSeasonResolver.resolve(task.getParsedSeason(), null, Path.of(task.getSourcePath())));
        }
        List<TaskCandidate> candidates = saveCandidates(task, matches);
        task.setMatchConfidence(candidates.isEmpty() ? null : candidates.getFirst().getConfidence());
        task.setErrorMessage("Codex 已更新识别，正在校验作品、季集与目标路径。" + suggestion.reason());
        taskRepository.save(task);
        return new QueueRecognitionResponse(task, candidates);
    }

    private record AutomaticReview(MediaTask task, List<TaskCandidate> candidates,
                                   CodexRecognitionService.Suggestion suggestion) {}

    private record AutomaticPlan(AutomaticReview review, TaskCandidate candidate, MatchResult match, Path target) {}

    /** 统一处理新发现与重新识别；先审查整批计划，再提交文件操作。 */
    private synchronized void reviewAutomaticOrganization(List<AutomaticReview> reviews, boolean background) {
        List<AutomaticPlan> plans = new ArrayList<>();
        Map<Long, String> blockers = new LinkedHashMap<>();
        Map<Long, Path> targets = new LinkedHashMap<>();
        Map<Long, List<Integer>> sourceSeasons = new LinkedHashMap<>();
        for (AutomaticReview review : reviews) {
            MediaTask task = review.task();
            try {
                if (review.candidates().isEmpty()) throw new EpisodeMetadataException("没有 TMDB 作品候选，请手动搜索作品或重新识别。");
                TaskCandidate candidate = review.candidates().getFirst();
                if (candidate.getMediaType() != task.getMediaType()) {
                    throw new EpisodeMetadataException("作品候选类型与识别类型不一致，请手动选择作品。");
                }
                double threshold = getConfidenceThreshold();
                if (candidate.getConfidence() == null || !Double.isFinite(candidate.getConfidence())
                        || candidate.getConfidence() < threshold) {
                    throw new EpisodeMetadataException("作品匹配置信度不足（当前 "
                            + (candidate.getConfidence() == null ? "未知" : "%.0f%%".formatted(candidate.getConfidence() * 100))
                            + "，要求 %.0f%%）。请核对作品或重新识别。".formatted(threshold * 100));
                }
                if (review.suggestion() != null && codexRecognitionService.requiresConfirmation(review.suggestion().confidence())) {
                    throw new EpisodeMetadataException("Codex 识别置信度 %.0f%%，低于自动整理要求 90%%。请核对作品及季集。"
                            .formatted(review.suggestion().confidence() * 100));
                }
                ensureSourceFileExists(task);
                ensureEpisodeCoordinates(task, candidate.getMediaType());
                Integer sourceSeason = task.getParsedSeason();
                task.setMediaType(candidate.getMediaType());
                MatchResult match = loadReviewedMatch(task, candidate, true);
                if (task.getMediaType() == MediaTask.MediaType.TV_SHOW && task.getMetadataWarning() != null) {
                    sourceSeasons.put(task.getId(), List.of(sourceSeason,
                            EpisodeSeasonResolver.resolve(null, null, Path.of(task.getSourcePath()))));
                }
                applyMatchToTask(task, match);
                Path target = Objects.requireNonNull(assetOrganizerService.previewTarget(task), "无法生成目标路径")
                        .toAbsolutePath().normalize();
                if (target.toString().matches(".*\\{[a-z_][a-z0-9_]*(?::[^}]*)?}.*")) {
                    throw new EpisodeMetadataException("目标路径含有未填充的模板变量：" + target + "。请补齐元数据或修改路径模板。");
                }
                targets.put(task.getId(), target);
                plans.add(new AutomaticPlan(review, candidate, match, target));
            } catch (Exception e) {
                if (task.getStatus() != MediaTask.TaskStatus.FAILED) blockers.put(task.getId(), e.getMessage());
                log.info("自动整理保留复核：taskId={}, reason={}", task.getId(), e.getMessage());
            }
        }
        Map<Long, String> conflicts = automaticOrganizationGuard.conflicts(
                reviews.stream().map(AutomaticReview::task).toList(), targets, sourceSeasons);
        conflicts.forEach((id, reason) -> blockers.merge(id, reason, (a, b) -> a + "\n" + b));
        for (AutomaticPlan plan : plans) {
            Long owner = automaticTargets.get(plan.target());
            if (owner != null) blockers.put(plan.review().task().getId(), "目标路径正在由任务 " + owner
                    + " 整理：" + plan.target() + "。请等待完成后检查目标文件。");
        }
        for (AutomaticReview review : reviews) {
            String blocker = blockers.get(review.task().getId());
            if (blocker != null && review.task().getStatus() != MediaTask.TaskStatus.FAILED) {
                String evidence = review.suggestion() == null ? "" : "\n识别依据：" + review.suggestion().reason();
                moveToAwaitingConfirmation(review.task(), blocker + evidence);
            }
        }
        for (AutomaticPlan plan : plans) {
            MediaTask task = plan.review().task();
            if (blockers.containsKey(task.getId()) || task.getStatus() == MediaTask.TaskStatus.FAILED) continue;
            plan.candidate().setSelected(true);
            candidateRepository.save(plan.candidate());
            task.setConfirmationSource(MediaTask.ConfirmationSource.AUTO_MATCH);
            task.setStatus(MediaTask.TaskStatus.PROCESSING);
            task.setErrorMessage(null);
            taskRepository.save(task);
            eventPublisher.publishTaskProcessing(task);
            automaticTargets.put(plan.target(), task.getId());
            Runnable organize = () -> {
                try {
                    continueAfterMetadataConfirmed(task, plan.match());
                } finally {
                    synchronized (MediaProcessPipeline.this) {
                        automaticTargets.remove(plan.target(), task.getId());
                    }
                }
            };
            if (background) manualConfirmationExecutor.submit(organize);
            else organize.run();
        }
    }

    private MediaTask updateRecognitionFields(Long taskId, QueueRecognitionRequest request) {
        MediaTask task = taskRepository.findById(taskId)
                .orElseThrow(() -> new IllegalArgumentException("Task not found: " + taskId));

        if (!MediaTask.TaskStatus.AWAITING_CONFIRMATION.equals(task.getStatus())) {
            throw new IllegalStateException("Only awaiting confirmation tasks can be edited: " + taskId);
        }

        if (request == null) {
            throw new IllegalArgumentException("Recognition request is required");
        }

        String parsedTitle = request.getParsedTitle() == null ? "" : request.getParsedTitle().trim();
        if (parsedTitle.isBlank()) {
            throw new IllegalArgumentException("Parsed title is required");
        }

        MediaTask.MediaType mediaType = parseRecognitionMediaType(request.getMediaType());
        task.setMediaType(mediaType);
        task.setMetadataWarning(null);
        task.setParsedTitle(parsedTitle);
        task.setParsedYear(request.getParsedYear());
        if (MediaTask.MediaType.TV_SHOW.equals(mediaType)) {
            if (request.getParsedSeason() == null || request.getParsedEpisode() == null) {
                throw new IllegalArgumentException("Season and episode are required for TV show tasks");
            }
            task.setParsedSeason(request.getParsedSeason());
            task.setParsedEpisode(request.getParsedEpisode());
            task.setParsedEpisodeEnd(normalizeParsedEpisodeEnd(request.getParsedEpisode(), request.getParsedEpisodeEnd()));
        } else {
            task.setParsedSeason(null);
            task.setParsedEpisode(null);
            task.setParsedEpisodeEnd(null);
        }
        return taskRepository.save(task);
    }

    private Integer normalizeParsedEpisodeEnd(Integer episodeStart, Integer episodeEnd) {
        if (episodeStart == null || episodeEnd == null || episodeEnd.equals(episodeStart)) {
            return null;
        }
        if (episodeEnd < episodeStart) {
            throw new IllegalArgumentException("Episode range end must be greater than the start episode");
        }
        return episodeEnd;
    }

    private MediaTask.MediaType parseRecognitionMediaType(String mediaType) {
        if (mediaType == null || mediaType.isBlank()) {
            throw new IllegalArgumentException("Media type is required");
        }
        try {
            return MediaTask.MediaType.valueOf(mediaType.trim());
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("Unsupported media type: " + mediaType, e);
        }
    }

    private ParseResult toParseResult(MediaTask task) {
        ParseResult parseResult = new ParseResult();
        parseResult.setTitle(task.getParsedTitle());
        parseResult.setYear(task.getParsedYear());
        parseResult.setSeason(task.getParsedSeason());
        parseResult.setEpisode(task.getParsedEpisode());
        parseResult.setEpisodeEnd(task.getParsedEpisodeEnd());
        parseResult.setScreenSize(task.getParsedResolution());
        parseResult.setVideoCodec(task.getParsedCodec());
        parseResult.setReleaseGroup(task.getParsedReleaseGroup());
        applyMediaTypeToParseResult(parseResult, task.getMediaType());
        return parseResult;
    }

    @SuppressWarnings("null")
    private void completeSubmittedConfirm(
            Long taskId,
            Long tmdbId,
            String mediaType,
            MediaTask.ConfirmationSource confirmationSource
    ) {
        try {
            MediaTask task = taskRepository.findById(taskId)
                    .orElseThrow(() -> new IllegalArgumentException("Task not found: " + taskId));
            ensureSourceFileExists(task);
            MediaTask.MediaType confirmedType = MediaTask.MediaType.valueOf(mediaType);
            ensureEpisodeCoordinates(task, confirmedType);
            TaskCandidate selectedCandidate = candidateRepository
                    .findByTask_IdAndTmdbIdAndMediaType(taskId, tmdbId, confirmedType)
                    .orElseGet(() -> createManualCandidate(task, tmdbId, confirmedType));

            MatchResult match = enrichSelectedMatch(task, selectedCandidate);
            markCandidateSelected(taskId, selectedCandidate);
            applyMatchToTask(task, match);
            task.setConfirmationSource(confirmationSource);
            taskRepository.save(task);
            continueAfterMetadataConfirmed(task, match);
        } catch (EpisodeMetadataException e) {
            taskRepository.findById(taskId).ifPresent(task -> moveToAwaitingConfirmation(task, e.getMessage()));
        } catch (Exception e) {
            log.error("Submitted manual confirmation failed: taskId={}", taskId, e);
            taskRepository.findById(taskId).ifPresent(task -> recordFailure(task, e));
        }
    }

    /** 确认前补齐未标注的季号并校验集号，防止模板输出未替换的季集占位符。 */
    private void ensureEpisodeCoordinates(MediaTask task, MediaTask.MediaType type) {
        if (type != MediaTask.MediaType.TV_SHOW) return;
        if (task.getParsedEpisode() == null || task.getParsedEpisode() < 1
                || (task.getParsedSeason() != null && task.getParsedSeason() < 0)
                || (task.getParsedEpisodeEnd() != null && task.getParsedEpisodeEnd() < task.getParsedEpisode())) {
            throw new IllegalStateException("剧集任务必须填写有效季号和集号，请先编辑识别信息");
        }
        if (task.getParsedSeason() == null) {
            task.setParsedSeason(EpisodeSeasonResolver.resolve(null, null, Path.of(task.getSourcePath())));
        }
    }

    private void ensureSourceFileExists(MediaTask task) {
        Path sourcePath = Paths.get(task.getSourcePath()).toAbsolutePath().normalize();
        if (Files.exists(sourcePath)) {
            return;
        }

        failTaskBecauseSourceMissing(task);
        throw new IllegalStateException(SOURCE_MISSING_ERROR_MESSAGE);
    }

    private void failTaskBecauseSourceMissing(MediaTask task) {
        recordFailure(
                task,
                new MediaTaskFailureException(
                        MediaTask.TaskErrorCode.SOURCE_MISSING,
                        SOURCE_MISSING_ERROR_MESSAGE
                )
        );
        log.info("Task failed because source file is missing: taskId={}, sourcePath={}",
                task.getId(), task.getSourcePath());
    }

    void recordFailure(MediaTask task, Exception error) {
        MediaTask.TaskErrorCode errorCode = resolveErrorCode(error);
        String errorMessage = resolveErrorMessage(error);
        LocalDateTime now = LocalDateTime.now();

        Optional<MediaTask> existingFailure = taskRepository
                .findFirstBySourcePathAndRuleIdAndStatusAndErrorCodeOrderByUpdatedAtDesc(
                        task.getSourcePath(),
                        task.getRuleId(),
                        MediaTask.TaskStatus.FAILED,
                        errorCode
                );

        if (existingFailure.isPresent() && !Objects.equals(existingFailure.get().getId(), task.getId())) {
            MediaTask existing = existingFailure.get();
            existing.setFailureCount(nextFailureCount(existing.getFailureCount()));
            existing.setLastFailedAt(now);
            existing.setErrorCode(errorCode);
            existing.setErrorMessage(errorMessage);
            taskRepository.save(existing);

            if (task.getId() != null) {
                candidateRepository.deleteAll(candidateRepository.findByTask_IdOrderByRankAsc(task.getId()));
                taskRepository.delete(task);
            }

            eventPublisher.publishTaskFailed(existing);
            log.info("Repeated failure merged: sourcePath={}, errorCode={}, existingTaskId={}, failureCount={}",
                    existing.getSourcePath(), errorCode, existing.getId(), existing.getFailureCount());
            return;
        }

        task.setStatus(MediaTask.TaskStatus.FAILED);
        task.setErrorCode(errorCode);
        task.setFailureCount(firstFailureCount(task.getFailureCount()));
        task.setLastFailedAt(now);
        task.setErrorMessage(errorMessage);
        taskRepository.save(task);
        eventPublisher.publishTaskFailed(task);
        emailNotificationService.notifyTaskFailed(task);
    }

    private MediaTask.TaskErrorCode resolveErrorCode(Exception error) {
        if (error instanceof MediaTaskFailureException failureException) {
            return failureException.getErrorCode();
        }
        return MediaTask.TaskErrorCode.PIPELINE_FAILED;
    }

    private String resolveErrorMessage(Exception error) {
        String message = error.getMessage();
        return message == null || message.isBlank() ? "任务处理失败" : message;
    }

    private int firstFailureCount(Integer current) {
        return current == null || current < 1 ? 1 : current;
    }

    private int nextFailureCount(Integer current) {
        return current == null || current < 1 ? 2 : current + 1;
    }

    private void fillParsedFields(MediaTask task, ParseResult parseResult) {
        task.setParsedTitle(parseResult.getTitle());
        task.setParsedYear(parseResult.getYear());
        task.setParsedSeason(parseResult.getSeason());
        task.setParsedEpisode(parseResult.getEpisode());
        task.setParsedEpisodeEnd(parseResult.getEpisodeEnd());
        task.setParsedResolution(parseResult.getScreenSize());
        task.setParsedCodec(parseResult.getVideoCodec());
        task.setParsedReleaseGroup(parseResult.getReleaseGroup());
        taskRepository.save(task);
    }

    private Optional<MediaTask.MediaType> resolveMediaType(
            WatchRule rule,
            ParseResult parseResult,
            MediaAssetType assetType
    ) {
        if (MediaAssetType.BLURAY_DIRECTORY.equals(assetType)) {
            if (WatchRule.RuleMediaType.TV_SHOW.equals(rule.getMediaType())) {
                throw new IllegalStateException("当前版本暂不支持剧集蓝光原盘");
            }
            return Optional.of(MediaTask.MediaType.MOVIE);
        }

        if (WatchRule.RuleMediaType.MOVIE.equals(rule.getMediaType())) {
            return Optional.of(MediaTask.MediaType.MOVIE);
        }
        if (WatchRule.RuleMediaType.TV_SHOW.equals(rule.getMediaType())) {
            return Optional.of(MediaTask.MediaType.TV_SHOW);
        }

        if ("movie".equalsIgnoreCase(parseResult.getType())) {
            return Optional.of(MediaTask.MediaType.MOVIE);
        }
        if ("episode".equalsIgnoreCase(parseResult.getType())
                || parseResult.getSeason() != null
                || parseResult.getEpisode() != null) {
            return Optional.of(MediaTask.MediaType.TV_SHOW);
        }
        return Optional.empty();
    }

    private void applyMediaTypeToParseResult(ParseResult parseResult, MediaTask.MediaType mediaType) {
        parseResult.setType(MediaTask.MediaType.TV_SHOW.equals(mediaType) ? "episode" : "movie");
    }

    private List<TaskCandidate> saveCandidates(MediaTask task, List<MatchResult> matches) {
        // Re-running a task should replace its candidate snapshot rather than append duplicates.
        candidateRepository.deleteAll(Objects.requireNonNull(candidateRepository.findByTask_IdOrderByRankAsc(task.getId())));

        List<MatchResult> sorted = matches.stream()
                .sorted(Comparator.comparing(
                        MatchResult::getConfidence,
                        Comparator.nullsLast(Comparator.reverseOrder())
                ))
                .toList();

        int rank = 1;
        for (MatchResult match : sorted) {
            TaskCandidate candidate = new TaskCandidate();
            candidate.setTask(task);
            candidate.setTmdbId(Long.valueOf(match.getSourceId()));
            candidate.setTitle(match.getTitle());
            candidate.setOriginalTitle(match.getOriginalTitle());
            candidate.setYear(match.getYear());
            candidate.setMediaType(MediaTask.MediaType.valueOf(match.getMediaType()));
            candidate.setConfidence(match.getConfidence());
            candidate.setPosterUrl(match.getPosterUrl());
            candidate.setOverview(match.getOverview());
            candidate.setGenre1(genreAt(match, 0));
            candidate.setGenre2(genreAt(match, 1));
            candidate.setGenre3(genreAt(match, 2));
            candidate.setGenre4(genreAt(match, 3));
            candidate.setCountry(match.getCountry());
            candidate.setEpisodeTitle(match.getEpisodeTitle());
            candidate.setRank(rank++);
            candidate.setSelected(false);
            candidateRepository.save(candidate);
        }

        return candidateRepository.findByTask_IdOrderByRankAsc(task.getId());
    }

    private void moveToAwaitingConfirmation(MediaTask task, String reason) {
        log.info("Task awaiting confirmation: taskId={}, reason={}", task.getId(), reason);
        task.setStatus(MediaTask.TaskStatus.AWAITING_CONFIRMATION);
        task.setErrorMessage(reason);
        taskRepository.save(task);
        eventPublisher.publishAwaitingConfirmation(task);
        emailNotificationService.notifyAwaitingConfirmation(task);
    }

    private double getConfidenceThreshold() {
        String value = settingsService.get("watcher.confidence-threshold", "0.8");
        try {
            return Double.parseDouble(value);
        } catch (NumberFormatException e) {
            log.warn("Invalid watcher.confidence-threshold='{}', fallback to 0.8", value);
            return 0.8;
        }
    }

    private void applyMatchToTask(MediaTask task, MatchResult match) {
        task.setTmdbId(Long.valueOf(match.getSourceId()));
        task.setMediaType(MediaTask.MediaType.valueOf(match.getMediaType()));
        task.setConfirmedTitle(match.getTitle());
        task.setConfirmedOriginalTitle(match.getOriginalTitle());
        task.setConfirmedYear(match.getYear());
        task.setConfirmedGenre1(genreAt(match, 0));
        task.setConfirmedGenre2(genreAt(match, 1));
        task.setConfirmedGenre3(genreAt(match, 2));
        task.setConfirmedGenre4(genreAt(match, 3));
        task.setConfirmedCountry(match.getCountry());
        task.setConfirmedEpisodeTitle(match.getEpisodeTitle());
        task.setMatchConfidence(match.getConfidence());
        taskRepository.save(task);
    }

    private void continueAfterMetadataConfirmed(MediaTask task, MatchResult match) {
        try {
            task.setStatus(MediaTask.TaskStatus.PROCESSING);
            taskRepository.save(task);
            eventPublisher.publishTaskProcessing(task);

            WatchRule rule = loadRule(task);
            Path sourceFile = Paths.get(task.getSourcePath()).toAbsolutePath().normalize();
            Path sourceParent = sourceFile.getParent();
            Path target = assetOrganizerService.organize(task);
            task.setTargetPath(target.toString());
            taskRepository.save(task);

            moveAssociatedFiles(task, rule, target);

            task.setStatus(MediaTask.TaskStatus.DONE);
            task.setErrorMessage(null);
            task.setErrorCode(null);
            task.setFailureCount(0);
            task.setLastFailedAt(null);
            taskRepository.save(task);
            eventPublisher.publishTaskDone(task);
            cleanupEmptySourceDirs(rule, sourceParent);
            log.info("Pipeline completed: taskId={}, target={}", task.getId(), target);
        } catch (Exception e) {
            log.error("Pipeline finalization failed: taskId={}", task.getId(), e);
            if (task.getConfirmationSource() == MediaTask.ConfirmationSource.AUTO_MATCH
                    && e instanceof MediaTaskFailureException failure
                    && (failure.getErrorCode() == MediaTask.TaskErrorCode.TARGET_CONFLICT
                    || failure.getErrorCode() == MediaTask.TaskErrorCode.UNSAFE_TARGET_PATH)) {
                moveToAwaitingConfirmation(task, e.getMessage() + "。请检查目标路径后重试。");
            } else {
                recordFailure(task, e);
            }
        }
    }

    private WatchRule loadRule(MediaTask task) {
        Long ruleId = Objects.requireNonNull(task.getRuleId(), "MediaTask.ruleId is required");
        return watchRuleRepository.findById(ruleId)
                .orElseThrow(() -> new IllegalArgumentException("WatchRule not found: " + ruleId));
    }

    private void moveAssociatedFiles(MediaTask task, WatchRule rule, Path targetFile) {
        if (MediaAssetType.BLURAY_DIRECTORY.equals(task.getAssetType())) {
            return;
        }
        if (!Boolean.TRUE.equals(rule.getMoveAssociatedFiles())) {
            return;
        }

        Path sourceFile = Paths.get(task.getSourcePath()).toAbsolutePath().normalize();
        Path sourceDir = sourceFile.getParent();
        Path targetDir = targetFile.getParent();
        if (sourceDir == null || targetDir == null || !Files.isDirectory(sourceDir)) {
            return;
        }

        String sourceBase = basename(sourceFile.getFileName().toString());
        String targetBase = basename(targetFile.getFileName().toString());

        try (var stream = Files.list(sourceDir)) {
            for (Path associated : stream.filter(Files::isRegularFile).toList()) {
                String filename = associated.getFileName().toString();
                String lower = filename.toLowerCase();
                Path destination = null;

                if (isSameBaseAssociated(filename, sourceBase)) {
                    String suffix = filename.substring(sourceBase.length());
                    destination = targetDir.resolve(targetBase + suffix);
                } else if (isGenericCover(lower)) {
                    destination = targetDir.resolve(filename);
                }

                if (destination != null) {
                    operateAssociatedFile(rule, associated, destination);
                }
            }
        } catch (IOException e) {
            log.warn("Failed to inspect associated files: taskId={}, sourceDir={}, error={}",
                    task.getId(), sourceDir, e.getMessage());
        }

    }

    private void operateAssociatedFile(WatchRule rule, Path source, Path destination) {
        try {
            if (Files.exists(destination)) {
                log.warn("Associated file target already exists, skipping: source={}, target={}", source, destination);
                return;
            }
            FileOperationStrategy strategy = resolveStrategy(rule.getOperation());
            strategy.execute(source, destination);
            log.info("Associated file processed: operation={}, source={} -> target={}",
                    rule.getOperation(), source, destination);
        } catch (IOException e) {
            log.warn("Failed to process associated file: operation={}, source={}, target={}, error={}",
                    rule.getOperation(), source, destination, e.getMessage());
        }
    }

    private FileOperationStrategy resolveStrategy(FileOperationStrategy.OperationType operation) {
        return fileOperationStrategies.values().stream()
                .filter(strategy -> strategy.getType() == operation)
                .findFirst()
                .orElseThrow(() -> new IllegalArgumentException("Unknown file operation strategy: " + operation));
    }

    private void cleanupEmptySourceDirs(WatchRule rule, Path startDir) {
        if (!Boolean.TRUE.equals(rule.getCleanupEmptyDirs())
                || !com.mediamarshal.service.rename.FileOperationStrategy.OperationType.MOVE.equals(rule.getOperation())
                || startDir == null) {
            return;
        }

        Path sourceRoot = Paths.get(rule.getSourceDir()).toAbsolutePath().normalize();
        Path current = startDir.toAbsolutePath().normalize();
        while (current.startsWith(sourceRoot) && !current.equals(sourceRoot)) {
            try (var stream = Files.list(current)) {
                if (stream.findAny().isPresent()) {
                    return;
                }
            } catch (IOException e) {
                log.warn("Failed to inspect empty source directory: dir={}, error={}", current, e.getMessage());
                return;
            }

            try {
                Files.delete(current);
                log.info("Empty source directory deleted: {}", current);
            } catch (IOException e) {
                log.warn("Failed to delete empty source directory: dir={}, error={}", current, e.getMessage());
                return;
            }
            current = current.getParent();
            if (current == null) {
                return;
            }
        }
    }

    private boolean isSameBaseAssociated(String filename, String sourceBase) {
        String lower = filename.toLowerCase();
        return filename.startsWith(sourceBase + ".")
                && (lower.endsWith(".srt")
                || lower.endsWith(".ass")
                || lower.endsWith(".ssa")
                || lower.endsWith(".sub")
                || lower.endsWith(".idx")
                || lower.endsWith(".nfo")
                || lower.endsWith(".jpg")
                || lower.endsWith(".jpeg")
                || lower.endsWith(".png")
                || lower.endsWith(".webp")
                || lower.endsWith(".md5"));
    }

    private boolean isGenericCover(String lowerFilename) {
        return lowerFilename.equals("poster.jpg")
                || lowerFilename.equals("folder.jpg")
                || lowerFilename.equals("cover.jpg");
    }

    private String basename(String filename) {
        int dot = filename.lastIndexOf('.');
        return dot > 0 ? filename.substring(0, dot) : filename;
    }

    private TaskCandidate createManualCandidate(MediaTask task, Long tmdbId, MediaTask.MediaType mediaType) {
        MatchResult match = getByIdWithRetry(tmdbId, mediaType);
        int nextRank = candidateRepository.findByTask_IdOrderByRankAsc(task.getId()).size() + 1;

        TaskCandidate candidate = new TaskCandidate();
        candidate.setTask(task);
        candidate.setTmdbId(tmdbId);
        applyMatchSnapshotToCandidate(candidate, match, mediaType, match.getConfidence());
        candidate.setRank(nextRank);
        candidate.setSelected(true);
        return candidateRepository.save(candidate);
    }

    private MatchResult enrichSelectedMatch(MediaTask task, TaskCandidate selectedCandidate) {
        MediaTask.MediaType mediaType = selectedCandidate.getMediaType();
        task.setMediaType(mediaType);
        MatchResult detail = loadReviewedMatch(task, selectedCandidate);
        applyMatchSnapshotToCandidate(selectedCandidate, detail, mediaType, selectedCandidate.getConfidence());
        selectedCandidate.setSelected(true);
        candidateRepository.save(selectedCandidate);
        return detail;
    }

    private MatchResult loadReviewedMatch(MediaTask task, TaskCandidate candidate) {
        return loadReviewedMatch(task, candidate, false);
    }

    private MatchResult loadReviewedMatch(MediaTask task, TaskCandidate candidate, boolean acceptValidatedSeasonMapping) {
        MatchResult detail;
        try {
            detail = getByIdWithRetry(candidate.getTmdbId(), candidate.getMediaType());
        } catch (RuntimeException e) {
            if (candidate.getMediaType() == MediaTask.MediaType.TV_SHOW) {
                throw new EpisodeMetadataException("TMDB 剧集详情获取失败：" + e.getMessage()
                        + "；季集号未经校验，已暂停文件整理，请重试");
            }
            throw e;
        }
        detail.setConfidence(candidate.getConfidence());
        if (tmdbEpisodeService.reconcile(task, detail)) {
            taskRepository.save(task);
            if (!acceptValidatedSeasonMapping) {
                throw new EpisodeMetadataException(task.getMetadataWarning() + "请核对后确认。");
            }
        }
        return detail;
    }

    private void applyMatchSnapshotToCandidate(
            TaskCandidate candidate,
            MatchResult match,
            MediaTask.MediaType mediaType,
            Double confidence
    ) {
        candidate.setTitle(match.getTitle());
        candidate.setOriginalTitle(match.getOriginalTitle());
        candidate.setYear(match.getYear());
        candidate.setMediaType(mediaType);
        candidate.setConfidence(confidence);
        candidate.setPosterUrl(match.getPosterUrl());
        candidate.setOverview(match.getOverview());
        candidate.setGenre1(genreAt(match, 0));
        candidate.setGenre2(genreAt(match, 1));
        candidate.setGenre3(genreAt(match, 2));
        candidate.setGenre4(genreAt(match, 3));
        candidate.setCountry(match.getCountry());
        candidate.setEpisodeTitle(match.getEpisodeTitle());
    }

    private MatchResult getByIdWithRetry(Long tmdbId, MediaTask.MediaType mediaType) {
        int attempts = getConfirmMetadataRetryAttempts();
        RuntimeException lastError = null;
        for (int attempt = 1; attempt <= attempts; attempt++) {
            try {
                return metadataMatcher.getById(String.valueOf(tmdbId), mediaType.name());
            } catch (RuntimeException e) {
                lastError = e;
                if (attempt >= attempts) {
                    break;
                }
                log.warn("TMDB detail lookup failed, will retry: tmdbId={}, mediaType={}, attempt={}/{}, error={}",
                        tmdbId, mediaType, attempt, attempts, e.getMessage());
                sleepBeforeRetry(attempt);
            }
        }
        throw lastError != null ? lastError : new IllegalStateException("TMDB detail lookup failed: " + tmdbId);
    }

    private int getConfirmMetadataRetryAttempts() {
        String value = settingsService.get("tmdb.confirm-retry-attempts", "3");
        try {
            return Math.max(Integer.parseInt(value), 1);
        } catch (NumberFormatException e) {
            log.warn("Invalid tmdb.confirm-retry-attempts='{}', fallback to 3", value);
            return 3;
        }
    }

    private void sleepBeforeRetry(int attempt) {
        try {
            TimeUnit.MILLISECONDS.sleep(300L * attempt);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException("Interrupted while waiting to retry TMDB detail lookup", e);
        }
    }

    @SuppressWarnings("null")
    private void markCandidateSelected(Long taskId, TaskCandidate selectedCandidate) {
        List<TaskCandidate> candidates = candidateRepository.findByTask_IdOrderByRankAsc(taskId);
        for (TaskCandidate candidate : candidates) {
            candidate.setSelected(candidate.getId().equals(selectedCandidate.getId()));
        }
        candidateRepository.saveAll(candidates);
    }

    private String genreAt(MatchResult match, int index) {
        List<String> genres = match.getGenres();
        if (genres == null || genres.size() <= index) {
            return null;
        }
        String value = genres.get(index);
        return value == null || value.isBlank() ? null : value;
    }

    private List<String> genresFromCandidate(TaskCandidate candidate) {
        List<String> genres = new ArrayList<>();
        addGenre(genres, candidate.getGenre1());
        addGenre(genres, candidate.getGenre2());
        addGenre(genres, candidate.getGenre3());
        addGenre(genres, candidate.getGenre4());
        return genres;
    }

    private void addGenre(List<String> genres, String value) {
        if (value != null && !value.isBlank()) {
            genres.add(value);
        }
    }

    private MatchResult toMatchResult(TaskCandidate candidate) {
        MatchResult result = new MatchResult();
        result.setSource("tmdb");
        result.setSourceId(String.valueOf(candidate.getTmdbId()));
        result.setTitle(candidate.getTitle());
        result.setOriginalTitle(candidate.getOriginalTitle());
        result.setYear(candidate.getYear());
        result.setMediaType(candidate.getMediaType().name());
        result.setOverview(candidate.getOverview());
        result.setPosterUrl(candidate.getPosterUrl());
        result.setGenres(genresFromCandidate(candidate));
        result.setCountry(candidate.getCountry());
        result.setEpisodeTitle(candidate.getEpisodeTitle());
        result.setConfidence(candidate.getConfidence());
        return result;
    }
}
