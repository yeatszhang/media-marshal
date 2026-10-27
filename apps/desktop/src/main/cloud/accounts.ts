import { createHash } from "node:crypto";
import { CloudError, cloudFailure, cloudErrorCodeSchema, cloudCredentialDraftSchema, type CloudAuthorization, type CloudCredentialDraft } from "@media-marshal/contracts";
import type { PrivateCoreAction, PrivateCoreInput, PrivateCoreOutput } from "@media-marshal/contracts/internal/core";
import type { Credentials } from "../credentials";
import type { AccountCredentials } from "./account-credentials";

export interface PrivateAccountCore {
  requestPrivate<K extends PrivateCoreAction>(action: K, input: PrivateCoreInput<K>): Promise<PrivateCoreOutput<K>>;
}
function failure(error: unknown) {
  if (error instanceof CloudError) return cloudFailure(error);
  const code = cloudErrorCodeSchema.safeParse((error as { code?: unknown } | null)?.code);
  return cloudFailure(new CloudError(code.success ? code.data : "INTERNAL_ERROR"));
}
/** 凭据只经 Main→Host，Core 只收到候选、保险箱引用和验证结果。 */
export class CloudAccountController {
  private jobs = new Map<string, Promise<void>>();
  private queues = new Map<string, Promise<void>>();
  private restoring?: Promise<void>;
  private stopped = false;
  private preparing = 0;
  constructor(private readonly core: PrivateAccountCore, private readonly credentials: AccountCredentials, private readonly vault: Credentials) {}
  private serial(accountId: string, work: () => Promise<void>) {
    const task = (this.queues.get(accountId) ?? Promise.resolve()).catch(() => {}).then(work);
    const tail = task.catch(() => {}); this.queues.set(accountId, tail);
    void tail.finally(() => { if (this.queues.get(accountId) === tail) this.queues.delete(accountId); });
    return task;
  }
  authorize(value: CloudCredentialDraft): Promise<CloudAuthorization> { return this.migrate(value, "openlist.quark"); }
  /** 仅供 Main 内受控的实现迁移入口；Renderer 不接收实现 ID 或原生参数。 */
  async migrate(value: CloudCredentialDraft, implementationId: string): Promise<CloudAuthorization> {
    if (this.stopped) throw new CloudError("INTERRUPTED");
    const input = cloudCredentialDraftSchema.parse(value);
    this.preparing++;
    let prepared;
    try { prepared = await this.core.requestPrivate("cloud.authorization.begin", { accountId: input.accountId, name: input.name, requestKey: input.requestKey, implementationId }); }
    finally { this.preparing--; }
    if (this.stopped) throw new CloudError("INTERRUPTED");
    if (prepared.job.state !== "RUNNING" || this.jobs.has(prepared.job.id)) return prepared.job;
    const { candidate, previous, job } = prepared;
    let secret: string | undefined = input.cookie;
    const task = this.serial(job.accountId, async () => {
      let completed = false;
      try {
        if (this.stopped) throw new CloudError("INTERRUPTED");
        const validation = await this.credentials.rotate(candidate.binding, candidate.credentialRef, secret!);
        secret = undefined;
        if (!validation?.capabilities || this.stopped) throw new CloudError("INTERRUPTED");
        await this.core.requestPrivate("cloud.account.writers-stopped", { accountId: job.accountId });
        const identityKey = validation.stableKey === null ? null : createHash("sha256").update(validation.stableKey).digest("hex");
        const result = await this.core.requestPrivate("cloud.authorization.finish", { jobId: job.id, failure: null, capabilities: validation.capabilities, identityKey, objectNamespace: validation.objectNamespace, rootLocator: validation.rootLocator });
        completed = result.state === "SUCCEEDED";
        if (!completed) throw new CloudError(result.failure?.code ?? "CONFLICT");
        if (previous) await this.vault.removeAccount(previous.credentialRef);
      } catch (error) {
        secret = undefined;
        // 提交响应丢失时先查询持久化结果，不能误删已经生效的新凭据。
        const result = await this.core.requestPrivate("cloud.authorization.finish", { jobId: job.id, failure: failure(error), capabilities: null, identityKey: null }).catch(() => null);
        completed = result?.state === "SUCCEEDED";
        if (completed && previous) await this.vault.removeAccount(previous.credentialRef);
        if (!completed) {
          if (result) {
            await this.credentials.disconnect(job.accountId, candidate.credentialRef).catch(() => {});
            const active = await this.core.requestPrivate("cloud.bootstrap", {}).catch(() => []);
            if (previous && active.some((entry) => entry.binding.generation === previous.binding.generation)) {
              try { await this.credentials.inject(previous.binding, previous.credentialRef); await this.core.requestPrivate("cloud.account.writers-stopped", { accountId: job.accountId }); await this.core.requestPrivate("cloud.account.restored", { accountId: previous.binding.accountId, generation: previous.binding.generation, failure: null }); }
              catch (reason) { await this.core.requestPrivate("cloud.account.restored", { accountId: previous.binding.accountId, generation: previous.binding.generation, failure: failure(reason) }).catch(() => {}); }
            }
          }
          // Core 不可用时保留密文，重启以数据库事实为准恢复；不自动重放授权。
        }
      } finally { secret = undefined; }
    });
    this.jobs.set(job.id, task);
    void task.finally(() => this.jobs.delete(job.id)).catch(() => {});
    return job;
  }
  restore(): Promise<void> {
    if (this.stopped) return Promise.reject(new CloudError("INTERRUPTED"));
    return this.restoring ??= this.restoreAll().finally(() => { this.restoring = undefined; });
  }
  private async restoreAll() {
    const active = await this.core.requestPrivate("cloud.bootstrap", {});
    for (const entry of active) await this.serial(entry.binding.accountId, async () => {
      if (this.stopped) return;
      let error: ReturnType<typeof cloudFailure> | null = null;
      try { await this.core.requestPrivate("cloud.account.suspending", { accountId: entry.binding.accountId }); await this.credentials.inject(entry.binding, entry.credentialRef); await this.core.requestPrivate("cloud.account.writers-stopped", { accountId: entry.binding.accountId }); }
      catch (reason) { error = failure(reason); }
      await this.core.requestPrivate("cloud.account.restored", { accountId: entry.binding.accountId, generation: entry.binding.generation, failure: error });
    });
  }
  async disconnect(accountId: string): Promise<void> {
    if (this.stopped) throw new CloudError("INTERRUPTED");
    await this.serial(accountId, async () => {
      await this.core.requestPrivate("cloud.account.suspending", { accountId });
      const references = await this.core.requestPrivate("cloud.account.credentials", { accountId });
      // 必须先回收宿主授权，再清除保险箱；业务记录和用户文件继续保留。
      if (references.length) await this.credentials.disconnect(accountId, references[0]!);
      await this.core.requestPrivate("cloud.account.writers-stopped", { accountId });
      for (const reference of references) await this.vault.removeAccount(reference);
      await this.core.requestPrivate("cloud.account.disconnected", { accountId });
    });
  }
  async waitIdle() { while (!this.stopped && (this.preparing || this.jobs.size || this.queues.size || this.restoring)) await new Promise((done) => setTimeout(done, 50)); }
  async stop() { this.stopped = true; await Promise.allSettled([...this.jobs.values(), ...this.queues.values()]); }
}
