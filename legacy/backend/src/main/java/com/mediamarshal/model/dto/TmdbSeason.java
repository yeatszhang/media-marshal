package com.mediamarshal.model.dto;

/** TMDB 默认季集结构，不使用发行组或播出平台的分季方式。 */
public record TmdbSeason(int seasonNumber, int episodeCount) {}
