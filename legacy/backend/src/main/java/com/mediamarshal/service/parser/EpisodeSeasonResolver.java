package com.mediamarshal.service.parser;

import java.nio.file.Path;
import java.util.regex.Pattern;

/** 提取文件及目录中的季号线索；缺省第一季，最终编号仍须通过 TMDB 校验。 */
public final class EpisodeSeasonResolver {
    private static final Pattern SEASON = Pattern.compile(
            "(?i)(?:^|[^a-z0-9])(?:s|season[\\s._-]*)(\\d{1,3})(?=$|[^a-z0-9]|e\\d)|第\\s*([\\d零〇一二三四五六七八九十百两]{1,5})\\s*季");
    private static final Pattern SPECIAL = Pattern.compile(
            "(?i)(?:^|[^a-z0-9])(?:specials?|ova|oad|sp)(?=$|[^a-z0-9]|\\d)|特别篇|特別篇|特典");

    private EpisodeSeasonResolver() {}

    public static int resolve(Integer parsed, Integer suggested, Path source) {
        if (parsed != null) return parsed;
        // 先检查文件名，再从最近目录向上检查，避免覆盖明确的 S02 / 第三季 / 特别篇。
        Path part = source;
        for (int depth = 0; part != null && depth < 5; depth++, part = part.getParent()) {
            if (part.getFileName() == null) continue;
            String name = part.getFileName().toString();
            var marker = SEASON.matcher(name);
            if (marker.find()) {
                int value = marker.group(1) != null ? Integer.parseInt(marker.group(1)) : chineseNumber(marker.group(2));
                if (value >= 0 && value <= 999) return value;
            }
            if (SPECIAL.matcher(name).find()) return 0;
        }
        return suggested != null ? suggested : 1;
    }

    private static int chineseNumber(String text) {
        if (text.matches("\\d+")) return Integer.parseInt(text);
        String digits = "零一二三四五六七八九";
        int total = 0, current = 0;
        boolean units = text.contains("十") || text.contains("百");
        for (char ch : text.toCharArray()) {
            if (ch == '十' || ch == '百') {
                total += (current == 0 ? 1 : current) * (ch == '十' ? 10 : 100);
                current = 0;
            } else {
                int digit = ch == '两' ? 2 : ch == '〇' ? 0 : digits.indexOf(ch);
                if (digit < 0) return -1;
                current = units ? digit : current * 10 + digit;
            }
        }
        return total + current;
    }
}
