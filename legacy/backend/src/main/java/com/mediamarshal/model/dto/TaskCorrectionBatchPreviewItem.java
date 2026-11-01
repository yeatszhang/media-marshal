package com.mediamarshal.model.dto;

import java.util.List;

public record TaskCorrectionBatchPreviewItem(
        Long taskId,
        Integer season,
        Integer episode,
        Integer episodeEnd,
        String currentTargetPath,
        String correctedTargetPath,
        boolean sameTargetPath,
        int associatedFileCount,
        List<TaskCorrectionOperation> operations,
        List<String> blockers,
        List<String> warnings,
        boolean selected
) {
}
