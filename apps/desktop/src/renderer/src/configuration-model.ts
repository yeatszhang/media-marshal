import { inject, injectable, StatefulService } from "@yeatz/app-framework/ioc";
import type { CoreInput, CoreOutput, DesktopApi } from "@media-marshal/contracts";
import { DesktopClient } from "./desktop-client";
const message = (error: unknown) => error instanceof Error ? error.message : "目录操作未完成，请检查原磁盘和授权后重试";
@injectable()
export class ConfigurationViewModel extends StatefulService<{ directories: CoreOutput<"configuration.directories">; defaults: CoreOutput<"configuration.default"> | null; error: string | null; errorAction: "choose" | "save" | null; queryError: string | null; busy: boolean }> {
  protected initState = { directories: [], defaults: null, error: null, errorAction: null, queryError: null, busy: false };
  private generation = 0; private stopped = false; private watchers = 0; private epoch = 0; private timer?: ReturnType<typeof setTimeout>; private flight?: Promise<void>;
  private intent?: { signature: string; input: CoreInput<"configuration.set-default"> };
  constructor(@inject(DesktopClient) private readonly client: DesktopApi) { super(); }
  watch() {
    if (this.stopped) return () => {};
    if (++this.watchers === 1) { const epoch = ++this.epoch; const poll = async () => { await this.refresh(); if (!this.stopped && epoch === this.epoch && this.watchers) this.timer = setTimeout(() => { void poll(); }, 3000); }; void poll(); }
    let released = false; return () => { if (!released && !--this.watchers) { this.epoch++; this.generation++; this.flight = undefined; clearTimeout(this.timer); } released = true; };
  }
  refresh(force = false): Promise<void> {
    if (this.stopped || this.state.busy && !force) return Promise.resolve(); if (!force && this.flight) return this.flight;
    const generation = ++this.generation;
    const task = Promise.resolve().then(() => this.stopped || generation !== this.generation ? null : Promise.all([this.client.listConfigurationDirectories(), this.client.getDefaultDownloadDirectory()])).then((result) => { if (result && !this.stopped && generation === this.generation) { const [directories, defaults] = result; this.setState({ directories, defaults, queryError: null }); } }).catch((error) => { if (!this.stopped && generation === this.generation) this.setState({ queryError: message(error) }); }).finally(() => { if (this.flight === task) this.flight = undefined; });
    return this.flight = task;
  }
  async choose(kind: "ordinary" | "managed") {
    if (this.stopped || this.state.busy) return null;
    this.setState({ busy: true, error: null, errorAction: null }); this.generation++; const epoch = this.epoch;
    try { const result = await this.client.chooseConfigurationDirectory(kind); if (this.stopped || epoch !== this.epoch || !this.watchers) return null; await this.refresh(true); return this.stopped || epoch !== this.epoch ? null : result; }
    catch (error) { if (!this.stopped && epoch === this.epoch && this.watchers) this.setState({ error: message(error), errorAction: "choose" }); return null; }
    finally { if (!this.stopped) this.setState({ busy: false }); }
  }
  async saveDefault(directoryId: string | null) {
    if (this.stopped || this.state.busy || !this.state.defaults) return false;
    const signature = JSON.stringify({ directoryId, expectedVersion: this.state.defaults.version });
    if (!this.intent || this.intent.input.directoryId !== directoryId) this.intent = { signature, input: { directoryId, expectedVersion: this.state.defaults.version, requestKey: crypto.randomUUID() } };
    this.setState({ busy: true, error: null, errorAction: null }); this.generation++; const epoch = this.epoch;
    try { const defaults = await this.client.setDefaultDownloadDirectory(this.intent.input); if (this.stopped || epoch !== this.epoch || !this.watchers) return true; this.generation++; this.setState({ defaults }); this.intent = undefined; await this.refresh(true); return true; }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "CONFLICT") this.intent = undefined; if (!this.stopped && epoch === this.epoch && this.watchers) this.setState({ error: message(error), errorAction: "save" }); return false; }
    finally { if (!this.stopped) this.setState({ busy: false }); }
  }
  protected dispose() { this.stopped = true; this.generation++; this.epoch++; clearTimeout(this.timer); }
}
