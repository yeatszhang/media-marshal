package com.mediamarshal.service.discovery;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.NoSuchFileException;
import java.nio.file.Path;
import java.nio.file.attribute.BasicFileAttributes;
import java.nio.file.attribute.FileTime;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.function.Consumer;
import java.util.function.Predicate;

/**
 * 缓存目录的直接子项。父目录时间不反映深层变动，因此每轮仍检查所有已知子目录，
 * 仅在目录自身发生变化时重新枚举文件；文件内容修改不触发作品重新识别。
 */
final class IncrementalDirectoryScanner {
    private final Map<Path, Snapshot> snapshots = new HashMap<>();

    synchronized void scan(Path root, boolean fullScan, Predicate<Path> ignored,
                          Predicate<Path> visitDirectory, Consumer<Path> visitFile) throws IOException {
        Path normalizedRoot = root.toAbsolutePath().normalize();
        Set<Path> visited = new HashSet<>();
        try {
            scanDirectory(normalizedRoot, fullScan, ignored, visitDirectory,
                    visitFile, visited, true);
        } finally {
            // 子目录被删除、变为忽略目录或变为原盘资产后，不能保留过期子树。
            snapshots.keySet().removeIf(path -> path.startsWith(normalizedRoot) && !visited.contains(path));
        }
    }

    private void scanDirectory(Path dir, boolean fullScan, Predicate<Path> ignored,
                               Predicate<Path> visitDirectory, Consumer<Path> visitFile,
                               Set<Path> visited, boolean root) throws IOException {
        if (!root && ignored.test(dir)) return;
        BasicFileAttributes attrs;
        try {
            attrs = Files.readAttributes(dir, BasicFileAttributes.class, LinkOption.NOFOLLOW_LINKS);
        } catch (NoSuchFileException removed) {
            return;
        }
        if (!attrs.isDirectory()) return;
        visited.add(dir);
        Snapshot previous = snapshots.get(dir);
        boolean changed = fullScan || previous == null
                || !previous.modified().equals(attrs.lastModifiedTime())
                || !Objects.equals(previous.fileKey(), attrs.fileKey());
        if (changed) {
            if (!root && visitDirectory.test(dir)) {
                snapshots.put(dir, new Snapshot(attrs.lastModifiedTime(), attrs.fileKey(), List.of(), Set.of()));
                return;
            }
            List<Path> directories = new ArrayList<>();
            Set<Path> files = new HashSet<>();
            // 先关闭目录流再调用流水线，避免模型等待期间占用目录句柄。
            try (var entries = Files.newDirectoryStream(dir)) {
                for (Path entry : entries) {
                    if (Files.isDirectory(entry, LinkOption.NOFOLLOW_LINKS)) directories.add(entry);
                    else files.add(entry);
                }
            }
            boolean replaced = previous != null && !Objects.equals(previous.fileKey(), attrs.fileKey());
            for (Path file : files.stream().sorted().toList()) {
                if (fullScan || previous == null || replaced || !previous.files().contains(file)) {
                    visitFile.accept(file);
                }
            }
            // 保存枚举前时间；扫描期间发生增删时，下一轮会重新枚举。
            previous = new Snapshot(attrs.lastModifiedTime(), attrs.fileKey(), List.copyOf(directories), Set.copyOf(files));
            snapshots.put(dir, previous);
        }
        for (Path child : previous.directories()) {
            scanDirectory(child, fullScan, ignored, visitDirectory, visitFile, visited, false);
        }
    }

    private record Snapshot(FileTime modified, Object fileKey, List<Path> directories, Set<Path> files) {}
}
