package com.mediamarshal.service.correction;

import com.mediamarshal.model.dto.MatchResult;
import com.mediamarshal.model.dto.TaskCorrectionApplyResponse;
import com.mediamarshal.model.entity.MediaTask;
import com.mediamarshal.model.entity.TaskCandidate;
import com.mediamarshal.repository.MediaTaskRepository;
import com.mediamarshal.repository.TaskCandidateRepository;
import jakarta.transaction.Transactional;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.time.LocalDateTime;
import java.util.List;

/**
 * Persists one correction history pair in a short transaction after file operations have completed.
 */
@Service
@RequiredArgsConstructor
class TaskCorrectionPersistenceService {

    private final MediaTaskRepository taskRepository;
    private final TaskCandidateRepository candidateRepository;

    @Transactional
    TaskCorrectionApplyResponse persist(TaskCorrectionPlan plan) {
        MediaTask currentOriginal = taskRepository.findById(plan.originalTask().getId())
                .orElseThrow(() -> new IllegalStateException("原修正任务不存在：" + plan.originalTask().getId()));
        if (!MediaTask.TaskStatus.DONE.equals(currentOriginal.getStatus())) {
            throw new IllegalStateException("原修正任务状态已变化，请重新预览");
        }

        MediaTask correctedTask = taskRepository.saveAndFlush(plan.correctedTask());
        saveSelectedCandidate(correctedTask, plan.selectedMatch());

        currentOriginal.setStatus(MediaTask.TaskStatus.CORRECTED);
        currentOriginal.setCorrectedToTaskId(correctedTask.getId());
        currentOriginal.setCorrectedAt(LocalDateTime.now());
        currentOriginal = taskRepository.saveAndFlush(currentOriginal);

        correctedTask.setUpdatedAt(LocalDateTime.now());
        correctedTask = taskRepository.saveAndFlush(correctedTask);
        return new TaskCorrectionApplyResponse(currentOriginal, correctedTask, plan.preview());
    }

    private void saveSelectedCandidate(MediaTask task, MatchResult match) {
        TaskCandidate candidate = new TaskCandidate();
        candidate.setTask(task);
        candidate.setTmdbId(Long.valueOf(match.getSourceId()));
        candidate.setTitle(match.getTitle());
        candidate.setOriginalTitle(match.getOriginalTitle());
        candidate.setYear(match.getYear());
        candidate.setMediaType(MediaTask.MediaType.valueOf(match.getMediaType()));
        candidate.setConfidence(match.getConfidence());
        candidate.setPosterUrl(match.getPosterUrl());
        candidate.setOverview(match.getOverview());
        candidate.setGenre1(genreAt(match, 0));
        candidate.setGenre2(genreAt(match, 1));
        candidate.setGenre3(genreAt(match, 2));
        candidate.setGenre4(genreAt(match, 3));
        candidate.setCountry(match.getCountry());
        candidate.setEpisodeTitle(match.getEpisodeTitle());
        candidate.setRank(1);
        candidate.setSelected(true);
        candidateRepository.save(candidate);
    }

    private String genreAt(MatchResult match, int index) {
        List<String> genres = match.getGenres();
        if (genres == null || genres.size() <= index) {
            return null;
        }
        String value = genres.get(index);
        return value == null || value.isBlank() ? null : value;
    }
}
