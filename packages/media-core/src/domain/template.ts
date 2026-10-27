import { RecognitionError } from "./media.js";

export type TemplateValue = string | number | readonly number[] | { start: number; end: number | null } | null;
export type TemplateVariables = Partial<Record<"title" | "original_title" | "year" | "tmdb_id" | "media_type" | "season" | "episode" | "episode_title" | "title_initial" | "genre_1" | "genre_2" | "genre_3" | "genre_4" | "country" | "resolution" | "codec" | "release_group" | "ext", TemplateValue>>;
const placeholder = /\{([a-z_][a-z0-9_]*)(?::([^;}]+))?(?:;([^}]+))?\}/g;
const unsafe = /[\\/:*?"<>|\p{Cc}]/gu;
const fail = (): never => { throw new RecognitionError("TEMPLATE_INVALID", "模板参数或目标路径无效，请重新预览"); };
const sanitize = (value: string) => { const cleaned = value.replace(unsafe, "_").trim(); return cleaned === "." || cleaned === ".." ? "_" : cleaned; };
interface Options { prefix: string; suffix: string; separator: string; repeatPrefix: boolean; repeatSuffix: boolean }
function options(raw?: string): Options {
  const values: Options = { prefix: "", suffix: "", separator: "-", repeatPrefix: true, repeatSuffix: true };
  if (raw) for (const token of raw.split(";")) {
    const equals = token.indexOf("="); if (equals <= 0) fail(); const key = token.slice(0, equals).trim(), value = sanitize(token.slice(equals + 1));
    if (key === "prefix" || key === "suffix" || key === "separator") values[key] = value;
    else if (key === "repeatPrefix" || key === "repeatSuffix") { if (value && !/^(true|false)$/i.test(value)) fail(); values[key] = value ? value.toLowerCase() === "true" : true; }
    else fail();
  }
  return values;
}
function format(value: string | number, spec?: string): string {
  if (typeof value !== "number" || !spec) return String(value);
  if (!Number.isSafeInteger(value)) fail();
  const matched = /^(0)?(\d{1,4})?([doxX])$/.exec(spec); if (!matched) return String(value);
  const width = Number(matched[2] ?? 0); if (width > 1024) fail();
  const base = matched[3] === "d" ? 10 : matched[3] === "o" ? 8 : 16;
  let rendered = Math.abs(value).toString(base); if (matched[3] === "X") rendered = rendered.toUpperCase();
  const signed = value < 0 ? "-" : "", pad = matched[1] ? "0" : " ";
  return pad === "0" ? signed + rendered.padStart(Math.max(0, width - signed.length), pad) : (signed + rendered).padStart(width, pad);
}
function renderValue(value: Exclude<TemplateValue, null>, spec: string | undefined, affixes: Options): string {
  let start: number | undefined, end: number | null = null;
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    if (value.length > 1000 || value.some((item, index) => !Number.isSafeInteger(item) || (index > 0 && item !== value[index - 1]! + 1))) fail();
    start = value[0]; end = value.length > 1 ? value.at(-1)! : null;
  } else if (typeof value === "object") {
    const range = value as { start: number; end: number | null }; start = range.start; end = range.end;
    if (!Number.isSafeInteger(start) || (end !== null && (!Number.isSafeInteger(end) || end < start))) fail();
    if (end === start) end = null;
  }
  if (start === undefined) return affixes.prefix + format(value as string | number, spec) + affixes.suffix;
  const first = format(start, spec); if (end === null) return affixes.prefix + first + affixes.suffix;
  return affixes.prefix + first + (affixes.repeatSuffix ? affixes.suffix : "") + affixes.separator + (affixes.repeatPrefix ? affixes.prefix : "") + format(end, spec) + affixes.suffix;
}
/** 保留原有可选片段、空值、范围和前后缀语义；目标安全校验由调用方另外执行。 */
export function renderTemplate(template: string, input: TemplateVariables): string {
  if (template.length > 16384) fail();
  const variables = Object.fromEntries(Object.entries(input).map(([key, value]) => [key, typeof value === "string" ? key === "ext" ? sanitize(value) : sanitize(value) || null : value]));
  const lookup = (key: string): TemplateValue | undefined => Object.hasOwn(variables, key) ? variables[key] : undefined;
  const render = (text: string) => text.replace(placeholder, (whole, key: string, spec?: string, raw?: string) => {
    const affixes = options(raw), value = lookup(key); return value === null || value === undefined ? whole : renderValue(value, spec, affixes);
  });
  const output = render(template.replace(/\[\[(.*?)\]\]/g, (_whole, segment: string) => [...segment.matchAll(placeholder)].every((match) => lookup(match[1]!) != null) ? render(segment) : ""));
  if (output.length > 32768) fail(); return output;
}
export function templatePath(template: string, input: TemplateVariables, platform: "darwin" | "win32" = "darwin"): string[] {
  const result = renderTemplate(template, input);
  if (/[{}]|\[\[|\]\]|^[/\\]|^[a-z]:|\\|\p{Cc}/iu.test(result)) fail();
  const parts = result.split("/");
  if (parts.length > 64 || parts.some((part) => !part || part === "." || part === ".." || (platform === "win32" && (/[<>:"|?*]|[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))))) fail();
  return parts;
}
