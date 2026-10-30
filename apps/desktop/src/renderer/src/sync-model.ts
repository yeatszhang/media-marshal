import { inject, injectable, StatefulService } from "@yeatz/app-framework/ioc";
import type { CoreInput, CoreOutput, DesktopApi, SyncSourceRule } from "@media-marshal/contracts";
import { DesktopClient } from "./desktop-client";
const message = (error: unknown) => error instanceof Error ? error.message : "同步操作未完成，请核对原目录、连接及任务后重试";
export const syncVersions = (row: SyncSourceRule) => ({ id: row.id, expectedVersion: row.version, expectedDraftRevision: row.draftRevision, expectedLifecycleRevision: row.lifecycleRevision });
@injectable()
export class SyncViewModel extends StatefulService<{ items: SyncSourceRule[]; directories: CoreOutput<"configuration.directories">; defaults: CoreOutput<"configuration.default"> | null; accounts: Awaited<ReturnType<DesktopApi["listCloudAccounts"]>>; jobs: CoreOutput<"sync.jobs">; paused: boolean; busy: boolean; error: string | null; queryError: string | null }> {
  protected initState = { items: [], directories: [], defaults: null, accounts: [], jobs: { items: [], total: 0 }, paused: false, busy: false, error: null, queryError: null };
  private watchers = 0; private epoch = 0; private generation = 0; private stopped = false; private timer?: ReturnType<typeof setTimeout>; private flight?: Promise<void>;
  private intents = new Map<string, string>();
  constructor(@inject(DesktopClient) readonly client: DesktopApi) { super(); }
  watch() { if (this.stopped) return () => {}; if (++this.watchers === 1) { const epoch = ++this.epoch; const poll = async () => { await this.refresh(); if (!this.stopped && this.watchers && epoch === this.epoch) this.timer = setTimeout(() => { void poll(); }, 2000); }; void poll(); } let released = false; return () => { if (!released && !--this.watchers) { this.epoch++; this.generation++; this.flight = undefined; clearTimeout(this.timer); } released = true; }; }
  refresh(force = false): Promise<void> {
    if (this.stopped || this.state.busy && !force) return Promise.resolve(); if (this.flight && !force) return this.flight;
    const generation = ++this.generation;
    const task = Promise.resolve().then(() => this.stopped || generation !== this.generation ? null : Promise.all([this.client.listSyncSources({ includeDeleted: true }), this.client.listConfigurationDirectories(), this.client.getDefaultDownloadDirectory(), this.client.listCloudAccounts(), this.client.listSyncJobs(), this.client.getCloudDownloadPause()])).then((result) => { if (result && !this.stopped && generation === this.generation) { const [items, directories, defaults, accounts, jobs, pause] = result; this.setState({ items, directories, defaults, accounts, jobs, paused: pause.paused, queryError: null }); } }).catch((error) => { if (!this.stopped && generation === this.generation) this.setState({ queryError: message(error) }); }).finally(() => { if (this.flight === task) this.flight = undefined; });
    return this.flight = task;
  }
  async command<T>(signature: string, action: (requestKey: string) => Promise<T>): Promise<T | null> {
    if (this.stopped || this.state.busy) return null;
    const key = this.intents.get(signature) ?? crypto.randomUUID(); this.intents.set(signature, key); this.generation++; this.setState({ busy: true, error: null });
    try { const result = await action(key); this.intents.delete(signature); if (!this.stopped && this.watchers) await this.refresh(true); return result; }
    catch (error) { if (typeof error === "object" && error && "code" in error && error.code === "CONFLICT") this.intents.delete(signature); if (!this.stopped) this.setState({ error: message(error) }); return null; }
    finally { if (!this.stopped) this.setState({ busy: false }); }
  }
  save(input: Omit<CoreInput<"sync.save">, "requestKey">) { return this.command("save:" + JSON.stringify(input), (requestKey) => this.client.saveSyncSource({ ...input, requestKey })); }
  preview(input: Omit<CoreInput<"sync.preview">, "requestKey">) { return this.command("preview:" + JSON.stringify(input), (requestKey) => this.client.previewSyncSource({ ...input, requestKey })); }
  confirm(input: Omit<CoreInput<"sync.confirm">, "requestKey">) { return this.command("confirm:" + JSON.stringify(input), (requestKey) => this.client.confirmSyncSource({ ...input, requestKey })); }
  control(row: SyncSourceRule, operation: CoreInput<"sync.control">["operation"]) { const input = { ...syncVersions(row), operation }; return this.command("control:" + JSON.stringify(input), (requestKey) => this.client.controlSyncSource({ ...input, requestKey })); }
  protected dispose() { this.stopped = true; this.epoch++; this.generation++; clearTimeout(this.timer); }
}
