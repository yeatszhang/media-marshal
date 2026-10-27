package com.mediamarshal.service.pipeline;

import com.mediamarshal.model.dto.MatchResult;
import com.mediamarshal.model.dto.ParseResult;
import com.mediamarshal.model.dto.QueueRecognitionRequest;
import com.mediamarshal.model.dto.QueueRecognitionResponse;
import com.mediamarshal.model.entity.MediaTask;
import com.mediamarshal.model.entity.TaskCandidate;
import com.mediamarshal.model.entity.WatchRule;
import com.mediamarshal.model.exception.MediaTaskFailureException;
import com.mediamarshal.repository.MediaTaskRepository;
import com.mediamarshal.repository.TaskCandidateRepository;
import com.mediamarshal.notification.EmailNotificationService;
import com.mediamarshal.repository.WatchRuleRepository;
import com.mediamarshal.service.matcher.MetadataMatcher;
import com.mediamarshal.service.matcher.TmdbEpisodeService;
import com.mediamarshal.model.dto.TmdbSeason;
import com.mediamarshal.model.dto.TmdbEpisode;
import com.mediamarshal.service.matcher.ParentFolderMatchEnhancer;
import com.mediamarshal.service.parser.GuessitParserClient;
import com.mediamarshal.service.discovery.asset.VideoFileAssetDetector;
import com.mediamarshal.service.parser.CodexRecognitionService;
import com.mediamarshal.service.rename.AssetOrganizerService;
import com.mediamarshal.service.rename.FileOperationStrategy;
import com.mediamarshal.service.rename.RenameService;
import com.mediamarshal.service.settings.SettingsService;
import com.mediamarshal.websocket.EventPublisher;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.mockito.ArgumentCaptor;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import org.junit.jupiter.api.io.TempDir;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class MediaProcessPipelineRecognitionTest {

    private MediaTaskRepository taskRepository;
    private TaskCandidateRepository candidateRepository;
    private MetadataMatcher metadataMatcher;
    private EventPublisher eventPublisher;
    private EmailNotificationService emailNotificationService;
    private RenameService renameService;
    private AssetOrganizerService assetOrganizerService;
    private WatchRuleRepository watchRuleRepository;
    private SettingsService settingsService;
    private GuessitParserClient parserClient;
    private CodexRecognitionService codexRecognitionService;
    private ParentFolderMatchEnhancer parentFolderMatchEnhancer;
    private MediaProcessPipeline pipeline;

    @BeforeEach
    void setUp() {
        taskRepository = mock(MediaTaskRepository.class);
        candidateRepository = mock(TaskCandidateRepository.class);
        metadataMatcher = mock(MetadataMatcher.class);
        eventPublisher = mock(EventPublisher.class);
        emailNotificationService = mock(EmailNotificationService.class);
        renameService = mock(RenameService.class);
        assetOrganizerService = mock(AssetOrganizerService.class);
        watchRuleRepository = mock(WatchRuleRepository.class);
        settingsService = mock(SettingsService.class);
        parserClient = mock(GuessitParserClient.class);
        codexRecognitionService = mock(CodexRecognitionService.class);
        parentFolderMatchEnhancer = mock(ParentFolderMatchEnhancer.class);
        when(settingsService.get(any(String.class), any(String.class))).thenAnswer(invocation -> invocation.getArgument(1));
        pipeline = new MediaProcessPipeline(
                parserClient,
                codexRecognitionService,
                metadataMatcher,
                new TmdbEpisodeService(metadataMatcher),
                assetOrganizerService,
                renameService,
                taskRepository,
                candidateRepository,
                watchRuleRepository,
                settingsService,
                eventPublisher,
                emailNotificationService,
                parentFolderMatchEnhancer,
                Map.<String, FileOperationStrategy>of(),
                new AutomaticOrganizationGuard(taskRepository, parserClient, new VideoFileAssetDetector())
        );
        when(taskRepository.save(any(MediaTask.class))).thenAnswer(invocation -> invocation.getArgument(0));
    }

    @AfterEach
    void tearDown() {
        pipeline.shutdownManualConfirmationExecutor();
    }

    @Test
    void clusterIdentityIsAppliedBeforeFilenameSearchWithoutPerFileCodex(@TempDir Path root) throws Exception {
        Path source = Files.writeString(root.resolve("01-8930371d37e8.mp4"), "video");
        WatchRule rule = new WatchRule();
        rule.setMediaType(WatchRule.RuleMediaType.AUTO);
        rule.setOperation(FileOperationStrategy.OperationType.MOVE);
        ParseResult original = new ParseResult();
        original.setTitle("8930371d37e8");
        ParseResult proposed = new ParseResult();
        proposed.setTitle("小城日常");
        proposed.setType("episode");
        proposed.setSeason(1);
        proposed.setEpisode(1);
        var suggestion = new CodexRecognitionService.Suggestion(proposed, 0.87, "路径与同簇文件已确认作品");
        when(parserClient.parse(source.getFileName().toString())).thenReturn(original);
        when(codexRecognitionService.recognizeCluster(source, rule, original))
                .thenReturn(new CodexRecognitionService.ClusterRecognition(true, Optional.of(suggestion)));
        when(codexRecognitionService.requiresConfirmation(0.87)).thenReturn(true);
        MatchResult match = new MatchResult();
        match.setSourceId("272118");
        match.setTitle("小城日常");
        match.setMediaType("TV_SHOW");
        match.setConfidence(0.87);
        match.setSeasons(List.of(new TmdbSeason(1, 13)));
        when(metadataMatcher.getById("272118", "TV_SHOW")).thenReturn(match);
        when(metadataMatcher.getSeasonEpisodes("272118", 1)).thenReturn(List.of(new TmdbEpisode(1, 1, "第一集")));
        when(metadataMatcher.search(proposed)).thenReturn(List.of(match));
        when(parentFolderMatchEnhancer.enhanceIfNeeded(any(), eq(proposed), any(), org.mockito.ArgumentMatchers.anyDouble()))
                .thenReturn(List.of(match));
        TaskCandidate saved = candidate(272118L, "小城日常", 0.87);
        saved.setMediaType(MediaTask.MediaType.TV_SHOW);
        when(candidateRepository.findByTask_IdOrderByRankAsc(any())).thenReturn(List.of(), List.of(saved));
        pipeline.process(source, rule);
        verify(metadataMatcher, never()).search(original);
        verify(codexRecognitionService, never()).recognize(any(), any(), any());
        var task = ArgumentCaptor.forClass(MediaTask.class);
        verify(eventPublisher).publishAwaitingConfirmation(task.capture());
        assertThat(task.getValue().getParsedTitle()).isEqualTo("小城日常");
        assertThat(task.getValue().getParsedEpisode()).isEqualTo(1);
        verify(assetOrganizerService, never()).organize(any());
        assertThat(Files.exists(source)).isTrue();
    }

    @Test
    void unknownClusterDoesNotFallBackToRepeatedIndividualModelCalls(@TempDir Path root) throws Exception {
        Path source = Files.writeString(root.resolve("02.mp4"), "video");
        WatchRule rule = new WatchRule();
        rule.setMediaType(WatchRule.RuleMediaType.TV_SHOW);
        rule.setOperation(FileOperationStrategy.OperationType.MOVE);
        ParseResult parsed = new ParseResult();
        parsed.setEpisode(2);
        when(parserClient.parse("02.mp4")).thenReturn(parsed);
        when(codexRecognitionService.recognizeCluster(source, rule, parsed))
                .thenReturn(new CodexRecognitionService.ClusterRecognition(true, Optional.empty()));
        when(metadataMatcher.search(parsed)).thenReturn(List.of());
        when(parentFolderMatchEnhancer.enhanceIfNeeded(any(), any(), any(), org.mockito.ArgumentMatchers.anyDouble()))
                .thenReturn(List.of());
        pipeline.process(source, rule);
        verify(codexRecognitionService, never()).recognize(any(), any(), any());
        verify(eventPublisher).publishAwaitingConfirmation(any());
        verify(assetOrganizerService, never()).organize(any());
    }

    @Test
    void identifiedClusterStillRequiresTmdbCandidateBeforeOrganizing(@TempDir Path root) throws Exception {
        Path source = Files.writeString(root.resolve("03.mp4"), "video");
        WatchRule rule = new WatchRule();
        rule.setMediaType(WatchRule.RuleMediaType.AUTO);
        rule.setOperation(FileOperationStrategy.OperationType.MOVE);
        ParseResult original = new ParseResult();
        ParseResult proposed = new ParseResult();
        proposed.setTitle("模型给出的作品");
        proposed.setType("episode");
        proposed.setSeason(1);
        proposed.setEpisode(3);
        when(parserClient.parse("03.mp4")).thenReturn(original);
        when(codexRecognitionService.recognizeCluster(source, rule, original))
                .thenReturn(new CodexRecognitionService.ClusterRecognition(true, Optional.of(
                        new CodexRecognitionService.Suggestion(proposed, 0.99, "路径聚类"))));
        when(metadataMatcher.search(proposed)).thenReturn(List.of());
        when(parentFolderMatchEnhancer.enhanceIfNeeded(any(), any(), any(), org.mockito.ArgumentMatchers.anyDouble()))
                .thenReturn(List.of());

        pipeline.process(source, rule);

        var task = ArgumentCaptor.forClass(MediaTask.class);
        verify(eventPublisher).publishAwaitingConfirmation(task.capture());
        assertThat(task.getValue().getErrorMessage()).contains("没有 TMDB 作品候选");
        verify(codexRecognitionService, never()).recognize(any(), any(), any());
        verify(assetOrganizerService, never()).organize(any());
        assertThat(Files.exists(source)).isTrue();
    }

    @Test
    void codexSuggestionRequiresTmdbAndConfirmationBeforeMoving(@TempDir Path root) throws Exception {
        Path source = Files.writeString(root.resolve("01.mkv"), "video");
        WatchRule rule = new WatchRule();
        rule.setMediaType(WatchRule.RuleMediaType.AUTO);
        rule.setOperation(FileOperationStrategy.OperationType.MOVE);
        ParseResult original = new ParseResult();
        original.setType("episode");
        original.setTitle("混淆名");
        ParseResult proposed = new ParseResult();
        proposed.setType("episode");
        proposed.setTitle("正式剧名");
        proposed.setSeason(1);
        proposed.setEpisode(1);
        when(parserClient.parse("01.mkv")).thenReturn(original);
        when(parentFolderMatchEnhancer.enhanceIfNeeded(any(), any(), any(), org.mockito.ArgumentMatchers.anyDouble())).thenReturn(List.of());
        when(codexRecognitionService.recognize(source, rule, original)).thenReturn(Optional.of(
                new CodexRecognitionService.Suggestion(proposed, 0.85, "父目录含正式剧名")));
        when(codexRecognitionService.requiresConfirmation(0.85)).thenReturn(true);
        MatchResult match = new MatchResult();
        match.setSourceId("123");
        match.setTitle("正式剧名");
        match.setMediaType("TV_SHOW");
        match.setConfidence(0.99);
        when(metadataMatcher.search(original)).thenReturn(List.of());
        when(metadataMatcher.search(proposed)).thenReturn(List.of(match));
        TaskCandidate saved = candidate(123L, "正式剧名", 0.99);
        saved.setMediaType(MediaTask.MediaType.TV_SHOW);
        match.setSeasons(List.of(new TmdbSeason(1, 12)));
        when(metadataMatcher.getById("123", "TV_SHOW")).thenReturn(match);
        when(metadataMatcher.getSeasonEpisodes("123", 1)).thenReturn(List.of(new TmdbEpisode(1, 1, "第一集")));
        when(candidateRepository.findByTask_IdOrderByRankAsc(any())).thenReturn(List.of(), List.of(saved));

        pipeline.process(source, rule);

        ArgumentCaptor<MediaTask> task = ArgumentCaptor.forClass(MediaTask.class);
        verify(eventPublisher).publishAwaitingConfirmation(task.capture());
        assertThat(task.getValue().getParsedTitle()).isEqualTo("正式剧名");
        assertThat(task.getValue().getErrorMessage()).contains("Codex");
        verify(renameService, never()).rename(any());
        assertThat(Files.exists(source)).isTrue();
    }

    @Test
    void updateRecognitionSavesMovieFieldsAndClearsEpisodeFields() {
        MediaTask task = awaitingTask();
        task.setParsedSeason(1);
        task.setParsedEpisode(2);
        task.setParsedEpisodeEnd(3);
        when(taskRepository.findById(1L)).thenReturn(Optional.of(task));
        when(candidateRepository.findByTask_IdOrderByRankAsc(1L)).thenReturn(List.of());

        QueueRecognitionRequest request = new QueueRecognitionRequest();
        request.setMediaType("MOVIE");
        request.setParsedTitle("The Matrix");
        request.setParsedYear(1999);
        request.setParsedSeason(9);
        request.setParsedEpisode(9);

        QueueRecognitionResponse response = pipeline.updateRecognition(1L, request);

        assertThat(response.task().getMediaType()).isEqualTo(MediaTask.MediaType.MOVIE);
        assertThat(response.task().getParsedTitle()).isEqualTo("The Matrix");
        assertThat(response.task().getParsedYear()).isEqualTo(1999);
        assertThat(response.task().getParsedSeason()).isNull();
        assertThat(response.task().getParsedEpisode()).isNull();
        assertThat(response.task().getParsedEpisodeEnd()).isNull();
    }

    @Test
    void codexCannotChangeUnknownTaskOrMoveFiles(@TempDir Path root) throws Exception {
        Path source = Files.writeString(root.resolve("01.mkv"), "video");
        MediaTask task = awaitingTask();
        task.setSourcePath(source.toString());
        task.setRuleId(1L);
        WatchRule rule = new WatchRule();
        when(taskRepository.findById(1L)).thenReturn(Optional.of(task));
        when(watchRuleRepository.findById(1L)).thenReturn(Optional.of(rule));
        when(codexRecognitionService.recognize(any(), any(), any(), eq(true))).thenReturn(Optional.empty());
        assertThatThrownBy(() -> pipeline.recognizeWithCodex(1L)).hasMessageContaining("未能确定");
        verify(metadataMatcher, never()).search(any());
        verify(renameService, never()).rename(any());
        assertThat(Files.exists(source)).isTrue();
        assertThat(task.getStatus()).isEqualTo(MediaTask.TaskStatus.AWAITING_CONFIRMATION);
    }

    @Test
    void manualCodexRetryKeepsEvidenceAndWaitsForConfirmation(@TempDir Path root) throws Exception {
        Path source = Files.writeString(root.resolve("02.mkv"), "video");
        MediaTask task = awaitingTask();
        task.setSourcePath(source.toString());
        task.setRuleId(1L);
        WatchRule rule = new WatchRule();
        when(taskRepository.findById(1L)).thenReturn(Optional.of(task));
        when(watchRuleRepository.findById(1L)).thenReturn(Optional.of(rule));
        ParseResult proposed = new ParseResult();
        proposed.setTitle("正式剧名");
        proposed.setType("episode");
        proposed.setYear(2026);
        proposed.setEpisode(2);
        when(codexRecognitionService.recognize(eq(source), eq(rule), any(), eq(true))).thenReturn(Optional.of(
                new CodexRecognitionService.Suggestion(proposed, 0.97, "官网 https://example.com/anime")));
        MatchResult match = new MatchResult();
        match.setSourceId("123");
        match.setTitle("正式剧名");
        match.setMediaType("TV_SHOW");
        match.setConfidence(0.97);
        when(metadataMatcher.search(proposed)).thenReturn(List.of(match));
        TaskCandidate saved = candidate(123L, "正式剧名", 0.97);
        when(candidateRepository.findByTask_IdOrderByRankAsc(1L)).thenReturn(List.of(saved));
        when(codexRecognitionService.requiresConfirmation(0.97)).thenReturn(true);

        var response = pipeline.recognizeWithCodex(1L);

        assertThat(response.task().getStatus()).isEqualTo(MediaTask.TaskStatus.AWAITING_CONFIRMATION);
        assertThat(response.task().getParsedEpisode()).isEqualTo(2);
        assertThat(response.task().getParsedSeason()).isEqualTo(1);
        assertThat(response.task().getErrorMessage()).contains("https://example.com/anime");
        assertThat(response.candidates()).containsExactly(saved);
        verify(assetOrganizerService, never()).organize(any());
        assertThat(Files.readString(source)).isEqualTo("video");
    }

    @Test
    void directoryRecognizesOnceAndSharesCandidatesWithoutMoving(@TempDir Path root) throws Exception {
        Path folder = Files.createDirectories(root.resolve("某剧"));
        Path firstFile = Files.writeString(folder.resolve("01.mkv"), "first");
        Path secondFile = Files.writeString(folder.resolve("02.mkv"), "second");
        MediaTask first = awaitingTask();
        first.setRuleId(1L);
        first.setSourcePath(firstFile.toString());
        MediaTask second = awaitingTask();
        second.setId(2L);
        second.setRuleId(1L);
        second.setSourcePath(secondFile.toString());
        MediaTask otherFolder = awaitingTask();
        otherFolder.setId(3L);
        otherFolder.setSourcePath(root.resolve("另一部剧/03.mkv").toString());
        WatchRule rule = new WatchRule();
        when(watchRuleRepository.findById(1L)).thenReturn(Optional.of(rule));
        when(taskRepository.findById(1L)).thenReturn(Optional.of(first));
        when(taskRepository.findById(2L)).thenReturn(Optional.of(second));
        when(taskRepository.findByRuleIdAndStatusIn(eq(1L), any())).thenReturn(List.of(first, second, otherFolder));
        ParseResult parsed1 = new ParseResult();
        parsed1.setTitle("正式剧名");
        parsed1.setType("episode");
        parsed1.setEpisode(1);
        ParseResult parsed2 = new ParseResult();
        parsed2.setTitle("正式剧名");
        parsed2.setType("episode");
        parsed2.setEpisode(2);
        when(codexRecognitionService.recognizeDirectory(eq(firstFile), eq(rule), any())).thenReturn(Map.of(
                "01.mkv", new CodexRecognitionService.Suggestion(parsed1, 0.96, "目录依据"),
                "02.mkv", new CodexRecognitionService.Suggestion(parsed2, 0.96, "目录依据")));
        MatchResult match = new MatchResult();
        match.setSourceId("123");
        match.setTitle("正式剧名");
        match.setMediaType("TV_SHOW");
        match.setConfidence(0.97);
        when(metadataMatcher.search(any())).thenReturn(List.of(match));
        when(candidateRepository.findByTask_IdOrderByRankAsc(any())).thenReturn(List.of());

        var response = pipeline.recognizeDirectoryWithCodex(1L);

        assertThat(response.updated()).hasSize(2);
        assertThat(response.skipped()).isEmpty();
        assertThat(first.getParsedEpisode()).isEqualTo(1);
        assertThat(second.getParsedEpisode()).isEqualTo(2);
        assertThat(first.getParsedSeason()).isEqualTo(1);
        assertThat(first.getStatus()).isEqualTo(MediaTask.TaskStatus.AWAITING_CONFIRMATION);
        assertThat(second.getStatus()).isEqualTo(MediaTask.TaskStatus.AWAITING_CONFIRMATION);
        verify(metadataMatcher).search(any());
        verify(codexRecognitionService).recognizeDirectory(eq(firstFile), eq(rule), any());
        verify(assetOrganizerService, never()).organize(any());
        assertThat(Files.readString(firstFile)).isEqualTo("first");
        assertThat(Files.readString(secondFile)).isEqualTo("second");
    }

    @Test
    void directorySkipsTaskConfirmedWhileModelIsRunning(@TempDir Path root) throws Exception {
        Path source = Files.writeString(root.resolve("01.mkv"), "video");
        MediaTask task = awaitingTask();
        task.setRuleId(1L);
        task.setSourcePath(source.toString());
        task.setParsedTitle("旧标题");
        WatchRule rule = new WatchRule();
        when(taskRepository.findById(1L)).thenReturn(Optional.of(task));
        when(watchRuleRepository.findById(1L)).thenReturn(Optional.of(rule));
        when(taskRepository.findByRuleIdAndStatusIn(eq(1L), any())).thenReturn(List.of(task));
        ParseResult parsed = new ParseResult();
        parsed.setTitle("正式剧名");
        parsed.setType("episode");
        when(codexRecognitionService.recognizeDirectory(any(), any(), any())).thenAnswer(invocation -> {
            task.setStatus(MediaTask.TaskStatus.DONE);
            return Map.of("01.mkv", new CodexRecognitionService.Suggestion(parsed, 0.96, "目录依据"));
        });
        when(metadataMatcher.search(any())).thenReturn(List.of(new MatchResult()));

        var response = pipeline.recognizeDirectoryWithCodex(1L);

        assertThat(response.updated()).isEmpty();
        assertThat(response.skipped()).hasSize(1);
        assertThat(task.getStatus()).isEqualTo(MediaTask.TaskStatus.DONE);
        assertThat(task.getParsedTitle()).isEqualTo("旧标题");
        verify(candidateRepository, never()).deleteAll(any());
        verify(taskRepository, never()).save(any());
    }

    @Test
    void directoryTmdbMissLeavesOriginalTaskAndCandidates(@TempDir Path root) throws Exception {
        Path source = Files.writeString(root.resolve("01.mkv"), "video");
        MediaTask task = awaitingTask();
        task.setRuleId(1L);
        task.setSourcePath(source.toString());
        task.setParsedTitle("旧标题");
        WatchRule rule = new WatchRule();
        when(taskRepository.findById(1L)).thenReturn(Optional.of(task));
        when(watchRuleRepository.findById(1L)).thenReturn(Optional.of(rule));
        when(taskRepository.findByRuleIdAndStatusIn(eq(1L), any())).thenReturn(List.of(task));
        ParseResult parsed = new ParseResult();
        parsed.setTitle("未查证标题");
        parsed.setType("episode");
        when(codexRecognitionService.recognizeDirectory(any(), any(), any())).thenReturn(Map.of(
                "01.mkv", new CodexRecognitionService.Suggestion(parsed, 0.96, "目录依据")));
        when(metadataMatcher.search(any())).thenReturn(List.of());
        assertThatThrownBy(() -> pipeline.recognizeDirectoryWithCodex(1L)).hasMessageContaining("TMDB");
        assertThat(task.getParsedTitle()).isEqualTo("旧标题");
        verify(candidateRepository, never()).deleteAll(any());
        verify(taskRepository, never()).save(any());
    }

    @Test
    void bothConfirmationModesRejectMissingEpisodeBeforeAnySideEffects(@TempDir Path root) throws Exception {
        MediaTask task = awaitingTask();
        Path source = Files.writeString(root.resolve("02.mkv"), "video");
        task.setSourcePath(source.toString());
        task.setParsedSeason(1);
        when(taskRepository.findById(1L)).thenReturn(Optional.of(task));

        assertThatThrownBy(() -> pipeline.confirm(1L, 123L, "TV_SHOW"))
                .hasMessageContaining("季号和集号");
        assertThatThrownBy(() -> pipeline.submitConfirm(1L, 123L, "TV_SHOW", MediaTask.ConfirmationSource.MANUAL_BATCH))
                .hasMessageContaining("季号和集号");

        verify(taskRepository, never()).save(any());
        verify(candidateRepository, never()).save(any());
        verify(assetOrganizerService, never()).organize(any());
        assertThat(task.getStatus()).isEqualTo(MediaTask.TaskStatus.AWAITING_CONFIRMATION);
        assertThat(Files.readString(source)).isEqualTo("video");
    }

    @Test
    void rematchUsesUpdatedRecognitionAndReplacesCandidateConfidence() {
        MediaTask task = awaitingTask();
        when(taskRepository.findById(1L)).thenReturn(Optional.of(task));
        TaskCandidate oldCandidate = candidate(100L, "Old", 0.2);
        TaskCandidate newCandidate = candidate(200L, "New", 0.92);
        when(candidateRepository.findByTask_IdOrderByRankAsc(1L))
                .thenReturn(List.of(oldCandidate))
                .thenReturn(List.of(newCandidate));

        MatchResult match = new MatchResult();
        match.setSourceId("200");
        match.setTitle("New");
        match.setMediaType("TV_SHOW");
        match.setConfidence(0.92);
        when(metadataMatcher.search(any(ParseResult.class))).thenReturn(List.of(match));

        QueueRecognitionRequest request = new QueueRecognitionRequest();
        request.setMediaType("TV_SHOW");
        request.setParsedTitle("New Show");
        request.setParsedYear(2024);
        request.setParsedSeason(2);
        request.setParsedEpisode(3);
        request.setParsedEpisodeEnd(4);

        QueueRecognitionResponse response = pipeline.updateRecognitionAndRematch(1L, request);

        ArgumentCaptor<ParseResult> parseCaptor = ArgumentCaptor.forClass(ParseResult.class);
        verify(metadataMatcher).search(parseCaptor.capture());
        assertThat(parseCaptor.getValue().getTitle()).isEqualTo("New Show");
        assertThat(parseCaptor.getValue().getType()).isEqualTo("episode");
        assertThat(parseCaptor.getValue().getSeason()).isEqualTo(2);
        assertThat(parseCaptor.getValue().getEpisode()).isEqualTo(3);
        assertThat(parseCaptor.getValue().getEpisodeEnd()).isEqualTo(4);
        verify(candidateRepository).deleteAll(List.of(oldCandidate));
        assertThat(response.task().getMatchConfidence()).isEqualTo(0.92);
        assertThat(response.candidates()).containsExactly(newCandidate);
    }

    @ParameterizedTest
    @ValueSource(strings = {"Show.S03E07.mkv", "07.mkv"})
    void confirmEnrichesSelectedCandidateWithTmdbDetail(String filename, @TempDir Path tempDir) throws Exception {
        int season = filename.startsWith("Show") ? 3 : 1;
        Path source = Files.writeString(tempDir.resolve(filename), "video");
        Path target = tempDir.resolve("library/Show/Show - S03E07 - One Minute.mkv");

        MediaTask task = awaitingTask();
        task.setRuleId(9L);
        task.setSourcePath(source.toString());
        task.setParsedEpisode(7);
        task.setMediaType(MediaTask.MediaType.TV_SHOW);
        when(taskRepository.findById(1L)).thenReturn(Optional.of(task));

        WatchRule rule = new WatchRule();
        rule.setId(9L);
        rule.setMoveAssociatedFiles(false);
        rule.setGenerateNfo(true); // 旧规则仍开启时，也不能再生成 NFO。
        when(watchRuleRepository.findById(9L)).thenReturn(Optional.of(rule));
        when(assetOrganizerService.organize(task)).thenReturn(target);

        TaskCandidate candidate = candidate(321L, "Old Show", 0.91);
        candidate.setMediaType(MediaTask.MediaType.TV_SHOW);
        when(candidateRepository.findByTask_IdAndTmdbIdAndMediaType(1L, 321L, MediaTask.MediaType.TV_SHOW))
                .thenReturn(Optional.of(candidate));
        when(candidateRepository.findByTask_IdOrderByRankAsc(1L)).thenReturn(List.of(candidate));

        MatchResult detail = new MatchResult();
        detail.setSourceId("321");
        detail.setTitle("Show");
        detail.setOriginalTitle("Original Show");
        detail.setYear(2008);
        detail.setMediaType("TV_SHOW");
        detail.setGenres(List.of("Drama", "Crime"));
        detail.setCountry("US");
        detail.setPosterUrl("poster");
        detail.setOverview("overview");
        detail.setConfidence(1.0);
        detail.setSeasons(List.of(new TmdbSeason(season, 7)));
        when(metadataMatcher.getById("321", "TV_SHOW")).thenReturn(detail);
        when(metadataMatcher.getSeasonEpisodes("321", season)).thenReturn(List.of(new TmdbEpisode(season, 7, "One Minute")));

        pipeline.confirm(1L, 321L, "TV_SHOW");

        assertThat(task.getParsedSeason()).isEqualTo(season);
        assertThat(task.getConfirmedTitle()).isEqualTo("Show");
        assertThat(task.getConfirmedOriginalTitle()).isEqualTo("Original Show");
        assertThat(task.getConfirmedGenre1()).isEqualTo("Drama");
        assertThat(task.getConfirmedGenre2()).isEqualTo("Crime");
        assertThat(task.getConfirmedCountry()).isEqualTo("US");
        assertThat(task.getConfirmedEpisodeTitle()).isEqualTo("One Minute");
        assertThat(task.getStatus()).isEqualTo(MediaTask.TaskStatus.DONE);
        assertThat(Files.exists(target.resolveSibling("Show - S03E07 - One Minute.nfo"))).isFalse();
        assertThat(candidate.getGenre1()).isEqualTo("Drama");
        assertThat(candidate.getGenre2()).isEqualTo("Crime");
        assertThat(candidate.getCountry()).isEqualTo("US");
        assertThat(candidate.getEpisodeTitle()).isEqualTo("One Minute");
        verify(metadataMatcher).getSeasonEpisodes("321", season);
    }

    @Test
    void updateRecognitionRejectsNonAwaitingTask() {
        MediaTask task = awaitingTask();
        task.setStatus(MediaTask.TaskStatus.PROCESSING);
        when(taskRepository.findById(1L)).thenReturn(Optional.of(task));

        QueueRecognitionRequest request = new QueueRecognitionRequest();
        request.setMediaType("MOVIE");
        request.setParsedTitle("The Matrix");

        assertThatThrownBy(() -> pipeline.updateRecognition(1L, request))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("Only awaiting confirmation tasks");
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void confirmationPausesOnConflictAndUsesTmdbCoordinatesAfterReview(boolean asynchronous, @TempDir Path root) throws Exception {
        Path source = Files.writeString(root.resolve("Blue.Box.S02E26.mkv"), "video");
        MediaTask task = awaitingTask();
        task.setMediaType(MediaTask.MediaType.TV_SHOW);
        task.setSourcePath(source.toString());
        task.setRuleId(9L);
        task.setParsedSeason(2);
        task.setParsedEpisode(26);
        TaskCandidate candidate = candidate(207347L, "青之箱", 0.99);
        candidate.setMediaType(MediaTask.MediaType.TV_SHOW);
        MatchResult detail = new MatchResult();
        detail.setSourceId("207347");
        detail.setTitle("青之箱");
        detail.setMediaType("TV_SHOW");
        detail.setSeasons(List.of(new TmdbSeason(1, 37)));
        when(taskRepository.findById(1L)).thenReturn(Optional.of(task));
        when(candidateRepository.findByTask_IdAndTmdbIdAndMediaType(1L, 207347L, MediaTask.MediaType.TV_SHOW))
                .thenReturn(Optional.of(candidate));
        when(candidateRepository.findByTask_IdOrderByRankAsc(1L)).thenReturn(List.of(candidate));
        when(metadataMatcher.getById("207347", "TV_SHOW")).thenReturn(detail);
        when(metadataMatcher.getSeasonEpisodes("207347", 1)).thenReturn(List.of(new TmdbEpisode(1, 26, "似曾相识")));

        if (asynchronous) {
            pipeline.submitConfirm(1L, 207347L, "TV_SHOW", MediaTask.ConfirmationSource.MANUAL_BATCH);
            verify(eventPublisher, org.mockito.Mockito.timeout(2000)).publishAwaitingConfirmation(task);
        } else {
            assertThatThrownBy(() -> pipeline.confirm(1L, 207347L, "TV_SHOW"))
                    .hasMessageContaining("S02E26").hasMessageContaining("S01E26");
        }
        assertThat(task.getStatus()).isEqualTo(MediaTask.TaskStatus.AWAITING_CONFIRMATION);
        assertThat(task.getParsedSeason()).isEqualTo(1);
        verify(assetOrganizerService, never()).organize(any());
        assertThat(Files.exists(source)).isTrue();

        WatchRule rule = new WatchRule();
        rule.setMoveAssociatedFiles(false);
        when(watchRuleRepository.findById(9L)).thenReturn(Optional.of(rule));
        when(assetOrganizerService.organize(task)).thenReturn(root.resolve("library/Season 01/青之箱 - S01E26.mkv"));
        pipeline.confirm(1L, 207347L, "TV_SHOW");
        assertThat(task.getStatus()).isEqualTo(MediaTask.TaskStatus.DONE);
        assertThat(task.getConfirmedEpisodeTitle()).isEqualTo("似曾相识");
        assertThat(task.getTargetPath()).contains("S01E26");
        assertThat(task.getMetadataWarning()).contains("S02E26", "S01E26");
    }

    @Test
    void highConfidenceCannotBypassInvalidTmdbEpisode(@TempDir Path root) throws Exception {
        Path source = Files.writeString(root.resolve("Blue.Box.S02E26.mkv"), "video");
        WatchRule rule = new WatchRule();
        rule.setMediaType(WatchRule.RuleMediaType.TV_SHOW);
        ParseResult parsed = new ParseResult();
        parsed.setType("episode");
        parsed.setTitle("Blue Box");
        parsed.setSeason(2);
        parsed.setEpisode(26);
        MatchResult detail = new MatchResult();
        detail.setSourceId("207347");
        detail.setTitle("青之箱");
        detail.setMediaType("TV_SHOW");
        detail.setConfidence(0.99);
        detail.setSeasons(List.of(new TmdbSeason(1, 25), new TmdbSeason(2, 12)));
        TaskCandidate candidate = candidate(207347L, "青之箱", 0.99);
        candidate.setMediaType(MediaTask.MediaType.TV_SHOW);
        when(parserClient.parse(source.getFileName().toString())).thenReturn(parsed);
        when(metadataMatcher.search(parsed)).thenReturn(List.of(detail));
        when(parentFolderMatchEnhancer.enhanceIfNeeded(any(), any(), any(), org.mockito.ArgumentMatchers.anyDouble()))
                .thenReturn(List.of(detail));
        when(candidateRepository.findByTask_IdOrderByRankAsc(any())).thenReturn(List.of(), List.of(candidate));
        when(metadataMatcher.getById("207347", "TV_SHOW")).thenReturn(detail);
        when(metadataMatcher.getSeasonEpisodes("207347", 2)).thenReturn(List.of(new TmdbEpisode(2, 1, "首集")));

        pipeline.process(source, rule);

        ArgumentCaptor<MediaTask> awaiting = ArgumentCaptor.forClass(MediaTask.class);
        verify(eventPublisher).publishAwaitingConfirmation(awaiting.capture());
        assertThat(awaiting.getValue().getErrorMessage()).contains("不存在第 26 集");
        verify(assetOrganizerService, never()).organize(any());
        assertThat(Files.exists(source)).isTrue();
    }

    @Test
    void updateRecognitionRejectsEpisodeRangeEndBeforeStart() {
        MediaTask task = awaitingTask();
        when(taskRepository.findById(1L)).thenReturn(Optional.of(task));

        QueueRecognitionRequest request = new QueueRecognitionRequest();
        request.setMediaType("TV_SHOW");
        request.setParsedTitle("Friends");
        request.setParsedSeason(1);
        request.setParsedEpisode(17);
        request.setParsedEpisodeEnd(16);

        assertThatThrownBy(() -> pipeline.updateRecognition(1L, request))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Episode range end");
    }

    @Test
    void recordFailureMergesSameSourceRuleAndErrorCode() {
        MediaTask currentTask = new MediaTask();
        currentTask.setId(1L);
        currentTask.setSourcePath("D:/incoming/movie.mkv");
        currentTask.setRuleId(9L);

        MediaTask existingFailure = new MediaTask();
        existingFailure.setId(2L);
        existingFailure.setSourcePath("D:/incoming/movie.mkv");
        existingFailure.setRuleId(9L);
        existingFailure.setStatus(MediaTask.TaskStatus.FAILED);
        existingFailure.setErrorCode(MediaTask.TaskErrorCode.TARGET_CONFLICT);
        existingFailure.setFailureCount(1);

        when(taskRepository.findFirstBySourcePathAndRuleIdAndStatusAndErrorCodeOrderByUpdatedAtDesc(
                "D:/incoming/movie.mkv",
                9L,
                MediaTask.TaskStatus.FAILED,
                MediaTask.TaskErrorCode.TARGET_CONFLICT
        )).thenReturn(Optional.of(existingFailure));
        when(candidateRepository.findByTask_IdOrderByRankAsc(1L)).thenReturn(List.of());

        pipeline.recordFailure(
                currentTask,
                new MediaTaskFailureException(
                        MediaTask.TaskErrorCode.TARGET_CONFLICT,
                        "目标文件已存在，文件冲突"
                )
        );

        assertThat(existingFailure.getFailureCount()).isEqualTo(2);
        assertThat(existingFailure.getErrorMessage()).isEqualTo("目标文件已存在，文件冲突");
        assertThat(existingFailure.getLastFailedAt()).isNotNull();
        verify(taskRepository).save(existingFailure);
        verify(taskRepository).delete(currentTask);
        verify(eventPublisher).publishTaskFailed(existingFailure);
        verify(emailNotificationService, never()).notifyTaskFailed(existingFailure);
    }

    @Test
    void newHighConfidenceClusterOrganizesWithoutManualApproval(@TempDir Path root) throws Exception {
        List<MediaTask> tasks = autoDirectory(root, 1);
        Path source = Path.of(tasks.getFirst().getSourcePath());
        WatchRule rule = watchRuleRepository.findById(9L).orElseThrow();
        ParseResult parsed = new ParseResult();
        parsed.setTitle("正式剧名");
        parsed.setType("episode");
        parsed.setSeason(1);
        parsed.setEpisode(1);
        when(parserClient.parse(source.getFileName().toString())).thenReturn(parsed);
        when(codexRecognitionService.recognizeCluster(eq(source), eq(rule), any())).thenReturn(
                new CodexRecognitionService.ClusterRecognition(true, Optional.of(
                        new CodexRecognitionService.Suggestion(parsed, 0.97, "同簇作品已确认"))));
        when(parentFolderMatchEnhancer.enhanceIfNeeded(any(), any(), any(), org.mockito.ArgumentMatchers.anyDouble()))
                .thenAnswer(invocation -> invocation.getArgument(2));
        when(taskRepository.save(any(MediaTask.class))).thenAnswer(invocation -> {
            MediaTask task = invocation.getArgument(0);
            if (task.getId() == null) task.setId(100L);
            return task;
        });
        pipeline.process(source, rule);
        var done = ArgumentCaptor.forClass(MediaTask.class);
        verify(eventPublisher).publishTaskDone(done.capture());
        assertThat(done.getValue().getConfirmationSource()).isEqualTo(MediaTask.ConfirmationSource.AUTO_MATCH);
        assertThat(Files.exists(root.resolve("library/S01E01.mkv"))).isTrue();
        verify(eventPublisher, never()).publishAwaitingConfirmation(any());
    }

    @Test
    void reliableDirectoryAutomaticallyOrganizesWithoutOpeningApproval(@TempDir Path root) throws Exception {
        List<MediaTask> tasks = autoDirectory(root, 1, 2);
        var response = pipeline.recognizeDirectoryWithCodex(1L);
        assertThat(response.updated()).hasSize(2);
        for (MediaTask task : tasks) {
            verify(eventPublisher, org.mockito.Mockito.timeout(3000)).publishTaskDone(task);
            assertThat(task.getConfirmationSource()).isEqualTo(MediaTask.ConfirmationSource.AUTO_MATCH);
            assertThat(Files.exists(Path.of(task.getTargetPath()))).isTrue();
        }
        verify(eventPublisher, never()).publishAwaitingConfirmation(any());
    }

    @Test
    void duplicatePairStaysForReviewWhileOtherEpisodesAutomaticallyOrganize(@TempDir Path root) throws Exception {
        List<MediaTask> tasks = autoDirectory(root, 49, 49, 50);
        pipeline.recognizeDirectoryWithCodex(1L);
        verify(eventPublisher, org.mockito.Mockito.timeout(3000)).publishTaskDone(tasks.get(2));
        for (MediaTask task : tasks.subList(0, 2)) {
            assertThat(task.getStatus()).isEqualTo(MediaTask.TaskStatus.AWAITING_CONFIRMATION);
            assertThat(task.getErrorMessage()).contains("S01E49", "01.mkv", "02.mkv");
            assertThat(Files.exists(Path.of(task.getSourcePath()))).isTrue();
            verify(assetOrganizerService, never()).organize(task);
        }
    }

    @Test
    void targetConflictOnlyBlocksTheAffectedFile(@TempDir Path root) throws Exception {
        List<MediaTask> tasks = autoDirectory(root, 1, 2);
        Path existing = Files.createDirectories(root.resolve("library")).resolve("S01E01.mkv");
        Files.writeString(existing, "已有文件");
        pipeline.recognizeDirectoryWithCodex(1L);
        verify(eventPublisher, org.mockito.Mockito.timeout(3000)).publishTaskDone(tasks.get(1));
        assertThat(tasks.getFirst().getStatus()).isEqualTo(MediaTask.TaskStatus.AWAITING_CONFIRMATION);
        assertThat(tasks.getFirst().getErrorMessage()).contains("目标路径已存在", existing.toString());
        assertThat(Files.readString(existing)).isEqualTo("已有文件");
        verify(assetOrganizerService, never()).organize(tasks.getFirst());
    }

    @Test
    void collidingTemplateBlocksAllFilesBeforeAnyMove(@TempDir Path root) throws Exception {
        List<MediaTask> tasks = autoDirectory(root, 1, 2);
        org.mockito.Mockito.doReturn(root.resolve("library/same.mkv")).when(assetOrganizerService).previewTarget(any());
        pipeline.recognizeDirectoryWithCodex(1L);
        for (MediaTask task : tasks) {
            assertThat(task.getStatus()).isEqualTo(MediaTask.TaskStatus.AWAITING_CONFIRMATION);
            assertThat(task.getErrorMessage()).contains("同一目标", "01.mkv", "02.mkv");
        }
        verify(assetOrganizerService, never()).organize(any());
    }

    @Test
    void lowModelConfidenceStaysForReviewWithSpecificReason(@TempDir Path root) throws Exception {
        List<MediaTask> tasks = autoDirectory(root, 1, 2);
        when(codexRecognitionService.requiresConfirmation(0.97)).thenReturn(true);
        pipeline.recognizeDirectoryWithCodex(1L);
        assertThat(tasks).allSatisfy(task -> {
            assertThat(task.getStatus()).isEqualTo(MediaTask.TaskStatus.AWAITING_CONFIRMATION);
            assertThat(task.getErrorMessage()).contains("Codex", "90%", "识别依据");
        });
        verify(assetOrganizerService, never()).organize(any());
    }

    @Test
    void lowTmdbConfidenceDoesNotBecomeAutomaticJustBecauseModelIsCertain(@TempDir Path root) throws Exception {
        List<MediaTask> tasks = autoDirectory(root, 1, 2);
        when(settingsService.get("watcher.confidence-threshold", "0.8")).thenReturn("0.99");
        pipeline.recognizeDirectoryWithCodex(1L);
        assertThat(tasks).allSatisfy(task -> {
            assertThat(task.getStatus()).isEqualTo(MediaTask.TaskStatus.AWAITING_CONFIRMATION);
            assertThat(task.getErrorMessage()).contains("作品匹配置信度不足", "97%", "99%");
        });
        verify(assetOrganizerService, never()).organize(any());
    }

    @Test
    void verifiedSeasonRemappingCanAutomaticallyOrganize(@TempDir Path root) throws Exception {
        List<MediaTask> tasks = autoDirectory(root, 1, 2);
        when(metadataMatcher.getSeasonEpisodes("123", 2)).thenReturn(List.of(
                new TmdbEpisode(2, 1, "第一集"), new TmdbEpisode(2, 2, "第二集")));
        MatchResult detail = new MatchResult();
        detail.setSourceId("123");
        detail.setTitle("正式剧名");
        detail.setMediaType("TV_SHOW");
        detail.setSeasons(List.of(new TmdbSeason(2, 2)));
        when(metadataMatcher.getById("123", "TV_SHOW")).thenReturn(detail);
        pipeline.recognizeDirectoryWithCodex(1L);
        for (MediaTask task : tasks) verify(eventPublisher, org.mockito.Mockito.timeout(3000)).publishTaskDone(task);
        assertThat(tasks).allSatisfy(task -> {
            assertThat(task.getStatus()).isEqualTo(MediaTask.TaskStatus.DONE);
            assertThat(task.getParsedSeason()).isEqualTo(2);
            assertThat(task.getTargetPath()).contains("S02E");
            assertThat(task.getMetadataWarning()).contains("TMDB", "S01E", "S02E");
        });
        verify(eventPublisher, never()).publishAwaitingConfirmation(any());
    }

    @ParameterizedTest
    @ValueSource(booleans = {false, true})
    void jujutsuKaisenDirectoryUsesVerifiedSeasonAndRetainsAbsoluteEpisodeNumbers(boolean historicalWarning, @TempDir Path root) throws Exception {
        List<MediaTask> tasks = jujutsuDirectory(root, 48, 49);
        if (historicalWarning) tasks.forEach(task -> task.setMetadataWarning("历史季号映射提示，待核对"));
        pipeline.recognizeDirectoryWithCodex(1L);
        for (MediaTask task : tasks) verify(eventPublisher, org.mockito.Mockito.timeout(3000)).publishTaskDone(task);
        assertThat(tasks).allSatisfy(task -> {
            assertThat(task.getParsedSeason()).isEqualTo(1);
            assertThat(task.getSourcePath()).contains("咒术回战/S03/");
            assertThat(task.getMetadataWarning()).contains("S03E", "S01E");
            assertThat(task.getConfirmationSource()).isEqualTo(MediaTask.ConfirmationSource.AUTO_MATCH);
        });
        assertThat(tasks.getFirst().getTargetPath()).contains("S01E48");
        assertThat(tasks.getLast().getTargetPath()).contains("S01E49");
        verify(eventPublisher, never()).publishAwaitingConfirmation(any());
    }

    @Test
    void seasonMappingStillBlocksUnqueuedHashDuplicate(@TempDir Path root) throws Exception {
        List<MediaTask> tasks = jujutsuDirectory(root, 48);
        MediaTask task = tasks.getFirst();
        Path source = Path.of(task.getSourcePath());
        Path copy = Files.writeString(source.resolveSibling(source.getFileName().toString()
                .replace(".mp4", "-4439f0c824f5.mp4")), "副本");
        pipeline.recognizeDirectoryWithCodex(1L);
        assertThat(task.getStatus()).isEqualTo(MediaTask.TaskStatus.AWAITING_CONFIRMATION);
        assertThat(task.getErrorMessage()).contains("S01E48", "重复", copy.getFileName().toString());
        assertThat(Files.exists(source)).isTrue();
        assertThat(Files.exists(copy)).isTrue();
        verify(assetOrganizerService, never()).organize(any());
    }

    @Test
    void retryOfPreviouslyMappedTaskStillDetectsSourceSeasonDuplicate(@TempDir Path root) throws Exception {
        List<MediaTask> tasks = jujutsuDirectory(root, 48);
        MediaTask task = tasks.getFirst();
        task.setParsedSeason(1);
        task.setMetadataWarning("来源 S03E48，已采用 TMDB S01E48");
        Path source = Path.of(task.getSourcePath());
        Files.writeString(source.resolveSibling(source.getFileName().toString()
                .replace(".mp4", "-4439f0c824f5.mp4")), "副本");
        ParseResult parsed = new ParseResult();
        parsed.setTitle("咒术回战");
        parsed.setType("episode");
        parsed.setSeason(1);
        parsed.setEpisode(48);
        when(codexRecognitionService.recognize(any(), any(), any(), eq(true))).thenReturn(Optional.of(
                new CodexRecognitionService.Suggestion(parsed, 0.97, "已使用 TMDB 坐标")));

        pipeline.recognizeWithCodex(1L);
        assertThat(task.getStatus()).isEqualTo(MediaTask.TaskStatus.AWAITING_CONFIRMATION);
        assertThat(task.getErrorMessage()).contains("S01E48", "重复", "4439f0c824f5");
        verify(assetOrganizerService, never()).organize(any());
    }

    private List<MediaTask> jujutsuDirectory(Path root, int... episodes) throws Exception {
        List<MediaTask> tasks = autoDirectory(root, episodes);
        Path directory = Files.createDirectories(root.resolve("咒术回战/S03"));
        Map<String, CodexRecognitionService.Suggestion> suggestions = new java.util.LinkedHashMap<>();
        for (int index = 0; index < tasks.size(); index++) {
            MediaTask task = tasks.get(index);
            String filename = "[BeanSub&FZSD][Jujutsu_Kaisen][%d][GB][1080P][x264_AAC].mp4".formatted(episodes[index]);
            Path source = Files.move(Path.of(task.getSourcePath()), directory.resolve(filename));
            task.setSourcePath(source.toString());
            ParseResult parsed = new ParseResult();
            parsed.setTitle("咒术回战");
            parsed.setType("episode");
            parsed.setSeason(3);
            parsed.setEpisode(episodes[index]);
            suggestions.put(filename, new CodexRecognitionService.Suggestion(parsed, 0.97, "作品身份可靠，来源目录按播出分季"));
        }
        when(codexRecognitionService.recognizeDirectory(any(), any(), any())).thenReturn(suggestions);
        return tasks;
    }

    @Test
    void singleCodexRetryAutomaticallyResumesWhenChecksPass(@TempDir Path root) throws Exception {
        List<MediaTask> tasks = autoDirectory(root, 1);
        ParseResult parsed = new ParseResult();
        parsed.setTitle("正式剧名");
        parsed.setType("episode");
        parsed.setEpisode(1);
        when(codexRecognitionService.recognize(any(), any(), any(), eq(true))).thenReturn(Optional.of(
                new CodexRecognitionService.Suggestion(parsed, 0.97, "目录与官网依据")));
        pipeline.recognizeWithCodex(1L);
        verify(eventPublisher, org.mockito.Mockito.timeout(3000)).publishTaskDone(tasks.getFirst());
        assertThat(tasks.getFirst().getConfirmationSource()).isEqualTo(MediaTask.ConfirmationSource.AUTO_MATCH);
        verify(eventPublisher, never()).publishAwaitingConfirmation(any());
    }

    private List<MediaTask> autoDirectory(Path root, int... episodes) throws Exception {
        Path folder = Files.createDirectories(root.resolve("incoming"));
        List<MediaTask> tasks = new java.util.ArrayList<>();
        Map<String, CodexRecognitionService.Suggestion> suggestions = new java.util.LinkedHashMap<>();
        Map<Long, List<TaskCandidate>> candidates = new java.util.HashMap<>();
        for (int index = 0; index < episodes.length; index++) {
            String filename = "%02d.mkv".formatted(index + 1);
            MediaTask task = awaitingTask();
            task.setId((long) index + 1);
            task.setRuleId(9L);
            task.setSourcePath(Files.writeString(folder.resolve(filename), "视频" + index).toString());
            tasks.add(task);
            ParseResult parsed = new ParseResult();
            parsed.setTitle("正式剧名");
            parsed.setType("episode");
            parsed.setSeason(1);
            parsed.setEpisode(episodes[index]);
            suggestions.put(filename, new CodexRecognitionService.Suggestion(parsed, 0.97, "目录与官网依据"));
            candidates.put(task.getId(), new java.util.ArrayList<>());
            when(taskRepository.findById(task.getId())).thenReturn(Optional.of(task));
        }
        WatchRule rule = new WatchRule();
        rule.setId(9L);
        rule.setMoveAssociatedFiles(false);
        when(watchRuleRepository.findById(9L)).thenReturn(Optional.of(rule));
        when(taskRepository.findByRuleIdAndStatusIn(eq(9L), any())).thenReturn(tasks);
        when(codexRecognitionService.recognizeDirectory(any(), eq(rule), any())).thenReturn(suggestions);
        when(candidateRepository.findByTask_IdOrderByRankAsc(any())).thenAnswer(invocation ->
                candidates.getOrDefault(invocation.getArgument(0), List.of()));
        when(candidateRepository.save(any())).thenAnswer(invocation -> {
            TaskCandidate candidate = invocation.getArgument(0);
            List<TaskCandidate> stored = candidates.computeIfAbsent(candidate.getTask().getId(), ignored -> new java.util.ArrayList<>());
            if (!stored.contains(candidate)) stored.add(candidate);
            return candidate;
        });
        MatchResult match = new MatchResult();
        match.setSourceId("123");
        match.setTitle("正式剧名");
        match.setMediaType("TV_SHOW");
        match.setConfidence(0.97);
        match.setSeasons(List.of(new TmdbSeason(1, 100)));
        when(metadataMatcher.search(any())).thenReturn(List.of(match));
        when(metadataMatcher.getById("123", "TV_SHOW")).thenAnswer(invocation -> {
            MatchResult detail = new MatchResult();
            detail.setSourceId("123");
            detail.setTitle("正式剧名");
            detail.setMediaType("TV_SHOW");
            detail.setSeasons(List.of(new TmdbSeason(1, 100)));
            return detail;
        });
        when(metadataMatcher.getSeasonEpisodes("123", 1)).thenReturn(java.util.Arrays.stream(episodes).distinct()
                .mapToObj(episode -> new TmdbEpisode(1, episode, "第" + episode + "集")).toList());
        when(assetOrganizerService.previewTarget(any())).thenAnswer(invocation -> {
            MediaTask task = invocation.getArgument(0);
            return root.resolve("library/S%02dE%02d.mkv".formatted(task.getParsedSeason(), task.getParsedEpisode()));
        });
        when(assetOrganizerService.organize(any())).thenAnswer(invocation -> {
            MediaTask task = invocation.getArgument(0);
            Path target = root.resolve("library/S%02dE%02d.mkv".formatted(task.getParsedSeason(), task.getParsedEpisode()));
            Files.createDirectories(target.getParent());
            return Files.move(Path.of(task.getSourcePath()), target);
        });
        return tasks;
    }

    private MediaTask awaitingTask() {
        MediaTask task = new MediaTask();
        task.setId(1L);
        task.setStatus(MediaTask.TaskStatus.AWAITING_CONFIRMATION);
        task.setParsedTitle("Old Title");
        return task;
    }

    private TaskCandidate candidate(Long tmdbId, String title, Double confidence) {
        TaskCandidate candidate = new TaskCandidate();
        candidate.setId(tmdbId);
        candidate.setTmdbId(tmdbId);
        candidate.setTitle(title);
        candidate.setMediaType(MediaTask.MediaType.MOVIE);
        candidate.setConfidence(confidence);
        candidate.setRank(1);
        return candidate;
    }
}
