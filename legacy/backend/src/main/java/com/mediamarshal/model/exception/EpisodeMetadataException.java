package com.mediamarshal.model.exception;

/** 季集尚未通过 TMDB 校验，任务应等待确认，不能继续操作文件。 */
public class EpisodeMetadataException extends IllegalStateException {
    public EpisodeMetadataException(String message) {
        super(message);
    }
}
