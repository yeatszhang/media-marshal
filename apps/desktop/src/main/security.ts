import { isAbsolute, relative, resolve, sep } from "node:path";
import { DesktopError, checkMessageSize } from "@media-marshal/contracts";

export const APP_ORIGIN = "marshal://app";
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
