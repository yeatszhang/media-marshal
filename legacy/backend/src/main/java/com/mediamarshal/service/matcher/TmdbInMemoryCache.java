package com.mediamarshal.service.matcher;

import com.mediamarshal.service.settings.SettingsService;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionException;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Function;
import java.util.function.Supplier;

@Slf4j
@Component
class TmdbInMemoryCache {

    private final SettingsService settingsService;
    private final TmdbPersistentCache persistentCache;
    private final Map<String, CacheEntry> cache = new ConcurrentHashMap<>();
    private final Map<String, CompletableFuture<Object>> inFlight = new ConcurrentHashMap<>();

    @Autowired
    TmdbInMemoryCache(SettingsService settingsService, TmdbPersistentCache persistentCache) {
        this.settingsService = settingsService;
        this.persistentCache = persistentCache;
    }

    TmdbInMemoryCache(SettingsService settingsService) {
        this(settingsService, null);
    }

    @SuppressWarnings("unchecked")
    <T> T get(String key, Supplier<T> loader, Function<T, Duration> ttlResolver) {
        return getWithStatus(key, loader, ttlResolver).value();
    }

    @SuppressWarnings("unchecked")
    <T> CacheLookup<T> getWithStatus(String key, Supplier<T> loader, Function<T, Duration> ttlResolver) {
        Instant now = Instant.now();
        CacheEntry existing = cache.get(key);
        if (existing != null && existing.expiresAt().isAfter(now)) {
            return new CacheLookup<>((T) existing.value(), CacheStatus.HIT);
        }
        if (existing != null) {
            cache.remove(key, existing);
        }

        // 先注册占位再执行加载，避免快速失败先清理、后插入，永久复用失败的 Future。
        CompletableFuture<Object> owned = new CompletableFuture<>();
        CompletableFuture<Object> running = inFlight.putIfAbsent(key, owned);
        if (running == null) {
            try {
                // 在检查缓存和取得加载权之间，前一个请求可能已完成。
                CacheEntry current = cache.get(key);
                T value;
                CacheStatus status;
                if (current != null && current.expiresAt().isAfter(Instant.now())) {
                    value = (T) current.value();
                    status = CacheStatus.HIT;
                } else {
                    var persisted = persistentCache == null ? java.util.Optional.<TmdbPersistentCache.Value>empty()
                            : persistentCache.find(key);
                    if (persisted.isPresent()) {
                        var stored = persisted.get();
                        value = (T) stored.value();
                        trimIfNeeded();
                        cache.put(key, new CacheEntry(value, stored.expiresAt()));
                        status = CacheStatus.HIT;
                    } else {
                        value = loadAndCache(key, loader, ttlResolver);
                        status = CacheStatus.MISS;
                    }
                }
                owned.complete(value);
                return new CacheLookup<>(value, status);
            } catch (RuntimeException | Error e) {
                owned.completeExceptionally(e);
                throw e;
            } finally {
                inFlight.remove(key, owned);
            }
        }

        try {
            return new CacheLookup<>((T) running.join(), CacheStatus.IN_FLIGHT);
        } catch (CompletionException e) {
            Throwable cause = e.getCause();
            if (cause instanceof RuntimeException runtimeException) {
                throw runtimeException;
            }
            throw e;
        }
    }

    private <T> T loadAndCache(String key, Supplier<T> loader, Function<T, Duration> ttlResolver) {
        T value = loader.get();
        Duration ttl = ttlResolver.apply(value);
        if (ttl != null && !ttl.isNegative() && !ttl.isZero()) {
            Instant expiresAt = Instant.now().plus(ttl);
            if (persistentCache != null) persistentCache.save(key, value, expiresAt, getMaxSize());
            trimIfNeeded();
            cache.put(key, new CacheEntry(value, expiresAt));
        }
        return value;
    }

    private void trimIfNeeded() {
        int maxSize = getMaxSize();
        if (cache.size() < maxSize) {
            return;
        }
        Instant now = Instant.now();
        cache.entrySet().removeIf(entry -> entry.getValue().expiresAt().isBefore(now));
        while (cache.size() >= maxSize && !cache.isEmpty()) {
            cache.entrySet().stream()
                    .min(Comparator.comparing(entry -> entry.getValue().expiresAt()))
                    .map(Map.Entry::getKey)
                    .ifPresent(cache::remove);
        }
    }

    private int getMaxSize() {
        String value = settingsService.get("tmdb.cache-max-size", "5000");
        try {
            return Math.max(Integer.parseInt(value), 1);
        } catch (NumberFormatException e) {
            log.warn("Invalid tmdb.cache-max-size='{}', fallback to 5000", value);
            return 5000;
        }
    }

    private record CacheEntry(Object value, Instant expiresAt) {
    }

    enum CacheStatus {
        HIT,
        MISS,
        IN_FLIGHT
    }

    record CacheLookup<T>(T value, CacheStatus status) {
    }
}
