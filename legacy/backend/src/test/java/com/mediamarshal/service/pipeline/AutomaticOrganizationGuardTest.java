package com.mediamarshal.service.pipeline;

import com.mediamarshal.model.entity.MediaTask;
import com.mediamarshal.repository.MediaTaskRepository;
import com.mediamarshal.service.discovery.asset.VideoFileAssetDetector;
import com.mediamarshal.service.parser.GuessitParserClient;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.*;

class AutomaticOrganizationGuardTest {
    private final MediaTaskRepository repository = mock(MediaTaskRepository.class);
    private final GuessitParserClient parser = mock(GuessitParserClient.class);
    private final AutomaticOrganizationGuard guard = new AutomaticOrganizationGuard(repository, parser, new VideoFileAssetDetector());

    @Test
    void detectsUnqueuedAnimeHashCopyBeforeTheFirstCopyMoves(@TempDir Path root) throws Exception {
        Path folder = Files.createDirectories(root.resolve("S03"));
        MediaTask task = task(Files.writeString(folder.resolve("[BeanSub&FZSD][Jujutsu_Kaisen][49][GB][1080P][x264_AAC].mp4"), "视频"), 3, 49, null);
        Path copy = Files.writeString(folder.resolve("[BeanSub&FZSD][Jujutsu_Kaisen][49][GB][1080P][x264_AAC]-4439f0c824f5.mp4"), "副本");
        assertThat(guard.conflicts(List.of(task), Map.of(1L, root.resolve("library/49.mp4"))).get(1L))
                .contains("S03E49", copy.getFileName().toString(), Path.of(task.getSourcePath()).getFileName().toString());
        verifyNoInteractions(parser);
    }

    @Test
    void detectsUnqueuedMergedEpisodeRangeButAllowsDifferentSeason(@TempDir Path root) throws Exception {
        MediaTask task = task(Files.writeString(root.resolve("Show.S01E03-E05.mkv"), "视频"), 1, 3, 5);
        Path overlap = Files.writeString(root.resolve("Show.S01E04-E06.mkv"), "合并集");
        Files.writeString(root.resolve("Show.S02E04.mkv"), "第二季");
        assertThat(guard.conflicts(List.of(task), Map.of()).get(1L)).contains("S01E04–E05");
        Files.delete(overlap);
        assertThat(guard.conflicts(List.of(task), Map.of())).isEmpty();
        verifyNoInteractions(parser);
    }

    @Test
    void directoryInspectionFailureIsActionableAndCannotPassSilently(@TempDir Path root) {
        MediaTask task = task(root.resolve("missing/01.mkv"), 1, 1, null);
        assertThat(guard.conflicts(List.of(task), Map.of()).get(1L))
                .contains("无法完成目录重复文件检查", "missing", "重试");
    }

    private MediaTask task(Path source, int season, int episode, Integer end) {
        MediaTask task = new MediaTask();
        task.setId(1L);
        task.setRuleId(9L);
        task.setSourcePath(source.toString());
        task.setMediaType(MediaTask.MediaType.TV_SHOW);
        task.setParsedSeason(season);
        task.setParsedEpisode(episode);
        task.setParsedEpisodeEnd(end);
        return task;
    }
}
