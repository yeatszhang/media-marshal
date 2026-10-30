// 仅在隔离 Main 关闭后准备合法 TMDB 缓存；不生成候选、文件计划或完成收据。
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { CoreDatabase } from "../../packages/media-core/dist/infrastructure/database.js";
const config = JSON.parse(await readFile(process.argv[2], "utf8"));
if (!/marshal-electron-/.test(config.database)) throw new Error("仅支持隔离窗口验收目录");
const database = await CoreDatabase.open(config.database, undefined, { exclusiveOwner: true });
const movie = { id: 1, title: "独立电影", original_title: "独立电影", release_date: "2026-01-01", genres: [] };
const tv = { id: 2, name: "独立剧集", original_name: "独立剧集", first_air_date: "2026-01-01", seasons: [{ season_number: 1 }] };
function cache(path, params, value) {
  const url = new URL(path, "https://api.themoviedb.org/3/"); url.searchParams.set("language", "zh-CN");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const key = createHash("sha256").update("tmdb-v1|" + url.href).digest("hex");
  database.connection.prepare("INSERT OR REPLACE INTO tmdb_cache VALUES(?,?,?)").run(key, JSON.stringify(value), Date.now() + 3600000);
}
try {
  for (const query of ["独立电影", "独立剧集", "completed"]) for (const type of ["movie", "tv"]) for (const year of [null, 2026]) {
    cache("search/" + type, { query, include_adult: "false", page: "1", ...(year ? { [type === "movie" ? "year" : "first_air_date_year"]: String(year) } : {}) }, { results: query === "独立电影" && type === "movie" ? [movie] : query === "独立剧集" && type === "tv" ? [tv] : [] });
  }
  cache("movie/1", {}, movie); cache("tv/2", {}, tv);
  cache("tv/2/season/1", {}, { episodes: [{ season_number: 1, episode_number: 1, name: "第一集" }] });
  console.log(JSON.stringify({ cacheOnly: true }));
} finally { database.close(); }
