import { createIdentifier } from "@yeatz/app-framework/ioc";
import type { SettingsDraft } from "@media-marshal/contracts";
import type { CoreDatabase } from "../infrastructure/database.js";
import { TmdbClient, type TmdbOptions } from "../infrastructure/tmdb.js";
import { MediaNetworkError } from "../infrastructure/json-http.js";

export const MediaConnectionsToken = createIdentifier<MediaConnections>("media-core.connections");
/** 只由私有宿主通道注入。更换设置或凭据会中断旧请求，防止旧连接结果覆盖新配置。 */
export class MediaConnections {
  private secrets: { tmdb: string | null; emby: string | null } = { tmdb: null, emby: null };
  private client?: TmdbClient;
  private stopped = false;
  private revision = 0;
  private injected = false;
  constructor(private readonly database: CoreDatabase, private readonly settings: () => SettingsDraft, private readonly testTmdb: Pick<TmdbOptions, "baseUrl" | "timeoutMs"> = {}) {}
  get version() { return this.revision; }
  get installed() { return this.injected && !this.stopped; }
  get tmdb() { if (this.stopped) throw new MediaNetworkError("INTERRUPTED"); if (!this.client) this.reconfigure(); return this.client!; }
  get embyKey() { return this.stopped ? null : this.secrets.emby; }
  install(input: { tmdb: string | null; emby: string | null }) { this.injected = true; this.secrets = { ...input }; this.reconfigure(); return {}; }
  reconfigure() {
    this.client?.close(); this.client = undefined; this.revision++;
    if (this.stopped) return;
    const settings = this.settings();
    this.client = new TmdbClient(this.database, { ...this.testTmdb, apiKey: this.secrets.tmdb, proxy: settings.tmdbProxy, language: settings.language === "en" ? "en-US" : "zh-CN" });
  }
  close() { this.stopped = true; this.client?.close(); this.client = undefined; this.secrets = { tmdb: null, emby: null }; this.revision++; }
}
