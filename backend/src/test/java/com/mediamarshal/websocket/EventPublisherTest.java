package com.mediamarshal.websocket;

import com.mediamarshal.model.entity.MediaTask;
import com.mediamarshal.service.emby.EmbyLibraryRefreshService;
import org.junit.jupiter.api.Test;
import org.springframework.messaging.simp.SimpMessagingTemplate;

import static org.mockito.Mockito.*;

class EventPublisherTest {
    @Test
    void onlyCompletedTasksRequestEmbyRefresh() {
        var emby = mock(EmbyLibraryRefreshService.class);
        var publisher = new EventPublisher(mock(SimpMessagingTemplate.class), emby);
        var task = new MediaTask();
        task.setId(1L);
        task.setSourcePath("/source/video.mkv");
        task.setStatus(MediaTask.TaskStatus.PROCESSING);
        publisher.publishTaskCreated(task);
        publisher.publishTaskProcessing(task);
        publisher.publishAwaitingConfirmation(task);
        publisher.publishTaskFailed(task);
        verifyNoInteractions(emby);
        task.setStatus(MediaTask.TaskStatus.DONE);
        publisher.publishTaskDone(task);
        verify(emby).requestRefresh();
    }
}
