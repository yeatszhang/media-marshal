package com.mediamarshal.service.correction;

import jakarta.annotation.PreDestroy;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Component;

import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/** Single-instance serial queue used by persisted correction jobs. */
@Slf4j
@Component
class TaskCorrectionBatchExecutor {

    private final ExecutorService executor = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "task-correction-batch");
        thread.setDaemon(true);
        return thread;
    });

    void submit(Long batchId, Runnable work) {
        executor.submit(() -> {
            try {
                work.run();
            } catch (RuntimeException e) {
                log.error("Correction batch worker failed unexpectedly: batchId={}", batchId, e);
            }
        });
    }

    @PreDestroy
    void shutdown() {
        executor.shutdown();
        try {
            if (!executor.awaitTermination(10, TimeUnit.SECONDS)) {
                executor.shutdownNow();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            executor.shutdownNow();
        }
    }
}
