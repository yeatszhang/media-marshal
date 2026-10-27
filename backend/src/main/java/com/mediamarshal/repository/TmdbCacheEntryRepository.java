package com.mediamarshal.repository;

import com.mediamarshal.model.entity.TmdbCacheEntry;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.Optional;

public interface TmdbCacheEntryRepository extends JpaRepository<TmdbCacheEntry, String> {
    Optional<TmdbCacheEntry> findFirstByOrderByExpiresAtAsc();
}
