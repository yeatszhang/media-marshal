import { inject, injectable, StatefulService } from "@yeatz/app-framework/ioc";
import type { CloudAccount, CloudAuthorization, CloudCredentialDraft, DesktopApi } from "@media-marshal/contracts";
import { DesktopClient } from "./desktop-client";

const message = (error: unknown) => error instanceof Error ? error.message : "账号操作失败，请重试";
/** 账号页只管理连接；凭据不保存在服务状态，轮询只查询授权作业。 */
@injectable()
export class CloudAccountsViewModel extends StatefulService<{ accounts: CloudAccount[]; loadingAccounts: boolean; authorization: CloudAuthorization | null; authorizing: boolean; loggingIn: boolean; error: string | null }> {
  protected initState = { accounts: [], loadingAccounts: false, authorization: null, authorizing: false, loggingIn: false, error: null };
  private watchers = 0; private epoch = 0; private request = 0; private stopped = false; private timer?: ReturnType<typeof setTimeout>;
  private authorizationKey: string | null = null; private loginKey: string | null = null; private refreshFlight?: Promise<void>;
  private cancellation?: { key: string; promise: Promise<void> };
  private queryError: string | null = null;
  constructor(@inject(DesktopClient) readonly client: DesktopApi) { super(); }
  refreshAccounts(): Promise<void> { if (this.stopped) return Promise.resolve(); return this.refreshFlight ??= this.readAccounts().finally(() => { this.refreshFlight = undefined; }); }
  private async readAccounts() {
    const request = ++this.request; this.setState({ loadingAccounts: true });
    try { const accounts = await this.client.listCloudAccounts(); if (!this.stopped && request === this.request) { this.setState({ accounts, error: this.queryError && this.state.error === this.queryError ? null : this.state.error }); this.queryError = null; } }
    catch (error) { if (!this.stopped && request === this.request) { this.queryError = message(error); this.setState({ error: this.queryError }); } }
    finally { if (!this.stopped && request === this.request) this.setState({ loadingAccounts: false }); }
  }
  watch() {
    if (this.stopped) return () => {};
    if (++this.watchers === 1) {
      const epoch = ++this.epoch;
      const tick = async () => {
        if (this.authorizationKey) {
          const key = this.authorizationKey;
          try { const job = await this.client.getCloudAuthorization(key); if (!this.stopped && epoch === this.epoch && this.authorizationKey === key && job) { this.setState({ authorization: job }); if (job.state !== "RUNNING") { this.authorizationKey = null; this.setState({ authorizing: false, error: job.failure?.message ?? null }); } } }
          catch (error) { if (!this.stopped && epoch === this.epoch) this.setState({ error: message(error) }); }
        }
        await this.refreshAccounts();
        if (!this.stopped && this.watchers && epoch === this.epoch) this.timer = setTimeout(() => { void tick(); }, 1500);
      }; void tick();
    }
    let released = false; return () => { if (released) return; released = true; if (!--this.watchers) { ++this.epoch; clearTimeout(this.timer); void this.cancelLogin(); } };
  }
  private remember(job: CloudAuthorization) { this.authorizationKey = job.state === "RUNNING" ? job.requestKey : null; this.setState({ authorization: job, authorizing: job.state === "RUNNING", error: job.failure?.message ?? null }); }
  async authorize(input: CloudCredentialDraft) {
    if (this.state.authorizing || this.state.loggingIn || this.stopped) return;
    this.authorizationKey = input.requestKey; this.setState({ authorizing: true, authorization: null, error: null });
    try { const job = await this.client.authorizeCloudAccount(input); if (this.stopped) return; this.remember(job); await this.refreshAccounts(); }
    catch (error) {
      if (this.stopped) throw error;
      const job = await this.client.getCloudAuthorization(input.requestKey).catch(() => null);
      if (job) this.remember(job); else { this.authorizationKey = null; this.setState({ authorizing: false, error: message(error) }); }
      throw error;
    }
  }
  async login(name: string, accountId?: string) {
    if (this.state.authorizing || this.state.loggingIn || this.stopped) return false;
    const requestKey = crypto.randomUUID(); this.loginKey = requestKey; this.setState({ loggingIn: true, authorization: null, error: null });
    try { const job = await this.client.loginCloudAccount({ name, accountId, requestKey }); if (this.stopped || !job) return false; this.remember(job); await this.refreshAccounts(); return true; }
    catch (error) {
      if (this.stopped) return false;
      const job = await this.client.getCloudAuthorization(requestKey).catch(() => null);
      if (this.stopped) return false;
      if (job) { this.remember(job); await this.refreshAccounts(); return true; }
      this.setState({ error: message(error) }); return false;
    } finally { if (this.loginKey === requestKey) { this.loginKey = null; if (this.cancellation?.key === requestKey) this.cancellation = undefined; if (!this.stopped) this.setState({ loggingIn: false }); } }
  }
  private cancelCurrentLogin(): Promise<void> {
    const key = this.loginKey; if (!key) return this.cancellation?.promise ?? Promise.resolve();
    if (this.cancellation?.key === key) return this.cancellation.promise;
    const promise = this.client.cancelCloudLogin(key).catch((error) => { if (this.cancellation?.promise === promise) this.cancellation = undefined; throw error; });
    this.cancellation = { key, promise }; return promise;
  }
  async cancelLogin() { try { await this.cancelCurrentLogin(); } catch (error) { if (!this.stopped) this.setState({ error: message(error) }); } }
  async disconnect(accountId: string) { if (this.stopped) return; try { await this.client.disconnectCloudAccount(accountId); await this.refreshAccounts(); } catch (error) { if (!this.stopped) this.setState({ error: message(error) }); } }
  async restore() { if (this.stopped) return; try { await this.client.restoreCloudAccounts(); await this.refreshAccounts(); } catch (error) { if (!this.stopped) this.setState({ error: message(error) }); } }
  protected async dispose() { this.stopped = true; ++this.epoch; ++this.request; clearTimeout(this.timer); await this.cancelCurrentLogin(); }
}
