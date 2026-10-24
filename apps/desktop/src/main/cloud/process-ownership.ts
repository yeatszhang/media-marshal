import { execFile } from "node:child_process";
import { isAbsolute, join, normalize } from "node:path";
import { CloudError } from "@media-marshal/contracts";
import type { BinaryName } from "../../sidecar-host/binary-resolver";

export interface NativeIdentity { pid: number; parent: number; created: string; executable: string; command: string }
export interface ProcessInspector {
  identify(pid: number): Promise<NativeIdentity | undefined>;
  candidates(marker: string): Promise<readonly NativeIdentity[]>;
  kill(identity: NativeIdentity): Promise<void>;
}
const same = (left: NativeIdentity, right: NativeIdentity) => left.pid === right.pid && left.created === right.created && left.executable === right.executable && left.command === right.command;
function execute(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH"));
    execFile(file, args, { env, windowsHide: true, encoding: "utf8", timeout: 8000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new CloudError("COMPONENT_UNAVAILABLE")); else resolve(stdout);
    });
  });
}
async function windowsQuery(pid?: number, marker?: string): Promise<NativeIdentity[]> {
  const root = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!root || !isAbsolute(root)) throw new CloudError("COMPONENT_UNAVAILABLE");
  const query = pid === undefined ? "select ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine from Win32_Process" : `select ProcessId,ParentProcessId,CreationDate,ExecutablePath,CommandLine from Win32_Process where ProcessId=${pid}`;
  const script = `$ErrorActionPreference='Stop';$marker=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(marker ?? "").toString("base64")}'));$search=[Management.ManagementObjectSearcher]::new('${query}');$writer=[IO.StreamWriter]::new([Console]::OpenStandardOutput(),[Text.UTF8Encoding]::new($false));try {foreach($p in $search.Get()){if(!$p.CommandLine -or ($marker -and $p.CommandLine.IndexOf($marker,[StringComparison]::OrdinalIgnoreCase) -lt 0)){continue};if(!$p.ExecutablePath -or !$p.CreationDate){throw 'unavailable'};$exe=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$p.ExecutablePath));$cmd=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$p.CommandLine));$writer.WriteLine(([string]$p.ProcessId)+[char]9+([string]$p.ParentProcessId)+[char]9+([string]$p.CreationDate)+[char]9+$exe+[char]9+$cmd)};$writer.Flush()}finally{$search.Dispose();$writer.Dispose()}`;
  const output = await execute(join(root, "System32/WindowsPowerShell/v1.0/powershell.exe"), ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
  return output.trim().split(/\r?\n/).filter(Boolean).map((line) => {
    const parts = line.split("\t");
    if (parts.length !== 5 || !/^\d+$/.test(parts[0]!) || !/^\d+$/.test(parts[1]!) || !parts[2]) throw new CloudError("COMPONENT_UNAVAILABLE");
    return { pid: Number(parts[0]), parent: Number(parts[1]), created: parts[2]!, executable: Buffer.from(parts[3]!, "base64").toString("utf8"), command: Buffer.from(parts[4]!, "base64").toString("utf8") };
  });
}
export class SystemProcessInspector implements ProcessInspector {
  async identify(pid: number): Promise<NativeIdentity | undefined> {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new CloudError("INVALID_REQUEST");
    if (process.platform === "win32") return (await windowsQuery(pid))[0];
    const query = async () => {
      try { return (await execute("/bin/ps", ["-ww", "-p", String(pid), "-o", "ppid=", "-o", "lstart=", "-o", "command="])).trim(); }
      catch (error) {
        try { process.kill(pid, 0); } catch (probe) { if ((probe as NodeJS.ErrnoException).code === "ESRCH") return undefined; }
        throw error;
      }
    };
    const before = await query(); if (!before) return undefined;
    const match = before.match(/^(\d+)\s+(.{24})\s+(.+)$/);
    if (!match) throw new CloudError("COMPONENT_UNAVAILABLE");
    let executable: string;
    try { executable = (await execute("/bin/ps", ["-ww", "-p", String(pid), "-o", "comm="])).trim(); }
    catch (error) { if (!await query()) return undefined; throw error; }
    const after = await query(); if (!after) return undefined;
    if (before !== after || !isAbsolute(executable)) throw new CloudError("COMPONENT_UNAVAILABLE");
    return { pid, parent: Number(match[1]), created: match[2]!, command: match[3]!, executable };
  }
  async candidates(marker: string): Promise<readonly NativeIdentity[]> {
    if (process.platform === "win32") return windowsQuery(undefined, marker);
    const listing = await execute("/bin/ps", ["-Aww", "-o", "pid=", "-o", "command="]);
    const pids = listing.split("\n").filter((line) => line.includes(marker)).map((line) => Number(line.trim().match(/^\d+/)?.[0]));
    if (pids.length > 256) throw new CloudError("CONFLICT");
    const identities: NativeIdentity[] = [];
    for (const pid of pids) { const identity = await this.identify(pid); if (identity) identities.push(identity); }
    return identities;
  }
  async kill(identity: NativeIdentity): Promise<void> {
    const current = await this.identify(identity.pid);
    if (!current || !same(current, identity)) return;
    try { process.kill(identity.pid, "SIGKILL"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new CloudError("COMPONENT_UNAVAILABLE"); }
  }
}

// OS 快照是权威证据；持久化 PID 文件和对端的 exited 消息均不能证明进程已经停止。
export class NativeProcessOwnership {
  private readonly marker: string;
  private readonly binaries: Set<string>;
  private known = new Map<string, NativeIdentity>();
  constructor(privateRoot: string, binaries: Readonly<Record<BinaryName, string>>, private readonly inspector: ProcessInspector = new SystemProcessInspector()) {
    if (!isAbsolute(privateRoot)) throw new CloudError("INVALID_REQUEST");
    this.marker = join(privateRoot, "sessions") + (process.platform === "win32" ? "\\" : "/");
    this.binaries = new Set(Object.values(binaries).map((path) => this.canonical(path)));
  }
  private canonical(path: string) { const result = normalize(path); return process.platform === "win32" ? result.toLowerCase() : result; }
  private owns(identity: NativeIdentity) {
    const command = process.platform === "win32" ? identity.command.toLowerCase() : identity.command;
    const marker = process.platform === "win32" ? this.marker.toLowerCase() : this.marker;
    return command.includes(marker) && this.binaries.has(this.canonical(identity.executable));
  }
  async register(executionId: string, pid: number, parent: number, executable: string) {
    const identity = await this.inspector.identify(pid);
    if (!identity) return;
    if (!this.owns(identity) || identity.parent !== parent || this.canonical(identity.executable) !== this.canonical(executable)) throw new CloudError("CONFLICT");
    this.known.set(executionId, identity);
  }
  parent(executionId: string): number | undefined { return this.known.get(executionId)?.pid; }
  async stopped(executionId: string) {
    const identity = this.known.get(executionId);
    if (identity) {
      const current = await this.inspector.identify(identity.pid);
      if (current && same(current, identity)) throw new CloudError("CONFLICT");
      this.known.delete(executionId);
    }
  }
  async reap(): Promise<void> {
    // 先核验所有候选，再杀守护以阻止产生新孩子；每轮重新扫描，覆盖未送达 started 的启动空窗。
    for (let round = 0; round < 4; round++) {
      const candidates = [...await this.inspector.candidates(this.marker)];
      if (candidates.some((identity) => !this.owns(identity))) throw new CloudError("CONFLICT");
      if (!candidates.length) { this.known.clear(); return; }
      candidates.sort((a, b) => Number(!a.command.includes("--runtime-root=")) - Number(!b.command.includes("--runtime-root=")));
      for (const identity of candidates) await this.inspector.kill(identity);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new CloudError("CONFLICT");
  }
}
