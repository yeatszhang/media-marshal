import { inject, injectable, StatefulService } from "@yeatz/app-framework/ioc";
import type { CoreOutput, DesktopApi, IngestionSeason } from "@media-marshal/contracts";
import { DesktopClient } from "./desktop-client";
@injectable()
export class SeasonsViewModel extends StatefulService<{ groups: IngestionSeason[]; total: number; page: number; selected: IngestionSeason | null; memberPage: number; detail: CoreOutput<"ingestion.season"> | null; error: string | null; loading: boolean }> {
  protected initState = { groups: [], total: 0, page: 1, selected: null, memberPage: 1, detail: null, error: null, loading: true };
  private owner = 0; private request = 0; private stopped = false; private timer?: ReturnType<typeof setTimeout>;
  constructor(@inject(DesktopClient) private readonly client: DesktopApi) { super(); }
  watch() { if (this.stopped) return () => {}; const owner = ++this.owner; const tick = async () => { await this.refresh(); if (!this.stopped && owner === this.owner) this.timer = setTimeout(() => { void tick(); }, 2000); }; void tick(); return () => { if (owner === this.owner) { ++this.owner; ++this.request; clearTimeout(this.timer); } }; }
  async refresh(page = this.state.page, selected = this.state.selected, memberPage = this.state.memberPage) {
    if (this.stopped) return; const request = ++this.request, owner = this.owner;
    try {
      const [groups, detail] = await Promise.all([this.client.listIngestionSeasons({ page }), selected ? this.client.getIngestionSeason({ id: selected.id, sourceId: selected.sourceId, page: memberPage }).catch((error: unknown) => ({ error })) : null]);
      if (this.stopped || request !== this.request || owner !== this.owner) return;
      const error = detail && "error" in detail ? detail.error instanceof Error ? detail.error.message : "此季集候选组已变化，请刷新后重新选择" : null;
      this.setState({ groups: groups.items, total: groups.total, page, selected: error ? null : selected, memberPage, detail: detail && !("error" in detail) ? detail : null, error, loading: false });
    } catch (error) { if (!this.stopped && request === this.request && owner === this.owner) this.setState({ error: error instanceof Error ? error.message : "季集候选组暂不可读，请刷新后重试", loading: false }); }
  }
  select(group: IngestionSeason, memberPage = 1) { this.setState({ selected: group, detail: null, memberPage }); return this.refresh(this.state.page, group, memberPage); }
  page(page: number) { this.setState({ selected: null, detail: null }); return this.refresh(page, null, 1); }
  protected dispose() { this.stopped = true; ++this.owner; ++this.request; clearTimeout(this.timer); }
}
