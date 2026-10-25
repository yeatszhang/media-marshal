import { extname, posix } from "node:path";

// 沿用旧发现规则；null／未配置使用默认值，显式 [] 表示关闭可配置忽略。
export const defaultIgnoredFilePatterns = [
  ".DS_Store", "Thumbs.db", "desktop.ini", "*.part", "*.tmp", "*.crdownload", "*.lock", "~$*", ".*",
  "__MACOSX/", "@eaDir/", "sample/", "samples/",
] as const;

export function discoveryIgnore(patterns?: readonly string[] | null) {
  const effective = (patterns ?? defaultIgnoredFilePatterns).map((value) => value.trim().replace(/\\/g, "/").toLowerCase()).filter(Boolean);
  return (parts: readonly string[]) => effective.some((pattern) => {
    const directory = pattern.endsWith("/"), glob = directory ? pattern.slice(0, -1) : pattern;
    if (glob.includes("/")) return false;
    const names = directory ? parts : parts.slice(-1);
    // 文件名匹配应允许点开头；固定前缀避免 glob 对隐藏文件另作排除。
    return names.some((name) => name.toLowerCase() === glob || posix.matchesGlob("entry-" + name.toLowerCase(), "entry-" + glob));
  });
}

/** 只有同目录存在精确同基名主视频时才判作样片，不凭名称包含 sample 猜测。 */
export function sampleVideos(files: readonly string[][], isVideo: (name: string) => boolean) {
  const key = (parts: readonly string[]) => JSON.stringify(parts.map((part) => part.toLowerCase()));
  const main = new Set(files.filter((parts) => isVideo(parts.at(-1)!)).map((parts) => key([...parts.slice(0, -1), parts.at(-1)!.slice(0, -extname(parts.at(-1)!).length)])));
  return new Set(files.filter((parts) => {
    const name = parts.at(-1)!; if (!isVideo(name)) return false;
    const base = name.slice(0, -extname(name).length), match = /^(.*)(?:\.sample|-sample|_sample)$/i.exec(base);
    return !!match?.[1] && main.has(key([...parts.slice(0, -1), match[1]]));
  }).map((parts) => JSON.stringify(parts)));
}
