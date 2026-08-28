package com.mediamarshal.model.dto;

import java.time.LocalDateTime;
import java.util.List;

public record TaskCorrectionBatchResponse(
        Long id,
        Long anchorTaskId,
        String scope,
        Long originalTmdbId,
        Long targetTmdbId,
        Long ruleId,
        String parsedTitle,
        Integer parsedYear,
        boolean regenerateNfo,
        String groupFingerprint,
        String status,
        int totalCount,
        int successCount,
        int failedCount,
        int excludedCount,
        String errorMessage,
        LocalDateTime createdAt,
        LocalDateTime startedAt,
        LocalDateTime completedAt,
        TaskCorrectionBatchItemResponse currentItem,
        List<TaskCorrectionBatchItemResponse> items
) {
}
