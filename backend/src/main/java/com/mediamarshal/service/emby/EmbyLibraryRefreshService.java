package com.mediamarshal.service.emby;

import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.web.reactive.function.client.WebClient;

import java.time.Duration;
import java.util.concurrent.atomic.AtomicBoolean;

/** 完成事件只标记待刷新，定时合并请求，避免批量整理逐集扫描媒体库。 */
@Slf4j
@Service
@RequiredArgsConstructor
public class EmbyLibraryRefreshService {
    private final EmbySettingsService settings;
    private final WebClient.Builder webClientBuilder;
    private final AtomicBoolean pending = new AtomicBoolean();

    public void requestRefresh() {
        try {
            if (settings.isEnabled()) pending.set(true);
        } catch (Exception e) {
            log.warn("无法安排 Emby 刷新，不影响整理结果：{}", e.getClass().getSimpleName());
        }
    }

    @Scheduled(initialDelay = 30000, fixedDelay = 30000)
    public void flushPendingRefresh() {
        if (!pending.getAndSet(false)) return;
        try {
            var config = settings.resolve();
            if (!config.enabled) return;
            webClientBuilder.build().post().uri(config.refreshUrl())
                    .header("X-Emby-Token", config.apiKey)
                    .retrieve().toBodilessEntity().block(Duration.ofSeconds(8));
            log.info("已通知 Emby 扫描媒体库");
        } catch (Exception e) {
            pending.set(true);
            // 不输出请求地址、响应正文或凭据；下个周期重试。
            log.warn("Emby 媒体库刷新失败，将重试，不影响整理结果：{}", e.getClass().getSimpleName());
        }
    }
}
