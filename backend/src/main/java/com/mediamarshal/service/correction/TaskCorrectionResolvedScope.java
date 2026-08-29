package com.mediamarshal.service.correction;

import com.mediamarshal.model.entity.MediaTask;
import com.mediamarshal.model.entity.TaskCorrectionBatch;

import java.util.List;

record TaskCorrectionResolvedScope(
        MediaTask anchor,
        TaskCorrectionBatch.Scope scope,
        List<MediaTask> tasks,
        String groupFingerprint
) {
}
