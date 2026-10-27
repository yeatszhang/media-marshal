import { cloudFiltersSchema, syncFilterSchema, type SyncFilter } from "@media-marshal/contracts";

/** 旧扩展名忽略大小写、精确文件名区分大小写，两者取交集；不能统一加 ignore-case。 */
export function legacySyncFilters(value: unknown): SyncFilter[] | null {
  const filters = cloudFiltersSchema.parse(value);
  const selectedNames = filters.names.filter((name) => !filters.extensions.length || filters.extensions.includes(name.split(".").at(-1)!.toLowerCase()));
  const patterns = filters.names.length
    ? selectedNames.map((name) => ({ action: "include", pattern: name.replace(/[\\*?\[\]{}]/g, "\\$&"), caseSensitive: true }))
    : filters.extensions.map((extension) => ({ action: "include", pattern: `*.${extension}`, caseSensitive: false }));
  if (!filters.names.length && !filters.extensions.length) return [];
  const parsed = patterns.map((pattern) => syncFilterSchema.safeParse(pattern));
  // 旧精确名称可能含换行，不静默扩大为通配符；保留原配置供显式修复。
  if (parsed.some((result) => !result.success)) return null;
  return [...parsed.map((result) => result.data!), syncFilterSchema.parse({ action: "exclude", pattern: "**" })];
}
