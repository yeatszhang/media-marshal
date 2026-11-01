package com.mediamarshal.model.dto;

import lombok.Data;

import java.util.List;

@Data
public class TaskCorrectionBatchRequest {
    private String scope;
    private String parsedTitle;
    private Integer parsedYear;
    private Long tmdbId;
    private Boolean regenerateNfo;
    private List<Long> excludedTaskIds = List.of();
    private String groupFingerprint;
    private String idempotencyKey;
}
