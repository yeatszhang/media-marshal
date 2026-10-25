import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ParserProcess } from "./parser-process";

const parsers: ParserProcess[] = [], directories: string[] = [];
afterEach(async () => { await Promise.all(parsers.splice(0).map((parser) => parser.close())); await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function fixture(mode = "normal") {
  const directory = await mkdtemp(join(tmpdir(), "marshal-parser-pipe-")); directories.push(directory); const file = join(directory, "fixture.cjs"), marker = join(directory, "started");
  await writeFile(file, `
const readline = require('node:readline');
if(${JSON.stringify(mode)}==='hang') setInterval(()=>{},10000);
const input = readline.createInterface({input:process.stdin});
input.on('line', line => {
 const request=JSON.parse(line);
 if(request.action==='health') { process.stdout.write(JSON.stringify({protocolVersion:1,requestId:request.requestId,ok:true,result:{status:'ready',guessitVersion:'3.8.0'}})+'\\n'); return; }
 require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started');
 if(${JSON.stringify(mode)}==='hang') return;
 if(${JSON.stringify(mode)}==='oversized') {process.stdout.write('x'.repeat(1024*1024+2)); return;}
 if(${JSON.stringify(mode)}==='invalid') {process.stdout.write('not-json\\n'); return;}
 process.stdout.write(JSON.stringify({protocolVersion:1,requestId:${JSON.stringify(mode)}==='wrong-id'?'foreign':request.requestId,ok:true,result:{title:request.filename,type:'movie'}})+'\\n');
});
input.on('close',()=>{if(${JSON.stringify(mode)}!=='hang') process.exit(0)});
`);
  const parser = Object.assign(new ParserProcess(process.execPath, { args: [file], testNode: true, timeoutMs: 2000 }), { readStarted: () => existsSync(marker) }); parsers.push(parser); return parser;
}
describe("受管离线解析器管道", () => {
  it("串行关联请求，名称中的 shell 文本仅作为数据且环境不依赖 Python", async () => {
    const parser = await fixture(), name = "Movie.$(touch SHOULD_NOT_EXIST).mkv";
    const [first, second] = await Promise.all([parser.parse(name), parser.parse("中文电影.mkv")]);
    expect(parser.ready).toBe(true); expect(first.title).toBe(name); expect(second.title).toBe("中文电影.mkv"); expect(existsSync("SHOULD_NOT_EXIST")).toBe(false);
    await expect(parser.parse("/private/fixture.mkv")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await parser.close(); expect(parser.ready).toBe(false); await expect(parser.parse("Movie.mkv")).rejects.toMatchObject({ code: "COMPONENT_UNAVAILABLE" });
  });
  it.each(["wrong-id", "invalid", "oversized"])("拒绝 %s 输出并停止当前实例", async (mode) => {
    const parser = await fixture(mode); await expect(parser.parse("Movie.mkv")).rejects.toMatchObject({ code: "COMPONENT_UNAVAILABLE" }); expect(parser.ready).toBe(false);
  });
  it("超时强杀旧进程后才恢复，最多三次恢复且不无限重启", async () => {
    const parser = await fixture("hang");
    for (let count = 0; count < 4; count++) await expect(parser.parse("Movie.mkv")).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(parser.parse("Movie.mkv")).rejects.toMatchObject({ code: "COMPONENT_UNAVAILABLE" });
  });
  it("取消排队请求不取消其他名称，活动请求取消会停止旧解析器", async () => {
    const parser = await fixture(), controller = new AbortController(); controller.abort();
    await expect(parser.parse("取消.mkv", controller.signal)).rejects.toMatchObject({ code: "INTERRUPTED" }); expect((await parser.parse("保留.mkv")).title).toBe("保留.mkv");
    const hanging = await fixture("hang"), active = new AbortController(); await hanging.start(); const pending = expect(hanging.parse("Movie.mkv", active.signal)).rejects.toMatchObject({ code: "INTERRUPTED" }); await expect.poll(() => hanging.readStarted()).toBe(true); active.abort(); await pending;
  });
  it.skipIf(process.platform !== "darwin" || !existsSync(resolve("tools/desktop-parser/dist/media-marshal-parser/media-marshal-parser")))("冻结 guessit 无系统 Python 处理电影与连续集，EOF 后干净退出", async () => {
    const parser = new ParserProcess(resolve("tools/desktop-parser/dist/media-marshal-parser/media-marshal-parser")); parsers.push(parser);
    expect(await parser.parse("The.Dark.Knight.2008.1080p.BluRay.x264.mkv")).toMatchObject({ title: "The Dark Knight", year: 2008, type: "MOVIE" });
    expect(await parser.parse("Show.S01E02E03.mkv")).toMatchObject({ season: 1, episode: 2, episodeEnd: 3, episodes: [2, 3], type: "TV_SHOW" });
    await parser.close(); expect(parser.ready).toBe(false);
  });
});
