package com.mediamarshal.service.discovery;

import com.mediamarshal.model.entity.MediaTask;
import com.mediamarshal.model.entity.WatchRule;
import com.mediamarshal.repository.MediaTaskRepository;
import com.mediamarshal.repository.WatchRuleRepository;
import com.mediamarshal.service.discovery.asset.MediaAssetDetectionService;
import com.mediamarshal.service.pipeline.MediaProcessPipeline;
import com.mediamarshal.service.settings.SettingsService;
import com.mediamarshal.websocket.EventPublisher;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.test.util.ReflectionTestUtils;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

class FileDiscoveryMissingSourceTest {
    private final MediaTaskRepository tasks = mock(MediaTaskRepository.class);
    private final FileDiscoveryService service = new FileDiscoveryService(
            mock(WatchRuleRepository.class), tasks, mock(MediaProcessPipeline.class),
            mock(SettingsService.class), mock(EventPublisher.class),
            mock(MediaAssetDetectionService.class), mock(DiscoveryIgnoreService.class),
            mock(SampleVideoDetector.class));

    @Test
    void unavailableWatchRootDoesNotMarkAllPendingTasksMissing(@TempDir Path root) {
        WatchRule rule = new WatchRule();
        rule.setId(1L);
        rule.setSourceDir(root.resolve("未挂载的卷").toString());
        ReflectionTestUtils.invokeMethod(service, "runMissingSourceInspection", rule);
        verifyNoInteractions(tasks);
    }

    @Test
    void actuallyDeletedFileUnderAvailableRootIsStillReported(@TempDir Path root) {
        WatchRule rule = new WatchRule();
        rule.setId(1L);
        rule.setSourceDir(root.toString());
        MediaTask task = new MediaTask();
        task.setId(2L);
        task.setSourcePath(root.resolve("deleted.mkv").toString());
        task.setStatus(MediaTask.TaskStatus.AWAITING_CONFIRMATION);
        when(tasks.findByRuleIdAndStatusIn(eq(1L), any())).thenReturn(List.of(task));
        ReflectionTestUtils.invokeMethod(service, "runMissingSourceInspection", rule);
        assertThat(task.getStatus()).isEqualTo(MediaTask.TaskStatus.FAILED);
        assertThat(task.getErrorCode()).isEqualTo(MediaTask.TaskErrorCode.SOURCE_MISSING);
        verify(tasks).save(task);
    }

    @Test
    void delayedDeleteEventDoesNotFailAFileThatReappeared(@TempDir Path root) throws Exception {
        Path video = Files.writeString(root.resolve("01.mkv"), "video");
        ReflectionTestUtils.invokeMethod(service, "failTaskIfSourceMissing", video);
        verifyNoInteractions(tasks);
    }
}
