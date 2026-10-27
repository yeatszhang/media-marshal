package com.mediamarshal.service.discovery;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class IncrementalDirectoryScannerTest {
    @TempDir Path root;
    private final IncrementalDirectoryScanner scanner = new IncrementalDirectoryScanner();
    private final List<Path> files = new ArrayList<>();
    private final List<Path> directories = new ArrayList<>();
    private long changedTimestamp = System.currentTimeMillis();

    private void scan(boolean fullScan) throws Exception {
        scanner.scan(root, fullScan, path -> false, dir -> {
            directories.add(dir);
            return false;
        }, files::add);
    }

    private void changed(Path dir) throws Exception {
        // 文件系统会在增删时重置 mtime，不能基于当前值重复生成相同的测试时间。
        changedTimestamp = Math.max(changedTimestamp, Files.getLastModifiedTime(dir).toMillis()) + 2000;
        Files.setLastModifiedTime(dir, FileTime.fromMillis(changedTimestamp));
    }

    @Test
    void unchangedTreeDoesNotVisitOldFilesOrDetectAssetsAgain() throws Exception {
        Path season = Files.createDirectories(root.resolve("作品/S01"));
        Path video = Files.writeString(season.resolve("01.mkv"), "视频");
        scan(false);
        assertThat(files).containsExactly(video);
        files.clear();
        directories.clear();
        scan(false);
        assertThat(files).isEmpty();
        assertThat(directories).isEmpty();
    }

    @Test
    void deepAdditionIsFoundEvenWhenRootTimestampDoesNotChange() throws Exception {
        Path season = Files.createDirectories(root.resolve("作品/S01"));
        Files.writeString(season.resolve("01.mkv"), "视频");
        scan(false);
        files.clear();
        FileTime rootTime = Files.getLastModifiedTime(root);
        Path added = Files.writeString(season.resolve("02.mkv"), "新增");
        changed(season);
        assertThat(Files.getLastModifiedTime(root)).isEqualTo(rootTime);
        scan(false);
        assertThat(files).containsExactly(added);
    }

    @Test
    void movedInDirectoryIsDiscoveredRecursively() throws Exception {
        scan(false);
        Path season = Files.createDirectories(root.resolve("新作品/S02"));
        Path added = Files.writeString(season.resolve("03.mkv"), "视频");
        changed(root);
        scan(false);
        assertThat(files).containsExactly(added);
    }

    @Test
    void fullScanVisitsKnownFilesForExplicitRetry() throws Exception {
        Path video = Files.writeString(root.resolve("01.mkv"), "视频");
        scan(false);
        files.clear();
        scan(true);
        assertThat(files).containsExactly(video);
    }

    @Test
    void deletionsAndLaterAdditionsDoNotLeaveStaleChildren() throws Exception {
        Path season = Files.createDirectory(root.resolve("S01"));
        Path video = Files.writeString(season.resolve("01.mkv"), "视频");
        scan(false);
        files.clear();
        Files.delete(video);
        Files.delete(season);
        changed(root);
        scan(false);
        assertThat(files).isEmpty();
        Files.createDirectory(season);
        Files.writeString(video, "新视频");
        changed(root);
        scan(false);
        assertThat(files).containsExactly(video);
    }

    @Test
    void ignoredAndPrunedDirectoriesDoNotExposeInternalVideos() throws Exception {
        Path ignored = Files.createDirectory(root.resolve("忽略"));
        Path bluray = Files.createDirectory(root.resolve("原盘"));
        Files.writeString(ignored.resolve("01.mkv"), "视频");
        Files.writeString(bluray.resolve("stream.m2ts"), "视频");
        scanner.scan(root, false, ignored::equals, bluray::equals, files::add);
        assertThat(files).isEmpty();
        scan(false);
        // 原盘已剪枝；忽略目录不会进入索引，下轮取消忽略后可正常发现。
        assertThat(files).containsExactly(ignored.resolve("01.mkv"));
    }

    @Test
    void symlinkDirectoryDoesNotEscapeSourceTree(@TempDir Path outside) throws Exception {
        Files.writeString(outside.resolve("外部.mkv"), "视频");
        Path link = Files.createSymbolicLink(root.resolve("链接"), outside);
        scan(false);
        assertThat(files).containsExactly(link);
        assertThat(directories).isEmpty();
    }

    @Test
    void failedVisitIsNotCheckpointedAsSuccessfullyDiscovered() throws Exception {
        Path video = Files.writeString(root.resolve("01.mkv"), "视频");
        assertThatThrownBy(() -> scanner.scan(root, false, path -> false, path -> false,
                file -> { throw new IllegalStateException("入队失败"); }))
                .isInstanceOf(IllegalStateException.class);
        scan(false);
        assertThat(files).containsExactly(video);
    }
}
