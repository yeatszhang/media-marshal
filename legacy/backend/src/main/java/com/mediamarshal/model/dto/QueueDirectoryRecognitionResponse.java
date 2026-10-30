package com.mediamarshal.model.dto;

import java.util.List;

public record QueueDirectoryRecognitionResponse(String directory, List<QueueRecognitionResponse> updated,
                                                 List<SkippedTask> skipped) {
    public record SkippedTask(Long taskId, String reason) {}
}
