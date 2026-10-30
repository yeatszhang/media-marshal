package com.mediamarshal.service.discovery;

import com.mediamarshal.model.entity.MediaAssetType;
import com.mediamarshal.model.entity.MediaTask;
import com.mediamarshal.model.entity.WatchRule;
import com.mediamarshal.repository.MediaTaskRepository;
import com.mediamarshal.repository.WatchRuleRepository;
import com.mediamarshal.service.discovery.asset.MediaAsset;
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
import java.util.Optional;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyCollection;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.*;

class FileDiscoveryIncrementalTest {
    @TempDir Path root;
    private final MediaTaskRepository tasks = mock(MediaTaskRepository.class);
    private final MediaProcessPipeline pipeline = mock(MediaProcessPipeline.class);
    private final MediaAssetDetectionService assets = mock(MediaAssetDetectionService.class);
    private final FileDiscoveryService service = new FileDiscoveryService(
            mock(WatchRuleRepository.class), tasks, pipeline, mock(SettingsService.class),
            mock(EventPublisher.class), assets, mock(DiscoveryIgnoreService.class), mock(SampleVideoDetector.class));

    private WatchRule rule() {
        WatchRule rule = new WatchRule();
        rule.setId(1L);
        rule.setSourceDir(root.toString());
        when(assets.detect(any(), eq(rule))).thenAnswer(call -> {
            Path path = call.getArgument(0);
            return path.toString().endsWith(".mkv")
                    ? Optional.of(new MediaAsset(path, MediaAssetType.VIDEO_FILE, path.getFileName().toString(), false))
                    : Optional.empty();
        });
        return rule;
    }

    private void scan(WatchRule rule, boolean full) {
        ReflectionTestUtils.invokeMethod(service, "runScan", root, rule, "rule:1", "测试扫描", false, full);
    }

    @Test
    void baselineAfterRestartSkipsHistoricalFailuresAndOnlyProcessesNewPaths() throws Exception {
        Path failed = Files.writeString(root.resolve("失败.mkv"), "视频");
        Path added = Files.writeString(root.resolve("新增.mkv"), "视频");
        WatchRule rule = rule();
        when(tasks.existsBySourcePath(failed.toString())).thenReturn(true);
        scan(rule, false);
        scan(rule, false);
        verify(pipeline, times(1)).process(any(MediaAsset.class), eq(rule));
        verify(pipeline).process(new MediaAsset(added, MediaAssetType.VIDEO_FILE, "新增.mkv", false), rule);
        verify(tasks, times(1)).existsBySourcePath(failed.toString());
        verify(tasks, times(1)).existsBySourcePath(added.toString());
        verify(tasks, never()).existsBySourcePathAndStatusIn(any(), anyCollection());
    }

    @Test
    void explicitFullScanRetriesFailureButStillSkipsCompletedFiles() throws Exception {
        Path failed = Files.writeString(root.resolve("失败.mkv"), "视频");
        Path done = Files.writeString(root.resolve("完成.mkv"), "视频");
        WatchRule rule = rule();
        when(tasks.existsBySourcePath(any())).thenReturn(true);
        when(tasks.existsBySourcePathAndStatusIn(eq(done.toString()), anyCollection())).thenReturn(true);
        scan(rule, false);
        verifyNoInteractions(pipeline);
        scan(rule, true);
        verify(pipeline, times(1)).process(any(MediaAsset.class), eq(rule));
        verify(pipeline).process(new MediaAsset(failed, MediaAssetType.VIDEO_FILE, "失败.mkv", false), rule);
        verify(tasks).existsBySourcePathAndStatusIn(failed.toString(), List.of(
                MediaTask.TaskStatus.PENDING, MediaTask.TaskStatus.PROCESSING,
                MediaTask.TaskStatus.AWAITING_CONFIRMATION, MediaTask.TaskStatus.DONE, MediaTask.TaskStatus.SKIPPED));
    }

    @Test
    void repeatedWatchEventDoesNotRetryFailedPath() throws Exception {
        Path failed = Files.writeString(root.resolve("失败.mkv"), "视频");
        WatchRule rule = rule();
        when(tasks.existsBySourcePath(failed.toString())).thenReturn(true);
        ReflectionTestUtils.invokeMethod(service, "processDetectedPathIfNotDuplicated", failed, rule);
        verifyNoInteractions(pipeline);
    }
}
