import { inject, injectable, StatefulService } from "@yeatz/app-framework/ioc";
import type { CoreInput, CoreOutput, DesktopApi, RecognitionRule } from "@media-marshal/contracts";
import { DesktopClient } from "./desktop-client";
export const recognitionVersions = (row: RecognitionRule) => ({ id: row.id, expectedVersion: row.version, expectedDraftRevision: row.draftRevision, expectedLifecycleRevision: row.lifecycleRevision });
const message = (error: unknown) => error instanceof Error ? error.message : "识别配置操作未完成，请核对原目录和任务后重试";
@injectable()
export class RecognitionViewModel extends StatefulService<{ items: RecognitionRule[]; directories: CoreOutput<"configuration.directories">; defaults: CoreOutput<"configuration.default"> | null; paused: boolean; busy: boolean; error: string | null; queryError: string | null }> {
  protected initState = { items: [], directories: [], defaults: null, paused: false, busy: false, error: null, queryError: null };
  private stopped = false; private generation = 0; private epoch = 0; private watchers = 0; private timer?: ReturnType<typeof setTimeout>; private flight?: Promise<void>; private intents = new Map<string, string>();
  constructor(@inject(DesktopClient) readonly client: DesktopApi) { super(); }
  watch() { if (this.stopped) return () => {}; if (++this.watchers === 1) { const epoch = ++this.epoch; const poll = async () => { await this.refresh(); if (!this.stopped && this.watchers && epoch === this.epoch) this.timer = setTimeout(() => { void poll(); }, 2000); }; void poll(); } let released = false; return () => { if (!released && !--this.watchers) { this.epoch++; this.generation++; this.flight = undefined; clearTimeout(this.timer); } released = true; }; }
  refresh(force = false): Promise<void> {
    if (this.stopped || this.state.busy && !force) return Promise.resolve(); if (this.flight && !force) return this.flight; const generation = ++this.generation;
    const task = Promise.resolve().then(() => this.stopped || generation !== this.generation ? null : Promise.all([this.client.listRecognitionRules({ includeDeleted: true }), this.client.listConfigurationDirectories(), this.client.getDefaultDownloadDirectory(), this.client.getOrganizePause()])).then((result) => { if (result && !this.stopped && generation === this.generation) { const [items, directories, defaults, pause] = result; this.setState({ items, directories, defaults, paused: pause.paused, queryError: null }); } }).catch((error) => { if (!this.stopped && generation === this.generation) this.setState({ queryError: message(error) }); }).finally(() => { if (this.flight === task) this.flight = undefined; }); return this.flight = task;
  }
  async command<T>(signature: string, action: (key: string) => Promise<T>): Promise<T | null> {
    if (this.stopped || this.state.busy) return null; const key = this.intents.get(signature) ?? crypto.randomUUID(); this.intents.set(signature, key); this.generation++; this.setState({ busy: true, error: null });
    try { const result = await action(key); this.intents.delete(signature); if (!this.stopped && this.watchers) await this.refresh(true); return result; }
    catch (error) { if (error && typeof error === "object" && "code" in error && error.code === "CONFLICT") this.intents.delete(signature); if (!this.stopped) this.setState({ error: message(error) }); return null; }
    finally { if (!this.stopped) this.setState({ busy: false }); }
  }
  save(input: Omit<CoreInput<"recognition.save">, "requestKey">) { return this.command("save:" + JSON.stringify(input), (requestKey) => this.client.saveRecognitionRule({ ...input, requestKey })); }
  preview(input: Omit<CoreInput<"recognition.preview">, "requestKey">) { return this.command("preview:" + JSON.stringify(input), (requestKey) => this.client.previewRecognitionRule({ ...input, requestKey })); }
  control(row: RecognitionRule, operation: CoreInput<"recognition.control">["operation"]) { const input = { ...recognitionVersions(row), operation }; return this.command("control:" + JSON.stringify(input), (requestKey) => this.client.controlRecognitionRule({ ...input, requestKey })); }
  protected dispose() { this.stopped = true; this.epoch++; this.generation++; clearTimeout(this.timer); this.intents.clear(); }
}
