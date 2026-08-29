package com.mediamarshal.config;

import com.mediamarshal.service.correction.TaskCorrectionBatchRecoveryService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;

@Slf4j
@Component
@Order(40)
@RequiredArgsConstructor
public class TaskCorrectionBatchRecoveryRunner implements ApplicationRunner {

    private final TaskCorrectionBatchRecoveryService recoveryService;

    @Override
    public void run(ApplicationArguments args) {
        int interrupted = recoveryService.interruptActiveBatches();
        if (interrupted > 0) {
            log.warn("Marked unfinished correction batches as interrupted after startup: count={}", interrupted);
        }
    }
}
