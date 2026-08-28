package com.mediamarshal.repository;

import com.mediamarshal.model.entity.TaskCorrectionBatchItem;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.stereotype.Repository;

import java.util.Collection;
import java.util.List;

@Repository
public interface TaskCorrectionBatchItemRepository extends JpaRepository<TaskCorrectionBatchItem, Long> {

    List<TaskCorrectionBatchItem> findByBatchIdOrderByExecutionOrderAsc(Long batchId);

    List<TaskCorrectionBatchItem> findByBatchIdAndStatusInOrderByExecutionOrderAsc(
            Long batchId,
            Collection<TaskCorrectionBatchItem.Status> statuses
    );

    boolean existsByOriginalTaskIdAndStatusIn(
            Long originalTaskId,
            Collection<TaskCorrectionBatchItem.Status> statuses
    );
}
