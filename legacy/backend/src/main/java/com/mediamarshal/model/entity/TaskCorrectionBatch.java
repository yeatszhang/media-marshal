package com.mediamarshal.model.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import lombok.Data;

import java.time.LocalDateTime;

@Data
@Entity
@Table(name = "task_correction_batch")
public class TaskCorrectionBatch {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false)
    private Long anchorTaskId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 30)
    private Scope scope;

    @Column(nullable = false)
    private Long originalTmdbId;

    @Column(nullable = false)
    private Long targetTmdbId;

    @Column(nullable = false)
    private Long ruleId;

    @Column(nullable = false)
    private String parsedTitle;

    private Integer parsedYear;

    @Column(nullable = false)
    private boolean regenerateNfo;

    @Column(nullable = false, length = 64)
    private String groupFingerprint;

    @Column(nullable = false, unique = true, length = 100)
    private String idempotencyKey;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false, length = 30)
    private Status status = Status.QUEUED;

    @Column(nullable = false)
    private int totalCount;

    @Column(nullable = false)
    private int successCount;

    @Column(nullable = false)
    private int failedCount;

    @Column(nullable = false)
    private int excludedCount;

    @Column(columnDefinition = "TEXT")
    private String errorMessage;

    @Column(nullable = false, updatable = false)
    private LocalDateTime createdAt;

    private LocalDateTime startedAt;

    private LocalDateTime completedAt;

    private LocalDateTime updatedAt;

    @PrePersist
    protected void onCreate() {
        createdAt = LocalDateTime.now();
        updatedAt = createdAt;
    }

    @PreUpdate
    protected void onUpdate() {
        updatedAt = LocalDateTime.now();
    }

    public enum Scope {
        SAME_SEASON,
        SAME_SERIES
    }

    public enum Status {
        QUEUED,
        RUNNING,
        SUCCEEDED,
        PARTIAL_FAILED,
        FAILED,
        INTERRUPTED
    }
}
