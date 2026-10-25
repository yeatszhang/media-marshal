import { readFile, writeFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { DesktopError, hostPreferencesDraftSchema, hostPreferencesSchema, type HostPreferencesDraft, type HostPreferences } from "@media-marshal/contracts";
import { z } from "zod";
interface LoginPort { supported: boolean; get(): { openAtLogin: boolean; status: Exclude<HostPreferences["loginStatus"], "unsupported"> }; set(enabled: boolean): void; trayAvailable(): boolean }
const storedSchema = z.strictObject({ version: z.literal(1), remindOnClose: z.boolean() });
/** 只管理宿主偏好；登录项以系统状态为准，读取和启动均不注册或删除登录项。 */
export class HostPreferencesController {
  private reminder = true; private stopped = false; private tail: Promise<unknown> = Promise.resolve();
  constructor(private readonly path: string, private readonly port: LoginPort) {}
  get remindOnClose() { return this.reminder; }
  private async stored() {
    try { const data = await readFile(this.path); if (data.length > 4096) throw new Error(); const value = storedSchema.parse(JSON.parse(data.toString())); this.reminder = value.remindOnClose; return value; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.reminder = true; return { version: 1 as const, remindOnClose: true }; } throw new DesktopError("STORAGE_ERROR", "本机运行偏好不可读取，请保留配置并检查应用数据目录后重试"); }
  }
  private system() {
    if (!this.port.supported) return { openAtLogin: false, status: "unsupported" as const };
    try { const value = this.port.get(); return { ...value, openAtLogin: value.openAtLogin || value.status === "requires-approval" }; } catch { throw new DesktopError("STORAGE_ERROR", "系统登录启动状态不可读取，请检查系统设置中的登录项后重试"); }
  }
  async get(): Promise<HostPreferences> { const stored = await this.stored(), system = this.system(); return hostPreferencesSchema.parse({ remindOnClose: stored.remindOnClose, openAtLogin: system.openAtLogin, loginStatus: system.status, loginSupported: this.port.supported, trayAvailable: this.port.trayAvailable() }); }
  save(input: HostPreferencesDraft): Promise<HostPreferences> {
    const pending = this.tail.then(() => { if (this.stopped) throw new DesktopError("INTERRUPTED", "客户端正在停止，运行设置未应用"); return this.apply(hostPreferencesDraftSchema.parse(input)); }); this.tail = pending.catch(() => {}); return pending;
  }
  async stop() { this.stopped = true; await this.tail; }
  private async apply(input: HostPreferencesDraft) {
    if (input.openAtLogin && !this.port.supported) throw new DesktopError("UNSUPPORTED_CAPABILITY", "当前构建不支持注册登录启动，请使用已安装的 macOS 客户端");
    const before = this.system(), changed = before.openAtLogin !== input.openAtLogin;
    if (changed) { try { this.port.set(input.openAtLogin); } catch { throw new DesktopError("STORAGE_ERROR", "登录启动未确认，请刷新并核对系统设置中的登录项；不会自动重试注册"); } }
    if (changed && this.system().openAtLogin !== input.openAtLogin) throw new DesktopError("CONFLICT", "系统未应用登录启动设置，请刷新并核对系统登录项；不会自动重试注册");
    const temporary = this.path + "." + randomUUID() + ".tmp";
    try {
      await writeFile(temporary, JSON.stringify({ version: 1, remindOnClose: input.remindOnClose }) + "\n", { mode: 0o600, flag: "wx" }); await rename(temporary, this.path); this.reminder = input.remindOnClose;
    } catch {
      let restored = !changed; if (changed) { try { this.port.set(before.openAtLogin); restored = this.system().openAtLogin === before.openAtLogin; } catch {} }
      throw new DesktopError("STORAGE_ERROR", restored ? "运行偏好未保存，原登录启动设置已保留；请检查应用数据目录后重试" : "运行偏好未保存，登录项恢复也未确认；请刷新并核对系统登录启动状态");
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
    return this.get();
  }
}
