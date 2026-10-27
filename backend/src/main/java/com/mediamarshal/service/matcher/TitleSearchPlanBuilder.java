package com.mediamarshal.service.matcher;

import com.mediamarshal.model.dto.ParseResult;
import org.springframework.stereotype.Component;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Pattern;

@Component
class TitleSearchPlanBuilder {

    private static final int MAX_PRIMARY_QUERIES = 3;
    private static final Pattern VIDEO_EXTENSION = Pattern.compile(
            "\\.(mkv|mp4|avi|mov|wmv|flv|webm|m4v|ts|m2ts|iso)$",
            Pattern.CASE_INSENSITIVE);
    private static final Pattern RELEASE_MARKER = Pattern.compile(
            "(?i)(?:^|[. _\\-\\[\\(])("
                    + "s\\d{1,2}(?:e\\d{1,3})?|season\\s*\\d+|第\\s*\\d+\\s*季|第\\s*\\d+\\s*集|"
                    + "\\d{3,4}p|2160p|1080p|720p|480p|4k|8k|"
                    + "bluray|blu-ray|web-dl|webrip|hdtv|hdrip|dvdrip|bdrip|x264|x265|h\\.264|h\\.265|hevc|"
                    + "aac|ddp?|dts|atmos|proper|repack"
                    + ")(?:$|[. _\\-\\]\\)])");
    private static final Pattern YEAR_MARKER = Pattern.compile("(?:^|[. _\\-\\[\\(])((?:19|20)\\d{2})(?:$|[. _\\-\\]\\)])");
    private static final Pattern BRACKETED_PREFIX = Pattern.compile("^\\s*[\\[【(（]([^\\]】)）]+)[\\]】)）]\\s*(.*)$");
    private static final Pattern BRACKETED_TOKEN = Pattern.compile("[\\[【(（]([^\\[\\]【】()（）]+)[\\]】)）]");
    private static final Pattern SUBTITLE_GROUP = Pattern.compile(
            "(?i)(?:.*字幕[组組社]|[a-z0-9._-]*subs?)(?:\\s*[&+＆]\\s*[\\p{L}\\p{N}._-]+)*");
    private static final String METADATA_TOKEN = "(?:gb|big5|chs|cht|sc|tc|简体|繁体|简繁|简繁内封|简繁外挂|"
                    + "\\d{3,4}p|4k|8k|bluray|blu-ray|web-dl|webrip|hdtv|hdrip|dvdrip|bdrip|"
                    + "x264|x265|h[. ]?264|h[. ]?265|hevc|avc|aac|flac|ddp?|dts|atmos|"
                    + "10bit|8bit|hi10p|hdr|sdr)";
    private static final Pattern BRACKETED_METADATA = Pattern.compile(
            "(?i)" + METADATA_TOKEN + "(?:[\\s._+\\-]+" + METADATA_TOKEN + ")*");
    private static final Pattern BRACKETED_EPISODE = Pattern.compile("(?i)\\d{1,4}(?:[-~]\\d{1,4})?(?:v\\d+)?");
    private static final Pattern CHINESE = Pattern.compile("\\p{IsHan}");
    private static final Pattern ASCII_LETTER = Pattern.compile("[A-Za-z]");

    TitleSearchPlan build(ParseResult parseResult) {
        String originalFilename = parseResult.getOriginalFilename();
        String guessitTitle = normalizeQuery(parseResult.getTitle());
        String titleRegion = extractTitleRegion(originalFilename, parseResult);

        List<TitleSearchQuery> queries = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();

        for (String query : buildPrimaryQueries(titleRegion)) {
            addQuery(queries, seen, query, inferType(query));
            if (queries.size() >= MAX_PRIMARY_QUERIES) {
                break;
            }
        }

        if (guessitTitle != null && queries.size() < MAX_PRIMARY_QUERIES + 1) {
            addQuery(queries, seen, guessitTitle, TitleSearchQueryType.GUESSIT);
        }

        return new TitleSearchPlan(originalFilename, guessitTitle, titleRegion, List.copyOf(queries));
    }

    private String extractTitleRegion(String originalFilename, ParseResult parseResult) {
        String source = originalFilename;
        if (source == null || source.isBlank()) {
            return normalizeQuery(parseResult.getTitle());
        }

        String filename = stripBracketedMetadata(VIDEO_EXTENSION.matcher(source).replaceFirst(""), parseResult);
        int markerIndex = findFirstMarkerIndex(filename, parseResult);
        String titleRegion = markerIndex > 0 ? filename.substring(0, markerIndex) : filename;
        // 保留括号边界，生成 query 时再归一化，避免把字幕组和多个标题提前拼在一起。
        return trimSeparators(titleRegion);
    }

    private String stripBracketedMetadata(String filename, ParseResult parseResult) {
        StringBuilder title = new StringBuilder();
        String releaseGroup = normalizeQuery(parseResult.getReleaseGroup());
        var matcher = BRACKETED_TOKEN.matcher(filename);
        int cursor = 0;
        while (matcher.find()) {
            title.append(filename, cursor, matcher.start());
            String token = matcher.group(1).trim();
            String normalized = normalizeQuery(token);
            boolean knownGroup = releaseGroup != null && releaseGroup.equalsIgnoreCase(normalized);
            if (knownGroup || SUBTITLE_GROUP.matcher(token).matches()) {
                title.append(' ');
            } else {
                boolean hasTitle = normalizeQuery(trimSeparators(title.toString())) != null;
                // 只有标题之后的纯数字括号才作为集号，保留 [86] 一类数字作品名。
                boolean episode = hasTitle && (parseResult.getEpisode() != null
                        || "episode".equalsIgnoreCase(parseResult.getType()))
                        && BRACKETED_EPISODE.matcher(token).matches();
                if (BRACKETED_METADATA.matcher(token).matches() || episode) {
                    if (hasTitle) {
                        return title.toString();
                    }
                    title.append(' ');
                } else {
                    title.append(matcher.group());
                }
            }
            cursor = matcher.end();
        }
        return title.append(filename.substring(cursor)).toString();
    }

    private int findFirstMarkerIndex(String filename, ParseResult parseResult) {
        int first = -1;
        first = minPositive(first, markerIndex(RELEASE_MARKER, filename));
        first = minPositive(first, markerIndex(YEAR_MARKER, filename));

        if (parseResult.getSeason() != null) {
            first = minPositive(first, markerIndex(Pattern.compile("(?i)(?:^|[. _\\-])s"
                    + Pattern.quote(String.format(Locale.ROOT, "%02d", parseResult.getSeason()))), filename));
        }
        if (parseResult.getYear() != null) {
            first = minPositive(first, markerIndex(Pattern.compile("(?:^|[. _\\-\\[\\(])"
                    + Pattern.quote(String.valueOf(parseResult.getYear())) + "(?:$|[. _\\-\\]\\)])"), filename));
        }

        return first;
    }

    private int markerIndex(Pattern pattern, String text) {
        var matcher = pattern.matcher(text);
        return matcher.find() ? matcher.start() : -1;
    }

    private int minPositive(int current, int candidate) {
        if (candidate < 0) {
            return current;
        }
        return current < 0 ? candidate : Math.min(current, candidate);
    }

    private List<String> buildPrimaryQueries(String titleRegion) {
        List<String> queries = new ArrayList<>();
        if (titleRegion == null || titleRegion.isBlank()) {
            return queries;
        }

        String remaining = titleRegion;
        var bracketMatcher = BRACKETED_PREFIX.matcher(remaining);
        boolean bracketed = false;
        while (bracketMatcher.matches()) {
            bracketed = true;
            for (String query : buildUnbracketedQueries(normalizeQuery(bracketMatcher.group(1)))) {
                addIfPresent(queries, query);
            }
            remaining = trimSeparators(bracketMatcher.group(2));
            bracketMatcher = BRACKETED_PREFIX.matcher(remaining);
        }
        if (bracketed) {
            for (String query : buildUnbracketedQueries(normalizeQuery(remaining))) {
                addIfPresent(queries, query);
            }
            if (queries.size() > 1) {
                addIfPresent(queries, normalizeQuery(titleRegion));
            }
            return queries;
        }
        return buildUnbracketedQueries(normalizeQuery(titleRegion));
    }

    private List<String> buildUnbracketedQueries(String titleRegion) {
        List<String> queries = new ArrayList<>();
        if (titleRegion == null) {
            return queries;
        }
        String[] parts = titleRegion.split("\\s+");
        StringBuilder chinese = new StringBuilder();
        StringBuilder english = new StringBuilder();
        for (String part : parts) {
            if (part.isBlank()) {
                continue;
            }
            if (containsChinese(part)) {
                appendToken(chinese, part);
            } else if (containsAsciiLetter(part)) {
                appendToken(english, part);
            } else if (part.matches("\\d+") && !english.isEmpty()) {
                appendToken(english, part);
            }
        }

        if (!chinese.isEmpty() && !english.isEmpty()) {
            addIfPresent(queries, normalizeQuery(chinese.toString()));
            addIfPresent(queries, normalizeQuery(english.toString()));
            addIfPresent(queries, normalizeQuery(chinese + " " + english));
            return queries;
        }

        addIfPresent(queries, titleRegion);
        return queries;
    }

    private void addIfPresent(List<String> queries, String query) {
        String normalized = normalizeQuery(query);
        if (normalized != null && !queries.contains(normalized)) {
            queries.add(normalized);
        }
    }

    private void appendToken(StringBuilder builder, String token) {
        if (!builder.isEmpty()) {
            builder.append(' ');
        }
        builder.append(token);
    }

    private boolean containsChinese(String value) {
        return value != null && CHINESE.matcher(value).find();
    }

    private boolean containsAsciiLetter(String value) {
        return value != null && ASCII_LETTER.matcher(value).find();
    }

    private TitleSearchQueryType inferType(String query) {
        if (containsChinese(query) && containsAsciiLetter(query)) {
            return TitleSearchQueryType.COMBINED;
        }
        if (containsChinese(query)) {
            return TitleSearchQueryType.LOCALIZED;
        }
        return TitleSearchQueryType.ORIGINAL;
    }

    private void addQuery(List<TitleSearchQuery> queries, Set<String> seen, String query,
                          TitleSearchQueryType type) {
        String normalized = normalizeQuery(query);
        if (normalized != null && seen.add(normalized.toLowerCase(Locale.ROOT))) {
            queries.add(new TitleSearchQuery(normalized, type, weight(type)));
        }
    }

    private double weight(TitleSearchQueryType type) {
        return switch (type) {
            case LOCALIZED -> 1.0;
            case ORIGINAL -> 0.95;
            case COMBINED -> 0.85;
            case GUESSIT -> 0.75;
        };
    }

    private String normalizeQuery(String value) {
        if (value == null) {
            return null;
        }
        String normalized = value
                .replaceAll("[._]+", " ")
                .replaceAll("[\\[\\]【】()（）]", " ")
                .replaceAll("\\s+", " ")
                .trim();
        return normalized.isBlank() ? null : normalized;
    }

    private String trimSeparators(String value) {
        if (value == null) {
            return null;
        }
        return value.replaceAll("^[\\s._\\-]+|[\\s._\\-]+$", "");
    }
}
