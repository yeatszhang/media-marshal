import { z } from "zod";
import { requestJson, MediaNetworkError } from "./json-http.js";

const identifier = z.string().regex(/^[a-zA-Z0-9-]{1,128}$/), path = z.string().min(1).max(16384);
const librarySchema = z.object({ ItemId: identifier.optional(), Id: identifier.optional(), Name: z.string().max(500), Locations: z.array(path).max(100), CollectionType: z.string().max(100).optional() }).refine((row) => !!(row.ItemId ?? row.Id));
const itemSchema = z.object({ Id: identifier, Path: path.optional(), Type: z.string().max(100).optional(), ProviderIds: z.record(z.string().max(100), z.string().max(500)).optional(), ParentIndexNumber: z.number().int().nonnegative().optional(), IndexNumber: z.number().int().positive().optional(), IndexNumberEnd: z.number().int().positive().nullable().optional(), SeriesId: identifier.optional(), MediaSources: z.array(z.object({ Path: path.optional() })).max(100).optional() });
export type EmbyItem = z.infer<typeof itemSchema>;
export interface EmbyLibrary { id: string; name: string; paths: string[]; type: string | null }
/** 连接只使用显式地址和请求头；绝不继承 TMDB 代理、环境代理或服务端返回的其他地址。 */
export class EmbyClient {
  readonly base: URL;
  constructor(address: string, private readonly key: string | null, private readonly timeoutMs = 10000) {
    try { this.base = new URL(address); if (!["http:", "https:"].includes(this.base.protocol) || this.base.username || this.base.password || this.base.search || this.base.hash) throw new Error(); this.base.pathname = this.base.pathname.replace(/\/$/, "") + "/"; }
    catch { throw new MediaNetworkError("INVALID_RESPONSE"); }
  }
  private async get<T>(route: string, schema: z.ZodType<T>, signal?: AbortSignal, params: Record<string, string> = {}) {
    const raw = await this.request(route, "GET", signal, params), parsed = schema.safeParse(raw); if (!parsed.success) throw new MediaNetworkError("INVALID_RESPONSE"); return parsed.data;
  }
  private request(route: string, method: "GET" | "POST", signal?: AbortSignal, params: Record<string, string> = {}) {
    if (!this.key || this.key.length > 1024 || /[\r\n\0]/.test(this.key)) throw new MediaNetworkError("AUTH_REQUIRED");
    const url = new URL(route, this.base); for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    return requestJson(url, { method, headers: { "X-Emby-Token": this.key }, signal, timeoutMs: this.timeoutMs, emptyResponse: method === "POST" });
  }
  info(signal?: AbortSignal) { return this.get("System/Info", z.object({ Id: identifier, Version: z.string().max(100), ServerName: z.string().max(500).optional() }), signal); }
  async libraries(signal?: AbortSignal): Promise<EmbyLibrary[]> {
    const result: EmbyLibrary[] = []; let total: number | null = null;
    for (let start = 0; start < 1000; start += 100) {
      const page = await this.get("Library/VirtualFolders/Query", z.object({ Items: z.array(librarySchema).max(100), TotalRecordCount: z.number().int().min(0).max(1000) }), signal, { StartIndex: String(start), Limit: "100" });
      if (total !== null && page.TotalRecordCount !== total) throw new MediaNetworkError("INVALID_RESPONSE"); total = page.TotalRecordCount;
      result.push(...page.Items.map((row) => ({ id: (row.ItemId ?? row.Id)!, name: row.Name, paths: row.Locations, type: row.CollectionType ?? null })));
      if (result.length >= total) { if (result.length !== total || new Set(result.map((row) => row.id)).size !== result.length) throw new MediaNetworkError("INVALID_RESPONSE"); return result; }
      if (!page.Items.length) throw new MediaNetworkError("INVALID_RESPONSE");
    } throw new MediaNetworkError("INVALID_RESPONSE");
  }
  refresh(signal?: AbortSignal) { return this.request("Library/Refresh", "POST", signal); }
  async items(libraryId: string, signal?: AbortSignal, wantedPaths?: readonly string[]): Promise<EmbyItem[]> {
    identifier.parse(libraryId); const result: EmbyItem[] = [], seen = new Set<string>(), wanted = wantedPaths ? new Set(wantedPaths.map((path) => path.normalize("NFC").toLowerCase())) : null; let total: number | null = null, count = 0, bytes = 0;
    for (let start = 0; start < 100000; start += 200) {
      const page = await this.get("Items", z.object({ Items: z.array(itemSchema).max(200), TotalRecordCount: z.number().int().min(0).max(100000) }), signal, { ParentId: libraryId, Recursive: "true", IncludeItemTypes: "Movie,Episode", Fields: "Path,ProviderIds,MediaSources", EnableImages: "false", EnableUserData: "false", StartIndex: String(start), Limit: "200", SortBy: "SortName", SortOrder: "Ascending" });
      if (total !== null && total !== page.TotalRecordCount) throw new MediaNetworkError("INVALID_RESPONSE"); total = page.TotalRecordCount; count += page.Items.length;
      for (const item of page.Items) { if (seen.has(item.Id)) throw new MediaNetworkError("INVALID_RESPONSE"); seen.add(item.Id); if (!wanted || [item.Path, ...(item.MediaSources?.map((source) => source.Path) ?? [])].some((path) => path && wanted.has(path.normalize("NFC").toLowerCase()))) { bytes += Buffer.byteLength(JSON.stringify(item)); if (bytes > 32 * 1024 * 1024) throw new MediaNetworkError("INVALID_RESPONSE"); result.push(item); } }
      if (count >= total) { if (count !== total) throw new MediaNetworkError("INVALID_RESPONSE"); return result; }
      if (!page.Items.length) throw new MediaNetworkError("INVALID_RESPONSE");
    } throw new MediaNetworkError("INVALID_RESPONSE");
  }
  async series(ids: readonly string[], signal?: AbortSignal) {
    if (!ids.length) return [];
    if (ids.length > 100) throw new MediaNetworkError("INVALID_RESPONSE"); ids.forEach((id) => identifier.parse(id));
    return (await this.get("Items", z.object({ Items: z.array(itemSchema).max(100), TotalRecordCount: z.number().int().min(0).max(100) }), signal, { Ids: ids.join(","), Fields: "ProviderIds", EnableImages: "false", EnableUserData: "false", Limit: "100" })).Items;
  }
  itemUrl(itemId: string, serverId: string) { identifier.parse(itemId); identifier.parse(serverId); const url = new URL("web/index.html", this.base); url.hash = "!/item?id=" + encodeURIComponent(itemId) + "&serverId=" + encodeURIComponent(serverId); return url.href; }
}
