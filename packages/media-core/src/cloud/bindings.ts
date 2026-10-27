import { createHash, randomUUID } from "node:crypto";
import { CloudError } from "@media-marshal/contracts";
import { bindingRefSchema, hostActions, remoteLocatorSchema, type RemoteLocator } from "@media-marshal/contracts/internal";
import type { PrivateCoreInput } from "@media-marshal/contracts/internal/core";
import type { CoreHostGateway } from "@media-marshal/contracts/internal/rpc";
import type { CoreDatabase } from "../infrastructure/database.js";

export interface ValidatedBindingMapping { previousBindingId: string; candidateBindingId: string; references: { remoteRef: string; locator: RemoteLocator }[] }
/** 原生 ID 命名空间由静态 Provider 声明；路径或跨命名空间不能据名字推断相同对象。 */
export class CloudBindingValidator {
  constructor(private readonly database: CoreDatabase, private readonly host: CoreHostGateway) {}
  async validate(input: PrivateCoreInput<"cloud.authorization.finish">): Promise<ValidatedBindingMapping | undefined> {
    if (input.failure || !input.objectNamespace || input.capabilities?.objectIdentity !== "stable-id" || !input.identityKey || input.rootLocator?.kind !== "stable-id") return;
    const db = this.database.connection, job = db.prepare("SELECT a.account_id,a.binding_id,a.previous_binding_id,b.generation,p.identity_key,p.object_namespace FROM cloud_authorization a JOIN provider_binding b ON b.id=a.binding_id LEFT JOIN provider_binding p ON p.id=a.previous_binding_id WHERE a.id=? AND a.state='RUNNING'").get(input.jobId) as { account_id: string; binding_id: string; previous_binding_id: string | null; generation: string; identity_key: string | null; object_namespace: string | null } | undefined;
    if (!job?.previous_binding_id || job.object_namespace !== input.objectNamespace || job.identity_key !== input.identityKey) return;
    const rows = db.prepare("SELECT m.remote_ref,m.locator_json,e.name,e.type,e.parent_ref FROM remote_binding m JOIN remote_entry e ON e.id=m.remote_ref WHERE m.binding_id=? ORDER BY e.parent_ref IS NOT NULL,e.id LIMIT 10001").all(job.previous_binding_id) as { remote_ref: string; locator_json: string; name: string; type: string; parent_ref: string | null }[];
    if (!rows.length || rows.length > 10000) return;
    const binding = bindingRefSchema.parse({ accountId: job.account_id, bindingId: job.binding_id, generation: job.generation }), references: ValidatedBindingMapping["references"] = [], seen = new Set<string>();
    for (const row of rows) {
      const locator = remoteLocatorSchema.parse(JSON.parse(row.locator_json)); if (locator.kind !== "stable-id") return;
      if (row.parent_ref === null && locator.objectKey !== input.rootLocator.objectKey) return;
      const key = createHash("sha256").update(JSON.stringify(locator)).digest("hex"); if (seen.has(key)) throw new CloudError("CONFLICT"); seen.add(key);
      try {
        const metadata = hostActions["provider.stat"].output.parse(await this.host.request("provider.stat", { binding, remoteRef: row.remote_ref, locator, expectedVersion: null }, this.host.context(binding.generation, randomUUID()), randomUUID()));
        if (metadata.accountId !== binding.accountId || metadata.type !== row.type || (row.parent_ref !== null && metadata.name !== row.name)) return;
      } catch (error) { if (error instanceof CloudError && ["REMOTE_NOT_FOUND", "REMOTE_CHANGED"].includes(error.code)) return; throw error; }
      references.push({ remoteRef: row.remote_ref, locator });
    }
    return { previousBindingId: job.previous_binding_id, candidateBindingId: job.binding_id, references };
  }
}
