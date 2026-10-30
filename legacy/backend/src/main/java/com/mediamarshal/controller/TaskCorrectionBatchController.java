package com.mediamarshal.controller;

import com.mediamarshal.model.dto.ApiResponse;
import com.mediamarshal.model.dto.TaskCorrectionBatchApplyResponse;
import com.mediamarshal.model.dto.TaskCorrectionBatchResponse;
import com.mediamarshal.service.correction.TaskCorrectionBatchService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Slf4j
@RestController
@RequestMapping("/api/task-correction-batches")
@RequiredArgsConstructor
public class TaskCorrectionBatchController {

    private final TaskCorrectionBatchService batchService;

    @GetMapping("/{batchId}")
    public ApiResponse<TaskCorrectionBatchResponse> get(@PathVariable Long batchId) {
        try {
            return ApiResponse.ok(batchService.get(batchId));
        } catch (Exception e) {
            log.warn("Task correction batch query failed: batchId={}, error={}", batchId, e.getMessage());
            return ApiResponse.fail(e.getMessage());
        }
    }

    @PostMapping("/{batchId}/retry-failed")
    public ApiResponse<TaskCorrectionBatchApplyResponse> retryFailed(@PathVariable Long batchId) {
        try {
            return ApiResponse.ok(batchService.retryFailed(batchId));
        } catch (Exception e) {
            log.warn("Task correction batch retry failed: batchId={}, error={}", batchId, e.getMessage());
            return ApiResponse.fail(e.getMessage());
        }
    }
}
