package com.mediamarshal.model.dto;

import java.util.List;

public record TaskCorrectionBatchPreview(
        String scope,
        int totalCount,
        int selectedCount,
        int applicableCount,
        int blockerCount,
        int warningCount,
        boolean canApply,
        String groupFingerprint,
        MatchResult selectedMatch,
        List<String> blockers,
        List<String> warnings,
        List<TaskCorrectionBatchPreviewItem> items
) {
}
