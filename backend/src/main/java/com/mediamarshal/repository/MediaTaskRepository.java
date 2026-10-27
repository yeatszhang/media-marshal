package com.mediamarshal.repository;

import com.mediamarshal.model.entity.MediaTask;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

@Repository
public interface MediaTaskRepository extends JpaRepository<MediaTask, Long> {

    List<MediaTask> findByStatus(MediaTask.TaskStatus status);

    List<MediaTask> findByStatusOrderByCreatedAtDesc(MediaTask.TaskStatus status);

    List<MediaTask> findByStatusAndMediaTypeAndTmdbIdAndRuleId(
            MediaTask.TaskStatus status,
            MediaTask.MediaType mediaType,
            Long tmdbId,
            Long ruleId
    );

    List<MediaTask> findByStatusAndMediaTypeAndTmdbIdAndRuleIdAndParsedSeason(
            MediaTask.TaskStatus status,
            MediaTask.MediaType mediaType,
            Long tmdbId,
            Long ruleId,
            Integer parsedSeason
    );

    boolean existsBySourcePath(String sourcePath);

    /**
     * 手动全量补扫的有效任务查重（沿用 ADR-028）：
     * PENDING / PROCESSING / AWAITING_CONFIRMATION / DONE / SKIPPED 视为有效记录；
     * FAILED / CORRECTED 只保留历史，允许用户主动补扫；自动发现使用 existsBySourcePath，
     * 避免历史失败在周期扫描和文件修改事件中反复触发识别。
     */
    boolean existsBySourcePathAndStatusIn(String sourcePath, Collection<MediaTask.TaskStatus> statuses);

    Optional<MediaTask> findBySourcePath(String sourcePath);

    List<MediaTask> findByRuleIdAndStatusIn(Long ruleId, Collection<MediaTask.TaskStatus> statuses);

    Optional<MediaTask> findFirstBySourcePathAndRuleIdAndStatusAndErrorCodeOrderByUpdatedAtDesc(
            String sourcePath,
            Long ruleId,
            MediaTask.TaskStatus status,
            MediaTask.TaskErrorCode errorCode
    );
}
