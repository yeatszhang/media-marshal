import { randomUUID } from "node:crypto";
import { createIdentifier } from "@yeatz/app-framework/ioc";
import { z } from "zod";
import { CloudError } from "@media-marshal/contracts";
import { bindingRefSchema, type BindingRef } from "@media-marshal/contracts/internal";

export const SourceCredentialBrokerToken = createIdentifier<SourceCredentialBroker>("sidecar.source-credentials");

// Engine 通过不透明句柄取得传输授权，不理解 Provider 的凭据或对象定位形式。
export class SourceCredentialBroker {
  private values = new Map<string, { binding: BindingRef; username: string; password: string }>();
  issue(binding: BindingRef, secret: { username: string; password: string }): string {
    if (this.values.size >= 4096) throw new CloudError("CONFLICT");
    const ref = bindingRefSchema.parse(binding);
    const value = z.object({ username: z.string().min(1).max(256), password: z.string().min(1).max(4096) }).parse({ username: secret.username, password: secret.password });
    const id = randomUUID(); this.values.set(id, { binding: ref, ...value }); return id;
  }
  read(handle: string, generation: string): { username: string; password: string } {
    const value = this.values.get(handle);
    if (!value || value.binding.generation !== generation) throw new CloudError("INTERRUPTED");
    return { username: value.username, password: value.password };
  }
  release(handle: string) { this.values.delete(handle); }
  revoke(binding: BindingRef) { for (const [id, value] of this.values) if (value.binding.accountId === binding.accountId && value.binding.bindingId === binding.bindingId && value.binding.generation === binding.generation) this.values.delete(id); }
  clear() { this.values.clear(); }
}
