package com.mediamarshal.service.emby;

import com.mediamarshal.service.settings.SettingsService;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

class EmbySettingsServiceTest {
    private final SettingsService settings = mock(SettingsService.class);
    private final EmbySettingsService service = new EmbySettingsService(settings);

    @Test
    void blankKeyPreservesExistingSecret() {
        when(settings.get("emby.api-key", "")).thenReturn("existing-key");
        service.save(true, " http://emby:8096/ ", "");
        verify(settings, never()).set(eq("emby.api-key"), anyString(), anyString(), anyBoolean());
        verify(settings).set("emby.server-url", "http://emby:8096", "Emby 服务器地址", false);
    }

    @Test
    void storesNewKeyAsSensitive() {
        service.save(true, "http://emby:8096", " new-key ");
        verify(settings).set("emby.api-key", "new-key", "Emby API Key", true);
    }

    @Test
    void rejectsIncompleteConfigurationBeforeWriting() {
        when(settings.get("emby.api-key", "")).thenReturn("");
        assertThatThrownBy(() -> service.save(true, "http://emby:8096", ""))
                .hasMessageContaining("API Key");
        verify(settings, never()).set(anyString(), anyString(), anyString(), anyBoolean());
    }

    @Test
    void canDisableWithoutCredentials() {
        service.save(false, "", "");
        verify(settings).set("emby.enabled", "false", "整理完成后自动刷新 Emby", false);
    }

    @ParameterizedTest
    @ValueSource(strings = {"ftp://emby:8096", "http://user:password@emby:8096", "http://emby:8096?api_key=secret", "http://emby:8096/#settings", "not-a-url"})
    void rejectsInvalidUrlsWithoutSavingSecrets(String url) {
        assertThatThrownBy(() -> service.save(true, url, "new-key")).isInstanceOf(IllegalArgumentException.class);
        verifyNoInteractions(settings);
    }

    @Test
    void supportsReverseProxyAndExistingEmbyPrefix() {
        assertThat(new EmbySettingsService.Configuration(true, "https://host/media/emby/", "key").refreshUrl())
                .isEqualTo("https://host/media/emby/Library/Refresh");
        assertThat(new EmbySettingsService.Configuration(true, "https://host/media", "key").refreshUrl())
                .isEqualTo("https://host/media/emby/Library/Refresh");
    }
}
