package com.mediamarshal.repository;

import com.mediamarshal.model.entity.TaskCorrectionBatch;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;

@Repository
public interface TaskCorrectionBatchRepository extends JpaRepository<TaskCorrectionBatch, Long> {

    Optional<TaskCorrectionBatch> findByIdempotencyKey(String idempotencyKey);

    List<TaskCorrectionBatch> findByStatusIn(Collection<TaskCorrectionBatch.Status> statuses);
}
