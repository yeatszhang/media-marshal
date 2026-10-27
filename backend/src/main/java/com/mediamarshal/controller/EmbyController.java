package com.mediamarshal.controller;

import com.mediamarshal.model.dto.ApiResponse;
import com.mediamarshal.service.emby.EmbySettingsService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/api/emby/settings")
@RequiredArgsConstructor
public class EmbyController {
    private final EmbySettingsService settings;

    @GetMapping
    public ApiResponse<ConfigurationResponse> get() {
        var config = settings.resolve();
        return ApiResponse.ok(new ConfigurationResponse(config.enabled, config.serverUrl, !config.apiKey.isBlank()));
    }

    @PutMapping
    public ApiResponse<Void> save(@RequestBody ConfigurationRequest request) {
        try {
            settings.save(request.enabled(), request.serverUrl(), request.apiKey());
            return ApiResponse.ok();
        } catch (IllegalArgumentException e) {
            return ApiResponse.fail(e.getMessage());
        }
    }

    public record ConfigurationResponse(boolean enabled, String serverUrl, boolean apiKeyConfigured) {}
    public record ConfigurationRequest(boolean enabled, String serverUrl, String apiKey) {}
}
