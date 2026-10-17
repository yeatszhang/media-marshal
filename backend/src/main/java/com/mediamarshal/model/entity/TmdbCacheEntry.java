package com.mediamarshal.model.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import lombok.Data;

/** 仅保存成功取得的公开元数据，不保存请求凭据或网络错误。 */
@Data
@Entity
@Table(name = "tmdb_cache_entry")
public class TmdbCacheEntry {
    @Id
    private String cacheKey;
    @Column(nullable = false, columnDefinition = "TEXT")
    private String payload;
    @Column(nullable = false)
    private long expiresAt;
}
