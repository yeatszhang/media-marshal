import { z } from "zod";
import { CloudError } from "@media-marshal/contracts";
import { hostBindingSchema, type CredentialValidation } from "../../sidecar-host/protocol";
import type { HostBinding } from "../../sidecar-host/application";
import type { Credentials } from "../credentials";
import type { BindingRef } from "@media-marshal/contracts/internal";

export interface AccountCredentialHost {
  quiesceAccount(accountId: string): Promise<void>;
  installCredential(binding: HostBinding, secret: string): Promise<CredentialValidation | void>;
  dropCredential(accountId: string): Promise<void>;
  onCredentialRefresh?(handler: (binding: BindingRef, secret: string) => Promise<void>): void;
}
interface CredentialReference { reference: string; binding: BindingRef; updates: Promise<void> }
export class AccountCredentials {
  private queues = new Map<string, Promise<void>>();
  private references = new Map<string, CredentialReference>();
  constructor(private readonly vault: Credentials, private readonly host: AccountCredentialHost) {
    host.onCredentialRefresh?.((binding, secret) => this.refresh(binding, secret));
  }
  private refresh(binding: BindingRef, secret: string): Promise<void> {
    const current = this.references.get(binding.accountId);
    if (!current || current.binding.bindingId !== binding.bindingId || current.binding.generation !== binding.generation) return Promise.reject(new CloudError("INTERRUPTED"));
    const task = current.updates.catch(() => {}).then(async () => {
      if (this.references.get(binding.accountId) !== current) throw new CloudError("INTERRUPTED");
      await this.vault.saveAccount(current.reference, secret);
    });
    current.updates = task; return task;
  }
  private async drain(reference?: CredentialReference) {
    if (!reference) return;
    for (;;) { const updates = reference.updates; await updates; if (updates === reference.updates) return; }
  }
  private async install(binding: HostBinding, reference: string, secret: string) {
    const previous = this.references.get(binding.accountId);
    await this.drain(previous);
    const current = { binding: { ...binding }, reference, updates: Promise.resolve() };
    this.references.set(binding.accountId, current);
    try { const validation = await this.host.installCredential(binding, secret); await this.drain(current); return validation; }
    catch (error) { if (previous) this.references.set(binding.accountId, previous); else this.references.delete(binding.accountId); throw error; }
  }
  private serialized<T>(accountId: string, work: () => Promise<T>): Promise<T> {
    const task = (this.queues.get(accountId) ?? Promise.resolve()).catch(() => {}).then(work);
    const tail = task.then(() => {}, () => {});
    this.queues.set(accountId, tail);
    void tail.finally(() => { if (this.queues.get(accountId) === tail) this.queues.delete(accountId); });
    return task;
  }
  rotate(binding: HostBinding, reference: string, secret: string): Promise<CredentialValidation | void> {
    const parsed = hostBindingSchema.safeParse(binding);
    if (!parsed.success || !z.uuid().safeParse(reference).success || !secret || secret.length > 32768) return Promise.reject(new CloudError("INVALID_REQUEST"));
    return this.serialized(binding.accountId, async () => {
      // 停止旧执行是覆盖保险箱与注入新代际的前置条件；失败时保留旧值。
      await this.host.quiesceAccount(binding.accountId);
      const previous = this.references.get(binding.accountId);
      if (previous && previous.reference === reference) throw new CloudError("CONFLICT");
      await this.drain(previous);
      await this.vault.saveAccount(reference, secret);
      return this.install(parsed.data, reference, secret);
    });
  }
  inject(binding: HostBinding, reference: string): Promise<void> {
    const parsed = hostBindingSchema.safeParse(binding);
    if (!parsed.success || !z.uuid().safeParse(reference).success) return Promise.reject(new CloudError("INVALID_REQUEST"));
    return this.serialized(binding.accountId, async () => {
      const secret = await this.vault.readAccount(reference);
      if (!secret) throw new CloudError("AUTH_REQUIRED");
      await this.install(parsed.data, reference, secret);
    });
  }
  disconnect(accountId: string, reference: string): Promise<void> {
    if (!z.uuid().safeParse(accountId).success || !z.uuid().safeParse(reference).success) return Promise.reject(new CloudError("INVALID_REQUEST"));
    return this.serialized(accountId, async () => {
      await this.host.quiesceAccount(accountId);
      await this.host.dropCredential(accountId);
      await this.drain(this.references.get(accountId)); this.references.delete(accountId);
      await this.vault.removeAccount(reference);
    });
  }
}
