package com.mediamarshal.service.matcher;

import com.mediamarshal.model.dto.ParseResult;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class TitleSearchPlanBuilderTest {

    private final TitleSearchPlanBuilder builder = new TitleSearchPlanBuilder();

    @Test
    void buildsChineseAndEnglishQueriesForBilingualMovieTitle() {
        TitleSearchPlan plan = builder.build(parse("飞驰人生3.Pegasus.3.2026.2160p.WEB-DL.mkv", "飞驰人生3 Pegasus 3", 2026, null));

        assertThat(assertQueries(plan)).containsSubsequence("飞驰人生3", "Pegasus 3");
    }

    @Test
    void buildsChineseAndEnglishQueriesForBilingualSeriesTitle() {
        TitleSearchPlan plan = builder.build(parse("长乐曲.Melody.Of.Golden.Age.S01E01.2024.1080p.mkv", "长乐曲", 2024, 1));

        assertThat(assertQueries(plan)).containsSubsequence("长乐曲", "Melody Of Golden Age");
    }

    @Test
    void extractsBracketedChineseAndEnglishTitle() {
        TitleSearchPlan plan = builder.build(parse("[钢铁森林].Sunsets.Secrets.Regrets.S01E01.2025.1080p.mkv", "钢铁森林", 2025, 1));

        assertThat(assertQueries(plan)).containsSubsequence("钢铁森林", "Sunsets Secrets Regrets");
    }

    @Test
    void extractsBracketedChineseAndEnglishTitleWithShortChineseName() {
        TitleSearchPlan plan = builder.build(parse("[逍遥].The.Unclouded.Soul.S01E01.2026.1080p.mkv", "逍遥", 2026, 1));

        assertThat(assertQueries(plan)).containsSubsequence("逍遥", "The Unclouded Soul");
    }

    @Test
    void buildsChineseAndEnglishQueriesForEightHundredSeriesTitle() {
        TitleSearchPlan plan = builder.build(parse(
                "方圆八百米.Eight.Hundred.S01E02.2026.2160p.WEB-DL.H265.AAC-HHWEB.mp4",
                "方圆八百米",
                2026,
                1));

        assertThat(assertQueries(plan)).containsSubsequence("方圆八百米", "Eight Hundred");
    }

    @Test
    void doesNotUseEpisodeTitleAsSeriesQuery() {
        TitleSearchPlan plan = builder.build(parse(
                "Your.Friends.and.Neighbors.S01E01.This.Is.What.Happens.2025.1080p.mkv",
                "Your Friends and Neighbors",
                2025,
                1));

        assertThat(assertQueries(plan)).contains("Your Friends and Neighbors");
        assertThat(assertQueries(plan)).noneMatch(query -> query.contains("This Is What Happens"));
    }

    @ParameterizedTest
    @ValueSource(strings = {
            "[BeanSub&FZSD][Jujutsu_Kaisen][48][GB][1080P][x264_AAC].mp4",
            "[BeanSub&FZSD][Jujutsu_Kaisen][48][GB][1080P][x264_AAC]-4439f0c824f5.mp4",
            "[BeanSub&FZSD][Jujutsu_Kaisen][048v2][CHS][1080p].mkv",
            "【BeanSub&FZSD】【Jujutsu_Kaisen】【48】【GB】【1080P】.mp4",
            "[1080p][BeanSub&FZSD][Jujutsu_Kaisen][48][GB].mp4",
            "[x264_AAC][CHS+CHT][BeanSub&FZSD][Jujutsu_Kaisen][48].mkv",
            "[BeanSub&FZSD][Jujutsu_Kaisen][GB][1080P].mp4",
            "（BeanSub&FZSD）（Jujutsu_Kaisen）（48）（GB）.mp4"
    })
    void extractsAnimeTitleWhenGuessitReturnsNoTitle(String filename) {
        ParseResult parsed = anime(filename, "BeanSub&FZSD");

        TitleSearchPlan plan = builder.build(parsed);

        assertThat(assertQueries(plan)).containsExactly("Jujutsu Kaisen");
        assertThat(plan.queries().getFirst().type()).isEqualTo(TitleSearchQueryType.ORIGINAL);
    }

    @Test
    void recognizesExplicitSubtitleGroupWithoutGuessitReleaseGroup() {
        assertThat(assertQueries(builder.build(anime(
                "[BeanSub&FZSD][Jujutsu_Kaisen][48][GB][1080P].mp4", null))))
                .containsExactly("Jujutsu Kaisen");
    }

    @Test
    void removesKnownReleaseGroupWithoutAssumingEveryLeadingBracketIsAGroup() {
        assertThat(assertQueries(builder.build(anime(
                "[Example-Raws] Jujutsu_Kaisen [48-49][1080p].mkv", "Example-Raws"))))
                .containsExactly("Jujutsu Kaisen");
    }

    @Test
    void extractsSeparateBilingualBracketedTitles() {
        assertThat(assertQueries(builder.build(anime(
                "[字幕组][咒术回战][Jujutsu_Kaisen][48][GB][1080P].mp4", "字幕组"))))
                .containsExactly("咒术回战", "Jujutsu Kaisen", "咒术回战 Jujutsu Kaisen");
    }

    @Test
    void preservesBracketedTitleWithoutReleaseGroup() {
        assertThat(assertQueries(builder.build(anime(
                "[Jujutsu_Kaisen][48][GB][1080P].mp4", null))))
                .containsExactly("Jujutsu Kaisen");
    }

    @Test
    void preservesNumericTitleAndTitleNumbers() {
        assertThat(assertQueries(builder.build(anime("[86][48][CHS][1080p].mkv", null))))
                .containsExactly("86");
        assertThat(assertQueries(builder.build(anime("[Mob_Psycho_100][48][1080p].mkv", null))))
                .containsExactly("Mob Psycho 100");
    }

    @Test
    void doesNotDiscardUnknownBracketedTextAsReleaseGroup() {
        assertThat(assertQueries(builder.build(anime("[Odd_Taxi][48][1080p].mkv", null))))
                .containsExactly("Odd Taxi");
    }

    @Test
    void preservesUnmarkedParentheticalTitle() {
        assertThat(assertQueries(builder.build(parse("It.(Chapter.Two).2019.1080p.mkv", null, 2019, null))))
                .containsExactly("It Chapter Two");
    }

    @Test
    void keepsGuessitTitleAsFallbackAndDeduplicatesIt() {
        ParseResult parsed = anime("[BeanSub][Jujutsu_Kaisen][48][GB].mp4", "BeanSub");
        parsed.setTitle("Jujutsu Kaisen");
        assertThat(assertQueries(builder.build(parsed))).containsExactly("Jujutsu Kaisen");

        parsed.setOriginalFilename(null);
        assertThat(assertQueries(builder.build(parsed))).containsExactly("Jujutsu Kaisen");
    }

    @Test
    void doesNotGenerateQueriesFromMetadataOnlyFilename() {
        assertThat(assertQueries(builder.build(anime("[BeanSub][GB][1080p][x264_AAC].mp4", "BeanSub"))))
                .isEmpty();
    }

    private ParseResult anime(String filename, String releaseGroup) {
        ParseResult parsed = parse(filename, null, null, null);
        parsed.setType("episode");
        parsed.setEpisode(48);
        parsed.setReleaseGroup(releaseGroup);
        return parsed;
    }

    private ParseResult parse(String originalFilename, String title, Integer year, Integer season) {
        ParseResult parseResult = new ParseResult();
        parseResult.setOriginalFilename(originalFilename);
        parseResult.setTitle(title);
        parseResult.setYear(year);
        parseResult.setSeason(season);
        parseResult.setType(season == null ? "movie" : "episode");
        return parseResult;
    }

    private List<String> assertQueries(TitleSearchPlan plan) {
        return plan.queries().stream()
                .map(TitleSearchQuery::query)
                .toList();
    }
}
