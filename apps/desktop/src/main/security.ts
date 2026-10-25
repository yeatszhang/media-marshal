import { isAbsolute, relative, resolve, sep } from "node:path";
import { DesktopError, checkMessageSize } from "@media-marshal/contracts";

export const APP_ORIGIN = "marshal://app";
/** 外部打开仅接收 Core 核对后的条目页，不允许替换服务器、路由或附带凭据。 */
export function requireEmbyItemUrl(address: string, configuredAddress: string): URL {
  try {
    const base = new URL(configuredAddress), url = new URL(address);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error();
    base.pathname = base.pathname.replace(/\/$/, "") + "/";
    if (url.origin !== base.origin || url.username || url.password || url.search || url.pathname !== new URL("web/index.html", base).pathname || !/^#!\/item\?id=[a-zA-Z0-9-]{1,128}&serverId=[a-zA-Z0-9-]{1,128}$/.test(url.hash)) throw new Error();
    return url;
  } catch { throw new DesktopError("FORBIDDEN", "Emby 页面地址未通过核验"); }
}
export function trustedFrame(
  url: string,
  isMainFrame: boolean,
  developmentUrl?: string,
): boolean {
  if (!isMainFrame) return false;
  try {
    const value = new URL(url);
    if (
      value.protocol === "marshal:" &&
      value.hostname === "app" &&
      !value.port &&
      !value.username &&
      !value.password
    )
      return true;
    return Boolean(
      developmentUrl && value.origin === new URL(developmentUrl).origin,
    );
  } catch {
    return false;
  }
}
export function assetPath(root: string, url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== "marshal:" || parsed.host !== "app")
    throw new DesktopError("FORBIDDEN", "不可信的页面地址");
  const path = resolve(
    root,
    `.${decodeURIComponent(parsed.pathname === "/" ? "/index.html" : parsed.pathname)}`,
  );
  const rest = relative(root, path);
  if (rest === ".." || rest.startsWith(`..${sep}`) || isAbsolute(rest))
    throw new DesktopError("FORBIDDEN", "页面路径无效");
  return path;
}
export function requireTrustedRequest(
  value: unknown,
  url: string,
  isMainFrame: boolean,
  developmentUrl?: string,
): void {
  if (!trustedFrame(url, isMainFrame, developmentUrl))
    throw new DesktopError("FORBIDDEN", "不可信页面不能访问客户端能力");
  checkMessageSize(value);
}
