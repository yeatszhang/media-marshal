package com.mediamarshal.service.emby;

import com.mediamarshal.service.settings.SettingsService;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.net.URI;

@Service
@RequiredArgsConstructor
public class EmbySettingsService {
    private final SettingsService settings;

    public boolean isEnabled() {
        return Boolean.parseBoolean(settings.get("emby.enabled", "false"));
    }

    public Configuration resolve() {
        return new Configuration(isEnabled(), settings.get("emby.server-url", ""),
                settings.get("emby.api-key", ""));
    }

    @Transactional
    public void save(boolean enabled, String serverUrl, String apiKey) {
        String url = normalizeUrl(serverUrl);
        String newKey = apiKey == null ? "" : apiKey.trim();
        String effectiveKey = newKey.isBlank() ? settings.get("emby.api-key", "") : newKey;
        if (enabled && url.isBlank()) throw new IllegalArgumentException("启用 Emby 自动刷新时必须填写服务器地址");
        if (enabled && effectiveKey.isBlank()) throw new IllegalArgumentException("启用 Emby 自动刷新时必须填写 API Key");
        if (!newKey.isBlank()) settings.set("emby.api-key", newKey, "Emby API Key", true);
        settings.set("emby.server-url", url, "Emby 服务器地址", false);
        settings.set("emby.enabled", String.valueOf(enabled), "整理完成后自动刷新 Emby", false);
    }

    static String normalizeUrl(String value) {
        String url = value == null ? "" : value.trim().replaceAll("/+$", "");
        if (url.isBlank()) return "";
        try {
            URI uri = URI.create(url);
            if (!("http".equalsIgnoreCase(uri.getScheme()) || "https".equalsIgnoreCase(uri.getScheme()))
                    || uri.getHost() == null || uri.getRawUserInfo() != null
                    || uri.getRawQuery() != null || uri.getRawFragment() != null) {
                throw new IllegalArgumentException();
            }
        } catch (IllegalArgumentException e) {
            throw new IllegalArgumentException("Emby 地址须为 HTTP 或 HTTPS 地址，不能包含账号、查询参数或片段");
        }
        return url;
    }

    // 不生成包含 API Key 的 toString，避免凭据进入日志。
    public static final class Configuration {
        public final boolean enabled;
        public final String serverUrl;
        public final String apiKey;

        Configuration(boolean enabled, String serverUrl, String apiKey) {
            this.enabled = enabled;
            this.serverUrl = serverUrl;
            this.apiKey = apiKey;
        }

        public String refreshUrl() {
            String url = normalizeUrl(serverUrl);
            if (url.isBlank() || apiKey.isBlank()) throw new IllegalArgumentException("Emby 配置不完整");
            return url + (url.endsWith("/emby") ? "" : "/emby") + "/Library/Refresh";
        }
    }
}
