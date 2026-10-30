package com.mediamarshal.service.matcher;

import com.fasterxml.jackson.databind.JavaType;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.mediamarshal.model.dto.MatchResult;
import com.mediamarshal.model.dto.TmdbEpisode;
import com.mediamarshal.model.entity.TmdbCacheEntry;
import com.mediamarshal.repository.TmdbCacheEntryRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

@Component
@RequiredArgsConstructor
class TmdbPersistentCache {
    private final TmdbCacheEntryRepository repository;
    private final ObjectMapper mapper;

    Optional<Value> find(String key) {
        return repository.findById(key).flatMap(entry -> {
            if (entry.getExpiresAt() <= Instant.now().toEpochMilli()) {
                repository.delete(entry);
                return Optional.empty();
            }
            try {
                return Optional.of(new Value(mapper.readValue(entry.getPayload(), typeFor(key)),
                        Instant.ofEpochMilli(entry.getExpiresAt())));
            } catch (Exception e) {
                // 老版本或损坏的缓存不能阻止重新获取元数据。
                repository.delete(entry);
                return Optional.empty();
            }
        });
    }

    void save(String key, Object value, Instant expiresAt, int maxSize) {
        TmdbCacheEntry entry = new TmdbCacheEntry();
        entry.setCacheKey(key);
        entry.setExpiresAt(expiresAt.toEpochMilli());
        try {
            entry.setPayload(mapper.writeValueAsString(value));
        } catch (Exception e) {
            throw new IllegalStateException("TMDB 元数据缓存序列化失败，请重试", e);
        }
        repository.save(entry);
        while (repository.count() > maxSize) {
            var oldest = repository.findFirstByOrderByExpiresAtAsc();
            if (oldest.isEmpty()) break;
            repository.delete(oldest.get());
        }
    }

    private JavaType typeFor(String key) {
        var types = mapper.getTypeFactory();
        return switch (key.substring(0, key.indexOf('|'))) {
            case "search" -> types.constructType(JsonNode.class);
            case "detail" -> types.constructType(MatchResult.class);
            case "season-episodes" -> types.constructCollectionType(List.class, TmdbEpisode.class);
            case "tv" -> types.constructType(String.class);
            default -> throw new IllegalArgumentException("未知的 TMDB 缓存类型");
        };
    }

    record Value(Object value, Instant expiresAt) {}
}
