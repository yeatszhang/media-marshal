import { createHash, randomUUID } from "node:crypto";
import { CloudError, cloudAuthorizationSchema, cloudFailure, type CloudAuthorization } from "@media-marshal/contracts";
import { privateCoreActions, type PrivateCoreAction, type PrivateCoreInput, type PrivateCoreOutput } from "@media-marshal/contracts/internal/core";
import { remoteLocatorSchema } from "@media-marshal/contracts/internal";
import type { ValidatedBindingMapping } from "./bindings.js";
import type { CoreDatabase } from "../infrastructure/database.js";

interface JobRow { id: string; request_key: string; account_id: string; binding_id: string; previous_binding_id: string | null; credential_ref: string; state: CloudAuthorization["state"]; failure_json: string | null; updated_at: string; intent_json: string }
export class CloudAccounts {
  private ready = new Map<string, string>();
  constructor(private readonly database: CoreDatabase) {}
  isReady(binding: { accountId: string; generation: string }) { return this.ready.get(binding.accountId) === binding.generation; }
  invalidateRuntime() { this.ready.clear(); }
  recover() {
    this.ready.clear();
    const db = this.database.connection;
    db.transaction(() => {
      const failure = JSON.stringify(cloudFailure(new CloudError("INTERRUPTED")));
      db.prepare("UPDATE provider_binding SET state='RETIRED' WHERE id IN (SELECT binding_id FROM cloud_authorization WHERE state='RUNNING') AND state='CANDIDATE'").run();
      db.prepare("UPDATE cloud_authorization SET state='INTERRUPTED',failure_json=?,updated_at=? WHERE state='RUNNING'").run(failure, new Date().toISOString());
    })();
  }
  private job(row: JobRow): CloudAuthorization {
    return cloudAuthorizationSchema.parse({ id: row.id, requestKey: row.request_key, accountId: row.account_id, state: row.state, failure: row.failure_json ? JSON.parse(row.failure_json) : null, updatedAt: row.updated_at });
  }
  authorization(requestKey: string): CloudAuthorization | null {
    const row = this.database.connection.prepare("SELECT * FROM cloud_authorization WHERE request_key=?").get(requestKey) as JobRow | undefined;
    return row ? this.job(row) : null;
  }
  private configured(accountId: string) {
    return this.database.connection.prepare("SELECT b.id AS bindingId,b.account_id AS accountId,b.implementation_id AS implementationId,b.generation,a.credential_ref AS credentialRef FROM cloud_account a JOIN provider_binding b ON b.account_id=a.id AND b.state='ACTIVE' WHERE a.id=? AND a.status!='DISCONNECTED' AND a.credential_ref IS NOT NULL").get(accountId) as { bindingId: string; accountId: string; implementationId: string; generation: string; credentialRef: string } | undefined;
  }
  private configuredDto(value: NonNullable<ReturnType<CloudAccounts["configured"]>>) {
    const { credentialRef, ...binding } = value; return { binding, credentialRef };
  }
  private begin(input: PrivateCoreInput<"cloud.authorization.begin">): PrivateCoreOutput<"cloud.authorization.begin"> {
    const db = this.database.connection, intent = JSON.stringify({ accountId: input.accountId ?? null, name: input.name, implementationId: input.implementationId });
    return db.transaction(() => {
      let row = db.prepare("SELECT * FROM cloud_authorization WHERE request_key=?").get(input.requestKey) as JobRow | undefined;
      if (row && row.intent_json !== intent) throw new CloudError("CONFLICT");
      if (!row) {
        const accountId = input.accountId ?? randomUUID(), previous = this.configured(accountId), now = new Date().toISOString();
        if (input.accountId) {
          if (!db.prepare("SELECT id FROM cloud_account WHERE id=?").get(accountId)) throw new CloudError("REMOTE_NOT_FOUND");
          if (db.prepare("SELECT 1 FROM cloud_authorization WHERE account_id=? AND state='RUNNING'").get(accountId)) throw new CloudError("CONFLICT");
          if ((db.prepare("SELECT count(*) AS count FROM cloud_authorization WHERE account_id=?").get(accountId) as { count: number }).count >= 1000) throw new CloudError("CONFLICT");
          db.prepare("UPDATE cloud_account SET name=?,updated_at=? WHERE id=?").run(input.name, now, accountId);
        } else {
          if ((db.prepare("SELECT count(*) AS count FROM cloud_account").get() as { count: number }).count >= 100) throw new CloudError("CONFLICT");
          db.prepare("INSERT INTO cloud_account(id,name,provider_kind,status,created_at,updated_at) VALUES(?,?,'quark','UNCONFIGURED',?,?)").run(accountId, input.name, now, now);
        }
        const bindingId = randomUUID(), generation = randomUUID(), id = randomUUID(), credentialRef = randomUUID();
        db.prepare("INSERT INTO provider_binding(id,account_id,implementation_id,configuration_version,generation,state,created_at) VALUES(?,?,?,1,?,'CANDIDATE',?)").run(bindingId, accountId, input.implementationId, generation, now);
        db.prepare("INSERT INTO cloud_authorization(id,request_key,account_id,binding_id,previous_binding_id,credential_ref,intent_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,'RUNNING',?,?)").run(id, input.requestKey, accountId, bindingId, previous?.bindingId ?? null, credentialRef, intent, now, now);
        row = db.prepare("SELECT * FROM cloud_authorization WHERE id=?").get(id) as JobRow;
      }
      const binding = db.prepare("SELECT id AS bindingId,account_id AS accountId,implementation_id AS implementationId,generation FROM provider_binding WHERE id=?").get(row.binding_id) as { accountId: string; bindingId: string; implementationId: string; generation: string };
      const previous = this.configured(row.account_id);
      return { job: this.job(row), candidate: { binding, credentialRef: row.credential_ref }, previous: previous ? this.configuredDto(previous) : null };
    })();
  }
  finish(input: PrivateCoreInput<"cloud.authorization.finish">, mapping?: ValidatedBindingMapping): CloudAuthorization {
    const db = this.database.connection;
    return db.transaction(() => {
      const row = db.prepare("SELECT * FROM cloud_authorization WHERE id=?").get(input.jobId) as JobRow | undefined;
      if (!row) throw new CloudError("REMOTE_NOT_FOUND");
      if (row.state !== "RUNNING") return this.job(row);
      const active = db.prepare("SELECT id,identity_key FROM provider_binding WHERE account_id=? AND state='ACTIVE'").get(row.account_id) as { id: string; identity_key: string | null } | undefined;
      let failure = input.failure;
      if ((active?.id ?? null) !== row.previous_binding_id) failure = cloudFailure(new CloudError("CONFLICT"));
      if (!failure && (!input.capabilities || (input.capabilities.accountIdentity === "stable-id" && !input.identityKey))) throw new CloudError("INVALID_REQUEST");
      if (!failure && active?.identity_key && input.identityKey && active.identity_key !== input.identityKey) failure = cloudFailure(new CloudError("CONFLICT"));
      if (!failure && db.prepare("SELECT 1 FROM download_attempt WHERE account_id=? AND state IN ('CLAIMED','RUNNING','STOPPING','UNCERTAIN') LIMIT 1").get(row.account_id)) failure = cloudFailure(new CloudError("CONFLICT"));
      if (mapping && (mapping.previousBindingId !== active?.id || mapping.candidateBindingId !== row.binding_id || !input.objectNamespace)) throw new CloudError("CONFLICT");
      const rootLocator = remoteLocatorSchema.parse(input.rootLocator ?? { kind: "path", segments: [] });
      if (!failure && input.capabilities?.objectIdentity === "stable-id" && (rootLocator.kind !== "stable-id" || !input.objectNamespace)) throw new CloudError("INVALID_REQUEST");
      const now = new Date().toISOString();
      if (failure) {
        db.prepare("UPDATE provider_binding SET state='RETIRED' WHERE id=? AND state='CANDIDATE'").run(row.binding_id);
        if (!active) db.prepare("UPDATE cloud_account SET status=?,updated_at=? WHERE id=?").run(failure.code === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : "UNAVAILABLE", now, row.account_id);
      } else {
        db.prepare("UPDATE provider_binding SET state='RETIRED' WHERE account_id=? AND state='ACTIVE'").run(row.account_id);
        const changed = db.prepare("UPDATE provider_binding SET state='ACTIVE',identity_key=?,object_namespace=? WHERE id=? AND state='CANDIDATE'").run(input.identityKey, input.objectNamespace ?? null, row.binding_id);
        if (changed.changes !== 1) throw new CloudError("CONFLICT");
        // 无可信 UID 时不复用旧路径授权；旧订阅/历史保留，但须重新选择范围。
        const needsReselect = Boolean(active) && !mapping;
        db.prepare("UPDATE cloud_account SET credential_ref=?,capabilities_json=?,status=?,updated_at=? WHERE id=?").run(row.credential_ref, JSON.stringify(input.capabilities), needsReselect ? "RESELECT_REQUIRED" : "READY", now, row.account_id);
        if (needsReselect) {
          db.prepare("UPDATE cloud_subscription SET enabled=0,configuration_version=configuration_version+1,next_scan_at=NULL,updated_at=? WHERE account_id=?").run(now, row.account_id);
          db.prepare("UPDATE cloud_subscription_runtime SET state='RESELECT_REQUIRED',failure_json=NULL WHERE subscription_id IN (SELECT id FROM cloud_subscription WHERE account_id=?) AND state!='CANCELLED'").run(row.account_id);
        }
        if (mapping) {
          for (const reference of mapping.references) {
            const locator = JSON.stringify(remoteLocatorSchema.parse(reference.locator));
            db.prepare("INSERT INTO remote_binding(remote_ref,binding_id,account_id,locator_json,locator_key,updated_at) VALUES(?,?,?,?,?,?)").run(reference.remoteRef, row.binding_id, row.account_id, locator, createHash("sha256").update(locator).digest("hex"), now);
          }
          db.prepare("UPDATE cloud_subscription SET configuration_version=configuration_version+1,next_scan_at=?,updated_at=? WHERE account_id=? AND enabled=1").run(now, now, row.account_id);
          db.prepare("UPDATE cloud_subscription_runtime SET state='IDLE',failure_json=NULL WHERE subscription_id IN (SELECT id FROM cloud_subscription WHERE account_id=? AND enabled=1)").run(row.account_id);
        } else {
          const root = randomUUID(), locator = JSON.stringify(rootLocator);
          db.prepare("INSERT INTO remote_entry(id,account_id,parent_ref,name,type,size,observed_at) VALUES(?,?,NULL,'网盘根目录','directory',NULL,?)").run(root, row.account_id, now);
          db.prepare("INSERT INTO remote_binding(remote_ref,binding_id,account_id,locator_json,locator_key,updated_at) VALUES(?,?,?,?,?,?)").run(root, row.binding_id, row.account_id, locator, createHash("sha256").update(locator).digest("hex"), now);
        }
        db.prepare("UPDATE cloud_preview SET state='EXPIRED' WHERE account_id=? AND state IN ('BUILDING','READY')").run(row.account_id);
      }
      db.prepare("UPDATE cloud_authorization SET state=?,failure_json=?,updated_at=? WHERE id=?").run(failure ? "FAILED" : "SUCCEEDED", failure ? JSON.stringify(failure) : null, now, row.id);
      if (!failure) { const current = this.configured(row.account_id); if (current) this.ready.set(row.account_id, current.generation); }
      return this.job(db.prepare("SELECT * FROM cloud_authorization WHERE id=?").get(row.id) as JobRow);
    })();
  }
  dispatch<K extends PrivateCoreAction>(action: K, value: PrivateCoreInput<K>): PrivateCoreOutput<K> {
    const input = privateCoreActions[action].input.parse(value), db = this.database.connection;
    let result: unknown;
    if (action === "cloud.authorization.begin") {
      const prepared = this.begin(input as PrivateCoreInput<"cloud.authorization.begin">); result = prepared;
      if (prepared.job.state === "RUNNING") this.ready.delete(prepared.job.accountId);
    } else if (action === "cloud.authorization.finish") {
      const job = this.finish(input as PrivateCoreInput<"cloud.authorization.finish">); result = job;
      if (job.state === "SUCCEEDED") { const active = this.configured(job.accountId); if (active) this.ready.set(job.accountId, active.generation); }
    }
    else if (action === "cloud.bootstrap") {
      result = (db.prepare("SELECT id FROM cloud_account WHERE credential_ref IS NOT NULL AND status NOT IN ('AUTH_REQUIRED','DISCONNECTED') ORDER BY created_at LIMIT 100").all() as { id: string }[]).flatMap(({ id }) => { const value = this.configured(id); return value ? [this.configuredDto(value)] : []; });
    } else if (action === "cloud.account.suspending") {
      this.ready.delete((input as { accountId: string }).accountId); result = {};
    } else if (action === "cloud.account.writers-stopped") {
      result = {};
    } else if (action === "cloud.account.restored") {
      const parsed = input as PrivateCoreInput<"cloud.account.restored">;
      const active = this.configured(parsed.accountId);
      if (active?.generation === parsed.generation) {
        if (parsed.failure) this.ready.delete(parsed.accountId);
        else this.ready.set(parsed.accountId, parsed.generation);
      }
      if (parsed.failure) db.prepare("UPDATE cloud_account SET status=?,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM provider_binding WHERE account_id=? AND generation=? AND state='ACTIVE')").run(parsed.failure.code === "AUTH_REQUIRED" ? "AUTH_REQUIRED" : "UNAVAILABLE", new Date().toISOString(), parsed.accountId, parsed.accountId, parsed.generation);
      else db.prepare("UPDATE cloud_account SET status='READY',updated_at=? WHERE id=? AND status IN ('UNAVAILABLE','AUTH_REQUIRED') AND EXISTS(SELECT 1 FROM provider_binding WHERE account_id=? AND generation=? AND state='ACTIVE')").run(new Date().toISOString(), parsed.accountId, parsed.accountId, parsed.generation);
      result = {};
    } else if (action === "cloud.account.credentials") {
      const { accountId } = input as PrivateCoreInput<"cloud.account.credentials">;
      result = (db.prepare("SELECT credential_ref FROM cloud_account WHERE id=? AND credential_ref IS NOT NULL UNION SELECT credential_ref FROM cloud_authorization WHERE account_id=? LIMIT 1000").all(accountId, accountId) as { credential_ref: string }[]).map((row) => row.credential_ref);
    } else if (action === "cloud.account.disconnected") {
      const { accountId } = input as PrivateCoreInput<"cloud.account.disconnected">;
      this.ready.delete(accountId);
      db.transaction(() => {
        if (!db.prepare("SELECT id FROM cloud_account WHERE id=?").get(accountId)) throw new CloudError("REMOTE_NOT_FOUND");
        db.prepare("UPDATE provider_binding SET state='RETIRED' WHERE account_id=?").run(accountId);
        db.prepare("UPDATE cloud_subscription SET enabled=0 WHERE account_id=?").run(accountId);
        db.prepare("UPDATE cloud_account SET status='DISCONNECTED',credential_ref=NULL,capabilities_json=NULL,updated_at=? WHERE id=?").run(new Date().toISOString(), accountId);
      })(); result = {};
    }
    return privateCoreActions[action].output.parse(result) as PrivateCoreOutput<K>;
  }
}
