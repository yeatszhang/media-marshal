package com.mediamarshal.service.correction;

import com.mediamarshal.model.entity.TaskCorrectionBatchItem;
import com.mediamarshal.repository.TaskCorrectionBatchItemRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;

import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Supplier;

/** Coordinates synchronous corrections and persisted batch reservations in this single-instance application. */
@Component
@RequiredArgsConstructor
class TaskCorrectionConcurrencyGuard {

    private static final List<TaskCorrectionBatchItem.Status> ACTIVE_ITEM_STATUSES = List.of(
            TaskCorrectionBatchItem.Status.PENDING,
            TaskCorrectionBatchItem.Status.RUNNING
    );

    private final TaskCorrectionBatchItemRepository itemRepository;
    private final ReentrantLock coordinationLock = new ReentrantLock();
    private final Map<Long, ReentrantLock> taskLocks = new ConcurrentHashMap<>();

    <T> T executeSingle(Long taskId, Supplier<T> action) {
        ReentrantLock taskLock;
        coordinationLock.lock();
        try {
            if (hasActiveReservation(taskId)) {
                throw new IllegalStateException("任务已被批量修正作业占用：" + taskId);
            }
            taskLock = acquireTaskLock(taskId);
        } finally {
            coordinationLock.unlock();
        }
        return executeWithHeldLock(taskId, taskLock, action);
    }

    <T> T createReservations(Collection<Long> taskIds, Supplier<T> action) {
        coordinationLock.lock();
        try {
            for (Long taskId : taskIds) {
                ReentrantLock localLock = taskLocks.get(taskId);
                if ((localLock != null && localLock.isLocked()) || hasActiveReservation(taskId)) {
                    throw new IllegalStateException("任务已被其它修正操作占用：" + taskId);
                }
            }
            return action.get();
        } finally {
            coordinationLock.unlock();
        }
    }

    <T> T executeReserved(Long taskId, Supplier<T> action) {
        ReentrantLock taskLock;
        coordinationLock.lock();
        try {
            taskLock = acquireTaskLock(taskId);
        } finally {
            coordinationLock.unlock();
        }
        return executeWithHeldLock(taskId, taskLock, action);
    }

    private boolean hasActiveReservation(Long taskId) {
        return itemRepository.existsByOriginalTaskIdAndStatusIn(taskId, ACTIVE_ITEM_STATUSES);
    }

    private ReentrantLock acquireTaskLock(Long taskId) {
        ReentrantLock taskLock = taskLocks.computeIfAbsent(taskId, ignored -> new ReentrantLock());
        if (!taskLock.tryLock()) {
            throw new IllegalStateException("任务正在执行其它修正操作：" + taskId);
        }
        return taskLock;
    }

    private <T> T executeWithHeldLock(Long taskId, ReentrantLock taskLock, Supplier<T> action) {
        try {
            return action.get();
        } finally {
            taskLock.unlock();
            coordinationLock.lock();
            try {
                if (!taskLock.isLocked() && !taskLock.hasQueuedThreads()) {
                    taskLocks.remove(taskId, taskLock);
                }
            } finally {
                coordinationLock.unlock();
            }
        }
    }
}
