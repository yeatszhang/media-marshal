package com.mediamarshal.service.matcher;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.mediamarshal.model.dto.MatchResult;
import com.mediamarshal.model.dto.TmdbEpisode;
import com.mediamarshal.model.dto.TmdbSeason;
import com.mediamarshal.model.entity.TmdbCacheEntry;
import com.mediamarshal.repository.TmdbCacheEntryRepository;
import org.junit.jupiter.api.Test;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Optional;
import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class TmdbPersistentCacheTest {
    @Test
    void restoresTypedMetadataAcrossInstancesAndDiscardsExpiredOrCorruptEntries() {
        var entries = new HashMap<String, TmdbCacheEntry>();
        var repository = mock(TmdbCacheEntryRepository.class);
        when(repository.findById(anyString())).thenAnswer(call -> Optional.ofNullable(entries.get(call.getArgument(0))));
        when(repository.save(any())).thenAnswer(call -> {
            TmdbCacheEntry entry = call.getArgument(0); entries.put(entry.getCacheKey(), entry); return entry;
        });
        doAnswer(call -> { entries.remove(((TmdbCacheEntry) call.getArgument(0)).getCacheKey()); return null; })
                .when(repository).delete(any(TmdbCacheEntry.class));
        var cache = new TmdbPersistentCache(repository, new ObjectMapper());
        var detail = new MatchResult(); detail.setTitle("咒术回战"); detail.setSeasons(List.of(new TmdbSeason(1, 59)));
        var expiry = Instant.now().plusSeconds(60);
        cache.save("detail|tv|95479|zh-CN", detail, expiry, 5000);
        cache.save("season-episodes|95479|1|zh-CN", List.of(new TmdbEpisode(1, 48, "第48集")), expiry, 5000);
        var restarted = new TmdbPersistentCache(repository, new ObjectMapper());
        assertThat((MatchResult) restarted.find("detail|tv|95479|zh-CN").orElseThrow().value()).usingRecursiveComparison().isEqualTo(detail);
        assertThat(restarted.find("season-episodes|95479|1|zh-CN").orElseThrow().value())
                .isEqualTo(List.of(new TmdbEpisode(1, 48, "第48集")));
        entries.get("detail|tv|95479|zh-CN").setPayload("损坏JSON");
        assertThat(restarted.find("detail|tv|95479|zh-CN")).isEmpty();
        entries.get("season-episodes|95479|1|zh-CN").setExpiresAt(1);
        assertThat(restarted.find("season-episodes|95479|1|zh-CN")).isEmpty();
        assertThat(entries).isEmpty();
    }
}
