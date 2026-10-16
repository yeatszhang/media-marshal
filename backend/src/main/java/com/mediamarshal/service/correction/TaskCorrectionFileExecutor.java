package com.mediamarshal.service.correction;

import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.List;

/**
 * Executes a prepared correction plan without holding a database transaction.
 * The returned execution journal is retained until persistence succeeds so callers can compensate on failure.
 */
@Slf4j
@Component
class TaskCorrectionFileExecutor {

    TaskCorrectionFileExecution execute(TaskCorrectionPlan plan) {
        List<TaskCorrectionFileMove> executedMoves = new ArrayList<>();
        try {
            for (TaskCorrectionFileMove move : plan.moves()) {
                movePath(move.source(), move.target());
                executedMoves.add(move);
            }
            return new TaskCorrectionFileExecution(List.copyOf(executedMoves));
        } catch (Exception e) {
            List<String> rollbackFailures = rollback(new TaskCorrectionFileExecution(List.copyOf(executedMoves)));
            String rollbackMessage = rollbackFailures.isEmpty()
                    ? ""
                    : "；部分文件回滚失败：" + String.join("；", rollbackFailures);
            throw new IllegalStateException("修正文件操作失败，数据库记录未更新：" + e.getMessage() + rollbackMessage, e);
        }
    }

    List<String> rollback(TaskCorrectionFileExecution execution) {
        List<String> failures = new ArrayList<>();
        List<TaskCorrectionFileMove> moves = execution.executedMoves();
        for (int i = moves.size() - 1; i >= 0; i--) {
            TaskCorrectionFileMove move = moves.get(i);
            try {
                if (Files.exists(move.target(), LinkOption.NOFOLLOW_LINKS)
                        && !Files.exists(move.source(), LinkOption.NOFOLLOW_LINKS)) {
                    movePath(move.target(), move.source());
                }
            } catch (IOException rollbackError) {
                String failure = move.target() + " -> " + move.source() + "：" + rollbackError.getMessage();
                failures.add(failure);
                log.warn("Failed to rollback correction move: target={}, source={}, error={}",
                        move.target(), move.source(), rollbackError.getMessage());
            }
        }
        return failures;
    }

    void cleanupEmptyTargetDirs(Path startDir, Path stopDir, List<String> warnings) {
        if (startDir == null || stopDir == null) {
            return;
        }
        Path current = startDir.toAbsolutePath().normalize();
        Path stop = stopDir.toAbsolutePath().normalize();
        while (current.startsWith(stop) && !current.equals(stop)) {
            try (var stream = Files.list(current)) {
                if (stream.findAny().isPresent()) {
                    return;
                }
            } catch (IOException e) {
                log.warn("Failed to inspect empty target directory: dir={}, error={}", current, e.getMessage());
                warnings.add("旧目标空目录清理失败：" + current);
                return;
            }

            try {
                Files.delete(current);
                log.info("Empty target directory deleted after correction: {}", current);
            } catch (IOException e) {
                log.warn("Failed to delete empty target directory: dir={}, error={}", current, e.getMessage());
                warnings.add("旧目标空目录清理失败：" + current);
                return;
            }
            current = current.getParent();
            if (current == null) {
                return;
            }
        }
    }

    private void movePath(Path source, Path target) throws IOException {
        Path parent = target.getParent();
        if (parent != null) {
            Files.createDirectories(parent);
        }
        try {
            Files.move(source, target, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException e) {
            Files.move(source, target);
        }
    }
}
