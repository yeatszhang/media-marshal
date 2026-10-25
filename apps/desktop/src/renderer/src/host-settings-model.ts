import { inject, injectable, StatefulService } from "@yeatz/app-framework/ioc";
import type { DesktopApi, DesktopAbout, HostPreferences, HostPreferencesDraft, LicenseId, LicenseText } from "@media-marshal/contracts";
import { DesktopClient } from "./desktop-client";
@injectable()
export class HostSettingsViewModel extends StatefulService<{ preferences: HostPreferences | null; about: DesktopAbout | null; loading: boolean; busy: boolean; error: string | null; licenseId: LicenseId | null; license: LicenseText | null; licenseError: string | null }> {
  protected initState = { preferences: null, about: null, loading: false, busy: false, error: null, licenseId: null, license: null, licenseError: null };
  private stopped = false; private request = 0; private licenseRequest = 0;
  constructor(@inject(DesktopClient) private readonly client: DesktopApi) { super(); }
  async refresh() {
    if (this.stopped || this.state.busy) return; const request = ++this.request; this.setState({ loading: true, error: null });
    try { const [preferences, about] = await Promise.allSettled([this.client.getHostPreferences(), this.client.getDesktopAbout()]); if (this.stopped || request !== this.request) return;
      this.setState({ ...(preferences.status === "fulfilled" ? { preferences: preferences.value } : {}), ...(about.status === "fulfilled" ? { about: about.value } : {}), error: [preferences, about].filter((value) => value.status === "rejected").map((value) => value.status === "rejected" && value.reason instanceof Error ? value.reason.message : "本机运行信息不可读取，请刷新重试").join("；") || null });
    } catch (error) { if (!this.stopped && request === this.request) this.setState({ error: error instanceof Error ? error.message : "运行设置不可读取，请刷新重试" }); }
    finally { if (!this.stopped && request === this.request) this.setState({ loading: false }); }
  }
  async save(input: HostPreferencesDraft) {
    if (this.stopped || this.state.busy) return false; ++this.request; this.setState({ busy: true, error: null });
    try { const preferences = await this.client.saveHostPreferences(input); if (!this.stopped) this.setState({ preferences }); return true; }
    catch (error) { if (!this.stopped) this.setState({ error: error instanceof Error ? error.message : "运行设置未确认，请刷新系统状态后重试" }); return false; }
    finally { if (!this.stopped) this.setState({ busy: false, loading: false }); }
  }
  async readLicense(id: LicenseId) { if (this.stopped) return; const request = ++this.licenseRequest; this.setState({ licenseId: id, license: null, licenseError: null }); try { const license = await this.client.getLicenseText(id); if (!this.stopped && request === this.licenseRequest) this.setState({ license }); } catch (error) { if (!this.stopped && request === this.licenseRequest) this.setState({ licenseError: error instanceof Error ? error.message : "许可材料不可读取，请重试" }); } }
  closeLicense() { ++this.licenseRequest; this.setState({ licenseId: null, license: null, licenseError: null }); }
  release() { ++this.request; this.closeLicense(); this.setState({ loading: false }); }
  protected dispose() { this.stopped = true; ++this.request; ++this.licenseRequest; }
}
