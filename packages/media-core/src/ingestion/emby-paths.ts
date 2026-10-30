import { posix, win32, relative, sep, isAbsolute } from "node:path";
import { DesktopError } from "@media-marshal/contracts";
import { acceptsMediaType, type EmbyLibrary } from "../infrastructure/emby.js";

export interface EmbyPathConversion { localRoot: string; serverRoot: string; serverPathStyle: "posix" | "win32" }
export interface EmbyPathMatch { libraryId: string; libraryPath: string; serverPath: string }
export interface EmbyPathDiscovery { state: "MATCHED" | "UNMATCHED" | "AMBIGUOUS" | "TYPE_CONFLICT"; matches: EmbyPathMatch[]; incompatible: EmbyPathMatch[] }
const unsafe = () => new DesktopError("UNSAFE_PATH", "路径转换无效：请使用绝对根目录、完整路径段且不要包含 . 或 ..，并核对两侧目标");

export function serverStyle(path: string): "posix" | "win32" { return /^[a-z]:[\\/]|^\\\\/i.test(path) ? "win32" : "posix"; }
function checked(path: string, style: "posix" | "win32") {
  const api = style === "win32" ? win32 : posix;
  if (!path || /[\0\r\n]/.test(path) || !api.isAbsolute(path) || path.split(style === "win32" ? /[\\/]/ : /\//).some((part) => part === "." || part === "..")) throw unsafe();
  if (style === "win32" && (!/^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/i.test(path) || /^[\\/][^\\/]/.test(path))) throw unsafe();
  return api.normalize(path);
}
export function serverContains(root: string, path: string, style: "posix" | "win32") {
  const api = style === "win32" ? win32 : posix, parent = checked(root, style), child = checked(path, style);
  const part = api.relative(parent, child);
  return !part || part !== ".." && !part.startsWith(".." + api.sep) && !api.isAbsolute(part);
}
export function sameServerPath(a: string, b: string, style: "posix" | "win32") {
  const first = checked(a, style), second = checked(b, style);
  return style === "win32" ? first.toLowerCase() === second.toLowerCase() : first === second;
}
export function embyServerPath(localPath: string, conversion: EmbyPathConversion | null) {
  if (!conversion) { checked(localPath, serverStyle(localPath)); return localPath; }
  const { localRoot, serverRoot, serverPathStyle: style } = conversion;
  if (!isAbsolute(localRoot) || !isAbsolute(localPath) || [localRoot, localPath].some((path) => path.split(sep).some((part) => part === "." || part === ".."))) throw unsafe();
  const part = relative(localRoot, localPath);
  if (part === ".." || part.startsWith(".." + sep) || isAbsolute(part)) throw unsafe();
  const segments = part ? part.split(sep) : [];
  if (style === "win32" && segments.some((segment) => /[\\:<>"|?*\x00-\x1f]/.test(segment) || /[. ]$/.test(segment) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(segment))) throw unsafe();
  const api = style === "win32" ? win32 : posix, result = api.join(checked(serverRoot, style), ...segments);
  if (!serverContains(serverRoot, result, style)) throw unsafe();
  return result;
}
/** 不按列表顺序选择；保留每一个具体库根及类型冲突供用户核对。 */
export function discoverEmbyTarget(target: { path: string; mediaType: "AUTO" | "MOVIE" | "TV_SHOW" }, libraries: readonly EmbyLibrary[], conversion: EmbyPathConversion | null = null): EmbyPathDiscovery {
  const path = embyServerPath(target.path, conversion), style = conversion?.serverPathStyle ?? serverStyle(path);
  const matches: EmbyPathMatch[] = [], incompatible: EmbyPathMatch[] = [], seen = new Set<string>();
  for (const library of libraries) for (const root of library.paths) {
    if (serverStyle(root) !== style) continue;
    if (!serverContains(root, path, style)) continue;
    const key = JSON.stringify([library.id, style === "win32" ? win32.normalize(root).toLowerCase() : posix.normalize(root)]);
    if (seen.has(key)) continue; seen.add(key);
    (acceptsMediaType(library.type, target.mediaType) ? matches : incompatible).push({ libraryId: library.id, libraryPath: root, serverPath: path });
  }
  return { state: matches.length > 1 ? "AMBIGUOUS" : matches.length === 1 ? "MATCHED" : incompatible.length ? "TYPE_CONFLICT" : "UNMATCHED", matches, incompatible };
}
