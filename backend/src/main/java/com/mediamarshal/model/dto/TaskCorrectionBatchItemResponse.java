package com.mediamarshal.model.dto;

import java.time.LocalDateTime;

public record TaskCorrectionBatchItemResponse(
        Long id,
        Long originalTaskId,
        Long correctedTaskId,
        Integer season,
        Integer episode,
        Integer episodeEnd,
        String currentTargetPath,
        String correctedTargetPath,
        String status,
        int executionOrder,
        int retryCount,
        String errorMessage,
        String recoveryDetails,
        LocalDateTime startedAt,
        LocalDateTime completedAt
) {
}
