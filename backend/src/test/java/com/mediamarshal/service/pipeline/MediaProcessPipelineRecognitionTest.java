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
import com.mediamarshal.service.matcher.ParentFolderMatchEnhancer;
import com.mediamarshal.service.nfo.NfoGeneratorService;
import com.mediamarshal.service.parser.GuessitParserClient;
import com.mediamarshal.service.parser.CodexRecognitionService;
import com.mediamarshal.service.rename.AssetOrganizerService;
import com.mediamarshal.service.rename.FileOperationStrategy;
import com.mediamarshal.service.rename.RenameService;
import com.mediamarshal.service.settings.SettingsService;
import com.mediamarshal.websocket.EventPublisher;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
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
                assetOrganizerService,
                renameService,
                mock(NfoGeneratorService.class),
                taskRepository,
                candidateRepository,
                watchRuleRepository,
                settingsService,
                eventPublisher,
                emailNotificationService,
                parentFolderMatchEnhancer,
                Map.<String, FileOperationStrategy>of()
        );
        when(taskRepository.save(any(MediaTask.class))).thenAnswer(invocation -> invocation.getArgument(0));
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
                new CodexRecognitionService.Suggestion(proposed, 0.95, "父目录含正式剧名")));
        when(codexRecognitionService.requiresConfirmation(0.95)).thenReturn(true);
        MatchResult match = new MatchResult();
        match.setSourceId("123");
        match.setTitle("正式剧名");
        match.setMediaType("TV_SHOW");
        match.setConfidence(0.99);
        when(metadataMatcher.search(original)).thenReturn(List.of());
        when(metadataMatcher.search(proposed)).thenReturn(List.of(match));
        TaskCandidate saved = candidate(123L, "正式剧名", 0.99);
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

        var response = pipeline.recognizeWithCodex(1L);

        assertThat(response.task().getStatus()).isEqualTo(MediaTask.TaskStatus.AWAITING_CONFIRMATION);
        assertThat(response.task().getParsedEpisode()).isEqualTo(2);
        assertThat(response.task().getParsedSeason()).isNull();
        assertThat(response.task().getErrorMessage()).contains("https://example.com/anime");
        assertThat(response.candidates()).containsExactly(saved);
        verify(assetOrganizerService, never()).organize(any());
        assertThat(Files.readString(source)).isEqualTo("video");
    }

    @Test
    void bothConfirmationModesRejectMissingSeasonBeforeAnySideEffects(@TempDir Path root) throws Exception {
        MediaTask task = awaitingTask();
        Path source = Files.writeString(root.resolve("02.mkv"), "video");
        task.setSourcePath(source.toString());
        task.setParsedEpisode(2);
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

    @Test
    void confirmEnrichesSelectedCandidateWithTmdbDetail(@TempDir Path tempDir) throws Exception {
        Path source = Files.writeString(tempDir.resolve("Show.S03E07.mkv"), "video");
        Path target = tempDir.resolve("library/Show/Show - S03E07 - One Minute.mkv");

        MediaTask task = awaitingTask();
        task.setRuleId(9L);
        task.setSourcePath(source.toString());
        task.setParsedSeason(3);
        task.setParsedEpisode(7);
        task.setMediaType(MediaTask.MediaType.TV_SHOW);
        when(taskRepository.findById(1L)).thenReturn(Optional.of(task));

        WatchRule rule = new WatchRule();
        rule.setId(9L);
        rule.setMoveAssociatedFiles(false);
        rule.setGenerateNfo(false);
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
        when(metadataMatcher.getById("321", "TV_SHOW")).thenReturn(detail);
        when(metadataMatcher.getEpisodeTitle("321", 3, 7)).thenReturn("One Minute");

        pipeline.confirm(1L, 321L, "TV_SHOW");

        assertThat(task.getConfirmedTitle()).isEqualTo("Show");
        assertThat(task.getConfirmedOriginalTitle()).isEqualTo("Original Show");
        assertThat(task.getConfirmedGenre1()).isEqualTo("Drama");
        assertThat(task.getConfirmedGenre2()).isEqualTo("Crime");
        assertThat(task.getConfirmedCountry()).isEqualTo("US");
        assertThat(task.getConfirmedEpisodeTitle()).isEqualTo("One Minute");
        assertThat(task.getStatus()).isEqualTo(MediaTask.TaskStatus.DONE);
        assertThat(candidate.getGenre1()).isEqualTo("Drama");
        assertThat(candidate.getGenre2()).isEqualTo("Crime");
        assertThat(candidate.getCountry()).isEqualTo("US");
        assertThat(candidate.getEpisodeTitle()).isEqualTo("One Minute");
        verify(metadataMatcher).getEpisodeTitle("321", 3, 7);
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
