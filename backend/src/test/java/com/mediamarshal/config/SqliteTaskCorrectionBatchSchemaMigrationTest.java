package com.mediamarshal.config;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.sqlite.SQLiteDataSource;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;

import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class SqliteTaskCorrectionBatchSchemaMigrationTest {

    @TempDir
    Path tempDir;

    private JdbcTemplate jdbcTemplate;
    private SqliteTaskCorrectionBatchSchemaMigration migration;

    @BeforeEach
    void setUp() {
        SQLiteDataSource dataSource = new SQLiteDataSource();
        dataSource.setUrl("jdbc:sqlite:" + tempDir.resolve("media-marshal.db").toAbsolutePath());
        jdbcTemplate = new JdbcTemplate(dataSource);
        migration = new SqliteTaskCorrectionBatchSchemaMigration(jdbcTemplate);
    }

    @Test
    void createsBatchTablesAndIdempotencyConstraint() {
        migration.run(null);
        migration.run(null);

        assertThat(tableExists("task_correction_batch")).isTrue();
        assertThat(tableExists("task_correction_batch_item")).isTrue();
        insertBatch(1, "request-1");

        assertThatThrownBy(() -> insertBatch(2, "request-1"))
                .isInstanceOf(DataAccessException.class);
    }

    @Test
    void activeItemIndexPreventsTwoJobsFromReservingSameTask() {
        migration.run(null);
        insertBatch(1, "request-1");
        insertBatch(2, "request-2");
        insertItem(1, 1, 99, "PENDING");

        assertThatThrownBy(() -> insertItem(2, 2, 99, "PENDING"))
                .isInstanceOf(DataAccessException.class);

        jdbcTemplate.update("update task_correction_batch_item set status = 'FAILED' where id = 1");
        insertItem(2, 2, 99, "PENDING");
        assertThat(jdbcTemplate.queryForObject(
                "select count(*) from task_correction_batch_item where original_task_id = 99",
                Integer.class
        )).isEqualTo(2);
    }

    private boolean tableExists(String tableName) {
        Integer count = jdbcTemplate.queryForObject(
                "select count(*) from sqlite_master where type = 'table' and name = ?",
                Integer.class,
                tableName
        );
        return count != null && count == 1;
    }

    private void insertBatch(long id, String idempotencyKey) {
        jdbcTemplate.update("""
                insert into task_correction_batch (
                    id, anchor_task_id, scope, original_tmdb_id, target_tmdb_id, rule_id,
                    parsed_title, regenerate_nfo, group_fingerprint, idempotency_key, status,
                    total_count, success_count, failed_count, excluded_count, created_at
                ) values (?, 1, 'SAME_SERIES', 10, 20, 30, 'Show', 0, 'fingerprint', ?, 'QUEUED', 1, 0, 0, 0, current_timestamp)
                """, id, idempotencyKey);
    }

    private void insertItem(long id, long batchId, long taskId, String status) {
        jdbcTemplate.update("""
                insert into task_correction_batch_item (
                    id, batch_id, original_task_id, current_target_path, status,
                    execution_order, retry_count, created_at
                ) values (?, ?, ?, '/library/show.mkv', ?, 1, 0, current_timestamp)
                """, id, batchId, taskId, status);
    }
}
