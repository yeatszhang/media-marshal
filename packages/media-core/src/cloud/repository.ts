import { CloudError, cloudAccountSchema, cloudDiagnosticCountsSchema, type CloudAccount } from "@media-marshal/contracts";
import { cloudAccountWriteSchema } from "@media-marshal/contracts/internal";
import type { CoreDatabase } from "../infrastructure/database.js";

export class CloudRepository {
  constructor(readonly database: CoreDatabase) {}
  diagnosticCounts() {
    const db = this.database.connection;
    const result = db.prepare("SELECT count(*) FILTER (WHERE state='PAUSED') AS pausedItems, count(*) FILTER (WHERE state='AUTH_REQUIRED') AS authenticationRequiredItems, count(*) FILTER (WHERE failure_code='COMPONENT_UNAVAILABLE') AS componentFailedItems FROM download_item").get() as Record<string, number>;
    const accounts = db.prepare("SELECT count(*) AS count FROM cloud_account WHERE status='AUTH_REQUIRED'").get() as { count: number };
    return cloudDiagnosticCountsSchema.parse({ ...result, authenticationRequiredAccounts: accounts.count });
  }
  createAccount(value: unknown): CloudAccount {
    const parsed = cloudAccountWriteSchema.safeParse(value);
    if (!parsed.success) throw new CloudError("INVALID_REQUEST");
    const input = parsed.data;
    const db = this.database.connection;
    db.transaction(() => {
      if ((db.prepare("SELECT count(*) AS count FROM cloud_account").get() as { count: number }).count >= 100) throw new CloudError("CONFLICT");
      const now = new Date().toISOString();
      db.prepare("INSERT INTO cloud_account(id,name,provider_kind,status,credential_ref,created_at,updated_at) VALUES(?,?,'quark','UNCONFIGURED',?,?,?)")
        .run(input.id, input.name, input.credentialRef, now, now);
      db.prepare("INSERT INTO provider_binding(id,account_id,implementation_id,configuration_version,generation,state,created_at) VALUES(?,?,?,1,?,'CANDIDATE',?)")
        .run(input.bindingId, input.id, input.implementationId, input.generation, now);
    })();
    return cloudAccountSchema.parse({ id: input.id, name: input.name, providerKind: "quark", status: "UNCONFIGURED", capabilities: null });
  }
}
