import { createServer } from "node:net";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createIdentifier } from "@yeatz/app-framework/ioc";
import { z } from "zod";
import { CloudError } from "@media-marshal/contracts";
import { ensurePrivateDirectory, ensurePrivateFile } from "../../main/cloud/private-files";
import { ManagedGuardian, type NativeObservation, type NativeExecution } from "../guardian";
import type { BinaryName } from "../binary-resolver";
import { OpenListClient } from "./client";

export const OpenListRuntimeToken = createIdentifier<OpenListRuntime>("sidecar.openlist");
const secret = () => randomBytes(36).toString("base64url");
export async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve())); return port;
}
export class OpenListRuntime {
  private guardian?: ManagedGuardian;
  private execution?: NativeExecution;
  private gateway?: OpenListClient;
  private readers = new Map<string, { username: string; password: string; mountPath: string }>();
  private pendingReaders = new Map<string, Promise<{ username: string; password: string; mountPath: string }>>();
  private stopping = false;
  private starting?: Promise<void>;
  readonly sessionRoot: string;
  constructor(private readonly options: { privateRoot: string; hostGeneration: string; binaries: Readonly<Record<BinaryName, string>>; observe?: (event: NativeObservation) => void; failed?: () => void; port?: () => Promise<number> }) {
    this.sessionRoot = join(options.privateRoot, "sessions", options.hostGeneration);
  }
  get client(): OpenListClient { if (!this.gateway || !this.execution?.running || this.stopping) throw new CloudError("COMPONENT_UNAVAILABLE"); return this.gateway; }
  start(): Promise<void> {
    if (this.stopping) return Promise.reject(new CloudError("COMPONENT_UNAVAILABLE"));
    if (this.starting) return this.starting;
    this.starting = this.initialize().catch(async (error: unknown) => { await this.stop(); throw error; });
    return this.starting;
  }
  private async initialize() {
    await ensurePrivateDirectory(this.options.privateRoot);
    await ensurePrivateDirectory(join(this.options.privateRoot, "sessions"));
    await ensurePrivateDirectory(this.sessionRoot);
    const data = join(this.sessionRoot, "openlist"); await ensurePrivateDirectory(data);
    const configPath = join(data, "config.json");
    const password = secret(), jwt = secret();
    const guardian = new ManagedGuardian(this.sessionRoot, this.options.binaries, (event) => {
      this.options.observe?.(event);
      if (!this.stopping && (event.type === "lost" || (event.type === "exited" && this.gateway && event.executionId === this.execution?.id))) {
        this.gateway = undefined; this.options.failed?.();
      }
    }); this.guardian = guardian;
    await guardian.launch();
    for (let attempt = 0; attempt < 3; attempt++) {
      const port = await (this.options.port ?? unusedPort)();
      await writeFile(configPath, JSON.stringify({ force: true, jwt_secret: jwt, token_expires_in: 12, scheme: { address: "127.0.0.1", http_port: port, https_port: -1 }, database: { type: "sqlite3", db_file: join(data, "data.db"), table_prefix: "x_" }, log: { enable: false }, s3: { enable: false }, ftp: { enable: false }, sftp: { enable: false }, mcp: { enable: false } }), { mode: 0o600 });
      await ensurePrivateFile(configPath);
      const execution = await guardian.start("openlist", randomUUID(), ["--data", data, "--config", configPath, "server"], { OPENLIST_ADMIN_PASSWORD: password });
      this.execution = execution;
      const client = new OpenListClient(port, jwt, password, () => execution.running && !this.stopping, 1000);
        const deadline = Date.now() + 3000;
      try {
        let authenticated = false;
        while (Date.now() < deadline) {
          if (!execution.running || this.stopping) throw new CloudError("COMPONENT_UNAVAILABLE");
          try { if (await client.ping()) { await client.authenticate(); authenticated = true; break; } } catch {}
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (!authenticated) throw new CloudError("TIMEOUT");
        const users = z.object({ content: z.array(z.object({ role: z.number(), disabled: z.boolean() })) }).parse(await client.api("GET", "/api/admin/user/list?page=1&per_page=100"));
        if (!users.content.some((user) => user.role === 1 && user.disabled)) throw new CloudError("COMPONENT_UNAVAILABLE");
        const anonymous = await client.raw("GET", "/dav/");
        if (anonymous.status !== 401) throw new CloudError("COMPONENT_UNAVAILABLE");
        this.gateway = client; return;
      } catch {
        await guardian.stop(execution.id);
        if (attempt === 2 || this.stopping) throw new CloudError("COMPONENT_UNAVAILABLE");
      }
    }
    throw new CloudError("COMPONENT_UNAVAILABLE");
  }
  async readOnlyAccess(accountId: string) {
    if (!z.uuid().safeParse(accountId).success) throw new CloudError("INVALID_REQUEST");
    const existing = this.readers.get(accountId); if (existing) return existing;
    const pending = this.pendingReaders.get(accountId); if (pending) return pending;
    const creating = this.createReader(accountId);
    this.pendingReaders.set(accountId, creating);
    try { return await creating; } finally { this.pendingReaders.delete(accountId); }
  }
  private async createReader(accountId: string) {
    const reader = { username: `r_${randomUUID().replaceAll("-", "")}`, password: secret(), mountPath: `/m_${accountId.replaceAll("-", "")}` };
    await this.client.api("POST", "/api/admin/user/create", { username: reader.username, password: reader.password, role: 0, base_path: reader.mountPath, permission: 256 });
    if (this.stopping) throw new CloudError("COMPONENT_UNAVAILABLE");
    this.readers.set(accountId, reader); return reader;
  }
  async stop() { this.stopping = true; this.gateway = undefined; this.readers.clear(); await this.guardian?.shutdown(); }
}
