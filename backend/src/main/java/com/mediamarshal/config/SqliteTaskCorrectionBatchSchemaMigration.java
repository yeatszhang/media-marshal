package com.mediamarshal.config;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.core.annotation.Order;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Component;

@Slf4j
@Component
@Order(30)
@RequiredArgsConstructor
public class SqliteTaskCorrectionBatchSchemaMigration implements ApplicationRunner {

    private final JdbcTemplate jdbcTemplate;

    @Override
    public void run(ApplicationArguments args) {
        jdbcTemplate.execute("""
                create table if not exists task_correction_batch (
                    id integer primary key autoincrement,
                    anchor_task_id bigint not null,
                    scope varchar(30) not null,
                    original_tmdb_id bigint not null,
                    target_tmdb_id bigint not null,
                    rule_id bigint not null,
                    parsed_title varchar(255) not null,
                    parsed_year integer,
                    regenerate_nfo boolean not null,
                    group_fingerprint varchar(64) not null,
                    idempotency_key varchar(100) not null,
                    status varchar(30) not null,
                    total_count integer not null,
                    success_count integer not null,
                    failed_count integer not null,
                    excluded_count integer not null,
                    error_message text,
                    created_at timestamp not null,
                    started_at timestamp,
                    completed_at timestamp,
                    updated_at timestamp
                )
                """);
        jdbcTemplate.execute("""
                create table if not exists task_correction_batch_item (
                    id integer primary key autoincrement,
                    batch_id bigint not null,
                    original_task_id bigint not null,
                    corrected_task_id bigint,
                    season integer,
                    episode integer,
                    episode_end integer,
                    current_target_path varchar(1000) not null,
                    corrected_target_path varchar(1000),
                    status varchar(20) not null,
                    execution_order integer not null,
                    retry_count integer not null,
                    error_message text,
                    recovery_details text,
                    created_at timestamp not null,
                    started_at timestamp,
                    completed_at timestamp,
                    updated_at timestamp
                )
                """);
        jdbcTemplate.execute("""
                create unique index if not exists uq_task_correction_batch_idempotency
                on task_correction_batch(idempotency_key)
                """);
        jdbcTemplate.execute("""
                create unique index if not exists uq_task_correction_batch_item_task
                on task_correction_batch_item(batch_id, original_task_id)
                """);
        jdbcTemplate.execute("""
                create unique index if not exists uq_task_correction_batch_item_active
                on task_correction_batch_item(original_task_id)
                where status in ('PENDING', 'RUNNING')
                """);
        jdbcTemplate.execute("""
                create index if not exists idx_task_correction_batch_item_batch_order
                on task_correction_batch_item(batch_id, execution_order)
                """);
        log.debug("ADR-030 correction batch schema verified");
    }
}
