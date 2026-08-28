package com.mediamarshal.model.dto;

import java.util.List;

public record TaskCorrectionScopesResponse(
        Long anchorTaskId,
        boolean batchSupported,
        int singleCount,
        int sameSeasonCount,
        int sameSeriesCount,
        Integer currentSeason,
        Integer minSeason,
        Integer maxSeason,
        List<String> warnings,
        List<String> unsupportedReasons
) {
}
