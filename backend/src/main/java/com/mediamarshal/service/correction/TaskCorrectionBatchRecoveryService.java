package com.mediamarshal.service.correction;

import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

@Service
@RequiredArgsConstructor
public class TaskCorrectionBatchRecoveryService {

    private final TaskCorrectionBatchStateService stateService;

    public int interruptActiveBatches() {
        return stateService.interruptActiveBatches();
    }
}
