package com.mediamarshal.service.emby;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.web.reactive.function.client.ClientResponse;
import org.springframework.web.reactive.function.client.ExchangeFunction;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.*;

class EmbyLibraryRefreshServiceTest {
    private final EmbySettingsService settings = mock(EmbySettingsService.class);
    private final ExchangeFunction exchange = mock(ExchangeFunction.class);
    private final EmbyLibraryRefreshService service = new EmbyLibraryRefreshService(settings,
            WebClient.builder().exchangeFunction(exchange));

    @BeforeEach
    void setUp() {
        when(settings.isEnabled()).thenReturn(true);
        when(settings.resolve()).thenReturn(new EmbySettingsService.Configuration(true, "http://emby:8096", "test-key"));
        when(exchange.exchange(any())).thenReturn(Mono.just(ClientResponse.create(HttpStatus.NO_CONTENT).build()));
    }

    @Test
    void combinesCompletedTasksAndSendsAuthenticatedScanOnlyOnce() {
        service.requestRefresh();
        service.requestRefresh();
        service.requestRefresh();
        verifyNoInteractions(exchange);
        service.flushPendingRefresh();
        service.flushPendingRefresh();

        verify(exchange).exchange(argThat(request -> {
            assertThat(request.method().name()).isEqualTo("POST");
            assertThat(request.url().toString()).isEqualTo("http://emby:8096/emby/Library/Refresh");
            assertThat(request.headers().getFirst("X-Emby-Token")).isEqualTo("test-key");
            assertThat(request.url().getQuery()).isNull();
            return true;
        }));
    }

    @Test
    void disabledIntegrationDoesNotQueueScans() {
        when(settings.isEnabled()).thenReturn(false);
        service.requestRefresh();
        service.flushPendingRefresh();
        verifyNoInteractions(exchange);
    }

    @Test
    void disablingBeforeFlushCancelsQueuedScan() {
        service.requestRefresh();
        when(settings.resolve()).thenReturn(new EmbySettingsService.Configuration(false, "", ""));
        service.flushPendingRefresh();
        verifyNoInteractions(exchange);
    }

    @Test
    void failedScanDoesNotThrowAndIsRetried() {
        when(exchange.exchange(any()))
                .thenReturn(Mono.just(ClientResponse.create(HttpStatus.SERVICE_UNAVAILABLE).build()))
                .thenReturn(Mono.just(ClientResponse.create(HttpStatus.NO_CONTENT).build()));
        service.requestRefresh();
        assertThatCode(service::flushPendingRefresh).doesNotThrowAnyException();
        service.flushPendingRefresh();
        service.flushPendingRefresh();
        verify(exchange, times(2)).exchange(any());
    }

    @Test
    void completionDuringScanIsNotLost() {
        when(exchange.exchange(any())).thenAnswer(invocation -> {
            service.requestRefresh();
            return Mono.just(ClientResponse.create(HttpStatus.NO_CONTENT).build());
        });
        service.requestRefresh();
        service.flushPendingRefresh();
        service.flushPendingRefresh();
        verify(exchange, times(2)).exchange(any());
    }

    @Test
    void settingsFailureCannotFailCompletedTask() {
        when(settings.isEnabled()).thenThrow(new IllegalStateException());
        assertThatCode(service::requestRefresh).doesNotThrowAnyException();
        verifyNoInteractions(exchange);
    }
}
