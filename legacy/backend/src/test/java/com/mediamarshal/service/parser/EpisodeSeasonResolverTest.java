package com.mediamarshal.service.parser;

import org.junit.jupiter.api.Test;
import java.nio.file.Path;
import static org.assertj.core.api.Assertions.assertThat;

class EpisodeSeasonResolverTest {
    @Test
    void defaultsToFirstSeasonAndPreservesExplicitSeasons() {
        assertThat(EpisodeSeasonResolver.resolve(null, null, Path.of("/剧/某剧/03.mkv"))).isEqualTo(1);
        assertThat(EpisodeSeasonResolver.resolve(2, 1, Path.of("/剧/某剧/03.mkv"))).isEqualTo(2);
        assertThat(EpisodeSeasonResolver.resolve(0, 1, Path.of("/剧/某剧/03.mkv"))).isZero();
        assertThat(EpisodeSeasonResolver.resolve(null, 3, Path.of("/剧/某剧/03.mkv"))).isEqualTo(3);
    }

    @Test
    void explicitPathMarkersOverrideModelAndDefault() {
        for (String folder : new String[]{"S02", "Season 02", "第二季", "第2季"}) {
            assertThat(EpisodeSeasonResolver.resolve(null, 1, Path.of("/剧/" + folder + "/03.mkv"))).isEqualTo(2);
        }
        assertThat(EpisodeSeasonResolver.resolve(null, null, Path.of("/剧/第十二季/03.mkv"))).isEqualTo(12);
        assertThat(EpisodeSeasonResolver.resolve(null, 1, Path.of("/剧/S02/某剧.S03E01.mkv"))).isEqualTo(3);
        assertThat(EpisodeSeasonResolver.resolve(null, null, Path.of("/剧/某剧S02E01.mkv"))).isEqualTo(2);
        for (String folder : new String[]{"Specials", "特别篇", "OVA", "SP"}) {
            assertThat(EpisodeSeasonResolver.resolve(null, 1, Path.of("/剧/" + folder + "/03.mkv"))).isZero();
        }
    }
}
