package com.mediamarshal.controller;

import com.mediamarshal.model.dto.ApiResponse;
import com.mediamarshal.model.dto.TaskCorrectionApplyResponse;
import com.mediamarshal.model.dto.TaskCorrectionBatchPreview;
import com.mediamarshal.model.dto.TaskCorrectionBatchRequest;
import com.mediamarshal.model.dto.TaskCorrectionPreview;
import com.mediamarshal.model.dto.TaskCorrectionRematchResponse;
import com.mediamarshal.model.dto.TaskCorrectionRequest;
import com.mediamarshal.model.dto.TaskCorrectionScopesResponse;
import com.mediamarshal.service.correction.TaskCorrectionBatchPreviewService;
import com.mediamarshal.service.correction.TaskCorrectionScopeService;
import com.mediamarshal.service.correction.TaskCorrectionService;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@Slf4j
@RestController
@RequestMapping("/api/tasks/{id}/correction")
@RequiredArgsConstructor
public class TaskCorrectionController {

    private final TaskCorrectionService taskCorrectionService;
    private final TaskCorrectionScopeService taskCorrectionScopeService;
    private final TaskCorrectionBatchPreviewService batchPreviewService;

    @GetMapping("/scopes")
    public ApiResponse<TaskCorrectionScopesResponse> scopes(@PathVariable Long id) {
        try {
            return ApiResponse.ok(taskCorrectionScopeService.getScopes(id));
        } catch (Exception e) {
            log.warn("Task correction scopes failed: taskId={}, error={}", id, e.getMessage());
            return ApiResponse.fail(e.getMessage());
        }
    }

    @PostMapping("/batch/preview")
    public ApiResponse<TaskCorrectionBatchPreview> previewBatch(
            @PathVariable Long id,
            @RequestBody TaskCorrectionBatchRequest request
    ) {
        try {
            return ApiResponse.ok(batchPreviewService.preview(id, request));
        } catch (Exception e) {
            log.warn("Task correction batch preview failed: taskId={}, error={}", id, e.getMessage());
            return ApiResponse.fail(e.getMessage());
        }
    }

    @PostMapping("/rematch")
    public ApiResponse<TaskCorrectionRematchResponse> rematch(
            @PathVariable Long id,
            @RequestBody TaskCorrectionRequest request
    ) {
        try {
            return ApiResponse.ok(taskCorrectionService.rematch(id, request));
        } catch (Exception e) {
            log.warn("Task correction rematch failed: taskId={}, error={}", id, e.getMessage());
            return ApiResponse.fail(e.getMessage());
        }
    }

    @PostMapping("/preview")
    public ApiResponse<TaskCorrectionPreview> preview(
            @PathVariable Long id,
            @RequestBody TaskCorrectionRequest request
    ) {
        try {
            return ApiResponse.ok(taskCorrectionService.preview(id, request));
        } catch (Exception e) {
            log.warn("Task correction preview failed: taskId={}, error={}", id, e.getMessage());
            return ApiResponse.fail(e.getMessage());
        }
    }

    @PostMapping("/apply")
    public ApiResponse<TaskCorrectionApplyResponse> apply(
            @PathVariable Long id,
            @RequestBody TaskCorrectionRequest request
    ) {
        try {
            return ApiResponse.ok(taskCorrectionService.apply(id, request));
        } catch (Exception e) {
            log.warn("Task correction apply failed: taskId={}, error={}", id, e.getMessage());
            return ApiResponse.fail(e.getMessage());
        }
    }
}
