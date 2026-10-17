package com.mediamarshal.service.matcher;

import com.mediamarshal.model.dto.MatchResult;
import com.mediamarshal.model.dto.TmdbEpisode;
import com.mediamarshal.model.dto.TmdbSeason;
import com.mediamarshal.model.entity.MediaTask;
import com.mediamarshal.model.exception.EpisodeMetadataException;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class TmdbEpisodeService {
    private final MetadataMatcher matcher;

    /** 路径季号仅作线索；返回 true 表示已通过分集列表确定并采用其他季号。 */
    public boolean reconcile(MediaTask task, MatchResult detail) {
        if (!MediaTask.MediaType.TV_SHOW.equals(task.getMediaType())) return false;
        Integer season = task.getParsedSeason();
        Integer start = task.getParsedEpisode();
        int end = task.getParsedEpisodeEnd() == null ? (start == null ? 0 : start) : task.getParsedEpisodeEnd();
        if (season == null || season < 0 || start == null || start < 1 || end < start || end > 10000) {
            throw blocked("缺少有效的季集号，请先补齐后按 TMDB 校验");
        }
        List<TmdbSeason> seasons = detail.getSeasons();
        if (seasons == null || seasons.isEmpty()) throw blocked("TMDB 未提供季列表，暂不能校验季集号");
        int resolvedSeason = season;
        Map<Integer, TmdbEpisode> byNumber = seasons.stream().anyMatch(item -> item.seasonNumber() == season)
                ? loadEpisodes(detail, season) : Map.of();
        if (!containsRange(byNumber, start, end)) {
            // 不换算累计集号偏移；只有全部集号在唯一一个其他正片季存在时才改季号。
            List<Integer> matchingSeasons = new ArrayList<>();
            List<String> missingEpisodes = new ArrayList<>();
            Map<Integer, TmdbEpisode> resolvedEpisodes = Map.of();
            if (season > 0) {
                for (int candidate : seasons.stream().map(TmdbSeason::seasonNumber)
                        .filter(number -> number > 0 && number != season).distinct().toList()) {
                    Map<Integer, TmdbEpisode> episodes = loadEpisodes(detail, candidate);
                    if (containsRange(episodes, start, end)) {
                        matchingSeasons.add(candidate);
                        resolvedEpisodes = episodes;
                    } else {
                        missingEpisodes.add("第 " + candidate + " 季不存在第 " + firstMissing(episodes, start, end) + " 集");
                    }
                }
            }
            if (matchingSeasons.size() != 1) {
                throw blocked("识别信息 " + coordinate(season, start, end) + " 与 TMDB 冲突：第 " + season
                        + " 季不存在第 " + firstMissing(byNumber, start, end) + " 集；"
                        + (matchingSeasons.isEmpty() ? "没有其他正片季包含全部集号"
                            + (missingEpisodes.isEmpty() ? "" : "（" + String.join("；", missingEpisodes) + "）")
                            : "多个正片季包含全部集号：" + matchingSeasons)
                        + "，无法唯一映射，请按 TMDB 编辑季集号");
            }
            resolvedSeason = matchingSeasons.getFirst();
            byNumber = resolvedEpisodes;
        }
        // 所有集号通过校验后才更新，避免合并集范围校验失败留下部分修改。
        task.setParsedSeason(resolvedSeason);
        String title = start == end ? byNumber.get(start).title() : null;
        detail.setEpisodeTitle(title == null || title.isBlank() ? null : title);
        boolean changed = resolvedSeason != season;
        if (changed) {
            task.setMetadataWarning("文件名或识别信息 " + coordinate(season, start, end)
                    + " 与 TMDB 季集结构冲突，经分集列表校验，已采用唯一匹配的 TMDB "
                    + coordinate(resolvedSeason, start, end) + "，保留原集号。");
        }
        return changed;
    }

    private Map<Integer, TmdbEpisode> loadEpisodes(MatchResult detail, int season) {
        List<TmdbEpisode> episodes;
        try {
            episodes = matcher.getSeasonEpisodes(detail.getSourceId(), season);
        } catch (RuntimeException e) {
            throw blocked("TMDB 分集列表获取失败：" + e.getMessage() + "；季集号未经校验，请重试");
        }
        try {
            if (episodes == null || episodes.stream().anyMatch(item -> item.seasonNumber() != season)) {
                throw new IllegalArgumentException();
            }
            return episodes.stream().collect(Collectors.toMap(TmdbEpisode::episodeNumber, Function.identity()));
        } catch (RuntimeException e) {
            throw blocked("TMDB 分集列表无效，暂不能校验季集号");
        }
    }

    private boolean containsRange(Map<Integer, TmdbEpisode> episodes, int start, int end) {
        return firstMissing(episodes, start, end) > end;
    }

    private int firstMissing(Map<Integer, TmdbEpisode> episodes, int start, int end) {
        for (int episode = start; episode <= end; episode++) {
            if (!episodes.containsKey(episode)) return episode;
        }
        return end + 1;
    }

    private EpisodeMetadataException blocked(String reason) {
        return new EpisodeMetadataException(reason + "；已暂停文件整理");
    }

    private String coordinate(int season, int start, int end) {
        return "S%02dE%02d".formatted(season, start) + (start == end ? "" : "-E%02d".formatted(end));
    }
}
