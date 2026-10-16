package com.mediamarshal.service.matcher;

import com.mediamarshal.model.dto.MatchResult;
import com.mediamarshal.model.dto.TmdbEpisode;
import com.mediamarshal.model.dto.TmdbSeason;
import com.mediamarshal.model.entity.MediaTask;
import com.mediamarshal.model.exception.EpisodeMetadataException;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.List;
import java.util.Map;
import java.util.function.Function;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class TmdbEpisodeService {
    private final MetadataMatcher matcher;

    /** 返回 true 表示采用了不同的 TMDB 季集号；调用者必须展示提示再执行文件操作。 */
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
        boolean exactSeason = seasons.stream().anyMatch(item -> item.seasonNumber() == season);
        if (!exactSeason) {
            List<TmdbSeason> regular = seasons.stream().filter(item -> item.seasonNumber() > 0).toList();
            // 不把特别篇改成正片，也不在多季作品间猜测累计集号与季内集号的换算。
            if (season == 0 || regular.size() != 1) {
                throw blocked("识别季号 " + season + " 与 TMDB 季列表冲突，无法唯一映射，请按 TMDB 编辑季集号");
            }
            resolvedSeason = regular.getFirst().seasonNumber();
        }
        List<TmdbEpisode> episodes;
        try {
            episodes = matcher.getSeasonEpisodes(detail.getSourceId(), resolvedSeason);
        } catch (RuntimeException e) {
            throw blocked("TMDB 分集列表暂不可用，季集号未经校验，请稍后重试");
        }
        final int targetSeason = resolvedSeason;
        Map<Integer, TmdbEpisode> byNumber;
        try {
            if (episodes == null || episodes.stream().anyMatch(item -> item.seasonNumber() != targetSeason)) {
                throw new IllegalArgumentException();
            }
            byNumber = episodes.stream().collect(Collectors.toMap(TmdbEpisode::episodeNumber, Function.identity()));
        } catch (RuntimeException e) {
            throw blocked("TMDB 分集列表无效，暂不能校验季集号");
        }
        for (int episode = start; episode <= end; episode++) {
            if (!byNumber.containsKey(episode)) {
                throw blocked("识别信息 " + coordinate(season, start, end) + " 与 TMDB 冲突：TMDB 第 "
                        + resolvedSeason + " 季不存在第 " + episode + " 集，请按 TMDB 编辑季集号");
            }
        }
        // 所有集号通过校验后才更新，避免合并集范围校验失败留下部分修改。
        task.setParsedSeason(resolvedSeason);
        String title = start == end ? byNumber.get(start).title() : null;
        detail.setEpisodeTitle(title == null || title.isBlank() ? null : title);
        boolean changed = resolvedSeason != season;
        if (changed) {
            task.setMetadataWarning("文件名或识别信息 " + coordinate(season, start, end)
                    + " 与 TMDB 季集结构冲突，已优先采用 TMDB " + coordinate(resolvedSeason, start, end)
                    + "，请核对后确认。");
        }
        return changed;
    }

    private EpisodeMetadataException blocked(String reason) {
        return new EpisodeMetadataException(reason + "；已暂停文件整理");
    }

    private String coordinate(int season, int start, int end) {
        return "S%02dE%02d".formatted(season, start) + (start == end ? "" : "-E%02d".formatted(end));
    }
}
