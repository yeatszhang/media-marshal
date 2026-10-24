import { z } from "zod";
import { CloudError } from "@media-marshal/contracts";
import { hostBindingSchema } from "../../sidecar-host/protocol";
import type { HostBinding } from "../../sidecar-host/application";
import type { Credentials } from "../credentials";

export interface AccountCredentialHost {
  quiesceAccount(accountId: string): Promise<void>;
  installCredential(binding: HostBinding, secret: string): Promise<void>;
  dropCredential(accountId: string): Promise<void>;
}
export class AccountCredentials {
  private queues = new Map<string, Promise<void>>();
  constructor(private readonly vault: Credentials, private readonly host: AccountCredentialHost) {}
  private serialized(accountId: string, work: () => Promise<void>): Promise<void> {
    const task = (this.queues.get(accountId) ?? Promise.resolve()).catch(() => {}).then(work);
    this.queues.set(accountId, task);
    void task.finally(() => { if (this.queues.get(accountId) === task) this.queues.delete(accountId); }).catch(() => {});
    return task;
  }
  rotate(binding: HostBinding, reference: string, secret: string): Promise<void> {
    const parsed = hostBindingSchema.safeParse(binding);
    if (!parsed.success || !z.uuid().safeParse(reference).success || !secret || secret.length > 32768) return Promise.reject(new CloudError("INVALID_REQUEST"));
    return this.serialized(binding.accountId, async () => {
      // 停止旧执行是覆盖保险箱与注入新代际的前置条件；失败时保留旧值。
      await this.host.quiesceAccount(binding.accountId);
      await this.vault.saveAccount(reference, secret);
      await this.host.installCredential(parsed.data, secret);
    });
  }
  inject(binding: HostBinding, reference: string): Promise<void> {
    const parsed = hostBindingSchema.safeParse(binding);
    if (!parsed.success || !z.uuid().safeParse(reference).success) return Promise.reject(new CloudError("INVALID_REQUEST"));
    return this.serialized(binding.accountId, async () => {
      const secret = await this.vault.readAccount(reference);
      if (!secret) throw new CloudError("AUTH_REQUIRED");
      await this.host.installCredential(parsed.data, secret);
    });
  }
  disconnect(accountId: string, reference: string): Promise<void> {
    if (!z.uuid().safeParse(accountId).success || !z.uuid().safeParse(reference).success) return Promise.reject(new CloudError("INVALID_REQUEST"));
    return this.serialized(accountId, async () => {
      await this.host.quiesceAccount(accountId);
      await this.host.dropCredential(accountId);
      await this.vault.removeAccount(reference);
    });
  }
}
