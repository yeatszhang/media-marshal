package com.mediamarshal.service.correction;

import com.mediamarshal.model.entity.TaskCorrectionBatchItem;
import com.mediamarshal.repository.TaskCorrectionBatchItemRepository;
import org.junit.jupiter.api.Test;

import java.util.Collection;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

class TaskCorrectionConcurrencyGuardTest {

    @Test
    void blocksSingleCorrectionWhenTaskHasActiveBatchReservation() {
        TaskCorrectionBatchItemRepository repository = mock(TaskCorrectionBatchItemRepository.class);
        when(repository.existsByOriginalTaskIdAndStatusIn(eq(7L), any(Collection.class))).thenReturn(true);
        TaskCorrectionConcurrencyGuard guard = new TaskCorrectionConcurrencyGuard(repository);

        assertThatThrownBy(() -> guard.executeSingle(7L, () -> "unexpected"))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("批量修正作业占用");
    }

    @Test
    void allowsReservationAfterEarlierBatchItemReachedFinalState() {
        TaskCorrectionBatchItemRepository repository = mock(TaskCorrectionBatchItemRepository.class);
        when(repository.existsByOriginalTaskIdAndStatusIn(eq(7L), any(Collection.class))).thenReturn(false);
        TaskCorrectionConcurrencyGuard guard = new TaskCorrectionConcurrencyGuard(repository);

        String result = guard.createReservations(java.util.List.of(7L), () -> "reserved");

        assertThat(result).isEqualTo("reserved");
    }
}
