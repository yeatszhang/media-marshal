import { describe, expect, it } from "vitest";
import fixtures from "./fixtures/templates.json";
import { renderTemplate, templatePath, type TemplateVariables } from "./template";
import { titleInitial } from "./title-initial";

describe("Java 模板行为迁移", () => {
  it.each(fixtures.cases)("保留 $id 的语义", ({ template, variables, expected }) => {
    expect(renderTemplate(template, variables as TemplateVariables)).toBe(expected);
  });
  it("连续数组与单值范围保持相同语义，非法集范围不产生文件名", () => {
    expect(renderTemplate("{episode:02d;prefix=E}", { episode: [16, 17] })).toBe("E16-E17");
    expect(renderTemplate("{episode:02d;prefix=E}", { episode: { start: 16, end: 16 } })).toBe("E16");
    for (const episode of [[16, 18], [16, 16], { start: 17, end: 16 }]) expect(() => renderTemplate("{episode}", { episode })).toThrow();
  });
  it("非法参数拒绝，未知数值格式按原规则回退且不能申请无限补零", () => {
    for (const parameter of ["prefix", "bad=x", "repeatPrefix=maybe"]) expect(() => renderTemplate(`{episode;${parameter}}`, { episode: 1 })).toThrow();
    expect(renderTemplate("{episode:not-a-format}", { episode: 1 })).toBe("1");
    expect(() => renderTemplate("{episode:9999d}", { episode: 1 })).toThrow();
    expect(renderTemplate("{title:02d}", { title: "Movie" })).toBe("Movie");
  });
  it("模板预览可保留缺值，但执行路径拒绝缺值、越界与原型字段", () => {
    for (const template of ["../{title}", "/{title}", "C:/{title}", "{title}//x", "{resolution}", "{title", "{constructor}", "a/./b", "a\\b"]) expect(() => templatePath(template, { title: "Movie" })).toThrow();
    expect(templatePath("{title} ({year})/{title}{ext}", { title: "../电影", year: 2026, ext: ".mkv" })).toEqual([".._电影 (2026)", ".._电影.mkv"]);
    expect(templatePath("CON.mkv", {}, "darwin")).toEqual(["CON.mkv"]);
    expect(() => templatePath("CON.mkv", {}, "win32")).toThrow();
    expect(() => templatePath("电影. ", {}, "win32")).toThrow();
  });
  it.each([["2001太空漫游", "#"], ["黑袍纠察队", "H"], ["巅峰猎杀", "D"], ["逍遥", "X"], ["breaking bad", "B"], ["·秘密", "#"], ["重生", "Z"], ["𠀀", "#"], ["", null], ["  ", null]])("固定字典首读音：%s", (title, expected) => {
    expect(titleInitial(title)).toBe(expected);
  });
});
