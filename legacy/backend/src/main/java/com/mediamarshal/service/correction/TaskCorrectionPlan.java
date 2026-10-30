package com.mediamarshal.service.correction;

import com.mediamarshal.model.dto.MatchResult;
import com.mediamarshal.model.dto.TaskCorrectionPreview;
import com.mediamarshal.model.entity.MediaTask;

import java.nio.file.Path;
import java.util.List;

record TaskCorrectionPlan(
        MediaTask originalTask,
        MediaTask correctedTask,
        MatchResult selectedMatch,
        Path correctedTarget,
        List<TaskCorrectionFileMove> moves,
        Path cleanupStartDir,
        Path cleanupStopDir,
        boolean regenerateNfo,
        TaskCorrectionPreview preview
) {
}
