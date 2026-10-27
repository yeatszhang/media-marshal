import { beforeAll, afterEach, afterAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { constants, type BigIntStats } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, lstat, open, rm, symlink, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const run = promisify(execFile), cleanup: (() => unknown | Promise<unknown>)[] = [];
interface RenameResult { state: "RENAMED" | "NOT_RENAMED" | "UNCERTAIN"; code: string; moved: boolean; osError: number }
interface Native { linkBeneath(fromFd: number, fromParts: string[], toFd: number, toParts: string[], expected: ReturnType<typeof identity>): Promise<{ state: string; code: string; published: boolean; osError: number }>; renameBeneath(fromFd: number, fromParts: string[], toFd: number, toParts: string[], expected: ReturnType<typeof identity>): Promise<RenameResult>; renameExclusive(fromFd: number, fromName: string, toFd: number, toName: string, expected: ReturnType<typeof identity>): Promise<RenameResult> }
const identity = (info: BigIntStats) => ({ dev: info.dev, ino: info.ino, size: info.size, birthtimeNs: info.birthtimeNs, mtimeNs: info.mtimeNs, ctimeNs: info.ctimeNs });
let work: string, binary: string, native: Native;
describe.skipIf(process.platform !== "darwin")("macOS 独占改名原语（隔离真实文件）", () => {
  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), "marshal-exclusive-"));
    await run(process.execPath, [resolve("tools/desktop-files/build.mjs"), "--out", join(work, "native")], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30000 });
    binary = join(work, "native/rename-exclusive.node"); native = createRequire(import.meta.url)(binary) as Native;
  }, 40000);
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
  afterAll(async () => { if (work) await rm(work, { recursive: true, force: true }); });
  async function fixture() {
    const root = await mkdtemp(join(work, "case-")), source = join(root, "原目标 中文"), target = join(root, "新目标 中文"); await mkdir(source); await mkdir(target); await writeFile(join(source, "原视频.mkv"), "保留完整媒体内容");
    const from = await open(source, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW), to = await open(target, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); cleanup.push(() => from.close(), () => to.close());
    const snapshot = identity(await lstat(join(source, "原视频.mkv"), { bigint: true })), rename = (name = "新视频.mkv") => native.renameExclusive(from.fd, "原视频.mkv", to.fd, name, snapshot);
    return { root, source, target, from, to, snapshot, rename };
  }
  it("实际改名保留 inode 和内容；目标已存在时无覆盖，失败不虚报已执行", async () => {
    const f = await fixture(); await writeFile(join(f.target, "已占用.mkv"), "第三方文件"); expect(await f.rename("已占用.mkv")).toMatchObject({ state: "NOT_RENAMED", code: "TARGET_EXISTS", moved: false }); expect(await readFile(join(f.target, "已占用.mkv"), "utf8")).toBe("第三方文件");
    expect(await f.rename()).toEqual({ state: "RENAMED", code: "OK", moved: true, osError: 0 }); expect((await lstat(join(f.target, "新视频.mkv"), { bigint: true })).ino).toBe(f.snapshot.ino); expect(await readFile(join(f.target, "新视频.mkv"), "utf8")).toBe("保留完整媒体内容"); await expect(lstat(join(f.source, "原视频.mkv"))).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("另一个进程在预检后抢建目标，原视频与第三方文件均保留", async () => {
    const f = await fixture(); await expect(lstat(join(f.target, "抢占.mkv"))).rejects.toMatchObject({ code: "ENOENT" });
    await run(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1],'外部抢占',{flag:'wx'})", join(f.target, "抢占.mkv")], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
    const result = await f.rename("抢占.mkv"); expect(result).toMatchObject({ state: "NOT_RENAMED", code: "TARGET_EXISTS" }); expect(JSON.stringify(result)).not.toContain(f.root); expect(await readFile(join(f.source, "原视频.mkv"), "utf8")).toBe("保留完整媒体内容"); expect(await readFile(join(f.target, "抢占.mkv"), "utf8")).toBe("外部抢占");
  });
  it("两个并发改名只能领取一个同名目标，另一个来源保留", async () => {
    const f = await fixture(); await writeFile(join(f.source, "另一视频.mkv"), "另一文件"); const other = identity(await lstat(join(f.source, "另一视频.mkv"), { bigint: true }));
    const result = await Promise.all([f.rename(), native.renameExclusive(f.from.fd, "另一视频.mkv", f.to.fd, "新视频.mkv", other)]); expect(result.filter((row) => row.state === "RENAMED")).toHaveLength(1); expect(result.filter((row) => row.code === "TARGET_EXISTS")).toHaveLength(1);
    const content = await readFile(join(f.target, "新视频.mkv"), "utf8"); expect(["保留完整媒体内容", "另一文件"]).toContain(content); const remaining = content === "另一文件" ? "原视频.mkv" : "另一视频.mkv"; expect(await readFile(join(f.source, remaining), "utf8")).toBe(content === "另一文件" ? "保留完整媒体内容" : "另一文件");
  });
  it("来源身份、大小或时间变化时不改名，符号链接和目录不被当普通视频", async () => {
    const f = await fixture(); await writeFile(join(f.source, "原视频.mkv"), "来源已变化"); expect(await f.rename()).toMatchObject({ state: "NOT_RENAMED", code: "SOURCE_CHANGED" });
    await symlink(join(f.source, "原视频.mkv"), join(f.source, "链接.mkv")); expect(await native.renameExclusive(f.from.fd, "链接.mkv", f.to.fd, "链接.mkv", f.snapshot)).toMatchObject({ state: "NOT_RENAMED", code: "INVALID_SOURCE" });
    await mkdir(join(f.source, "目录.mkv")); expect(await native.renameExclusive(f.from.fd, "目录.mkv", f.to.fd, "目录.mkv", f.snapshot)).toMatchObject({ state: "NOT_RENAMED", code: "INVALID_SOURCE" }); expect(await readFile(join(f.source, "原视频.mkv"), "utf8")).toBe("来源已变化");
  });
  it("目标符号链接和目录同样保持占用，拒绝穿越名称、小数 FD 和伪造快照", async () => {
    const f = await fixture(); await symlink(join(f.source, "原视频.mkv"), join(f.target, "链接.mkv")); await mkdir(join(f.target, "目录.mkv"));
    for (const target of ["链接.mkv", "目录.mkv"]) expect(await f.rename(target)).toMatchObject({ state: "NOT_RENAMED", code: "TARGET_EXISTS" });
    for (const name of ["", ".", "..", "../escape", "/tmp/escape", "x\0y", "x\ud800", "长".repeat(86)]) expect(() => native.renameExclusive(f.from.fd, name, f.to.fd, "新视频.mkv", f.snapshot)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    expect(() => native.renameExclusive(f.from.fd + 0.5, "原视频.mkv", f.to.fd, "新视频.mkv", f.snapshot)).toThrow(); expect(() => native.renameExclusive(f.from.fd, "原视频.mkv", f.to.fd, "新视频.mkv", { ...f.snapshot, size: -1n })).toThrow();
    expect(() => (native.renameExclusive as Function)(f.from.fd, "原视频.mkv", f.to.fd, "新视频.mkv", { ...f.snapshot, path: "任意路径" })).toThrow();
  });
  it.skipIf(process.getuid?.() === 0)("目录权限撤销返回未改名，不把失败解释为可删除原目标", async () => {
    const f = await fixture(); await chmod(f.target, 0o500); cleanup.push(() => chmod(f.target, 0o700)); expect(await f.rename()).toMatchObject({ state: "NOT_RENAMED", code: "UNAVAILABLE", moved: false }); expect(await readFile(join(f.source, "原视频.mkv"), "utf8")).toBe("保留完整媒体内容");
  });
  it("异步等待期间复制并持有原目录 FD，关闭或复用调用者 FD 不会改名其他目录", async () => {
    const f = await fixture(), script = join(f.root, "fd-lifetime.cjs");
    await writeFile(script, `const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path'),native=require(process.argv[2]),root=process.argv[3];
const source=path.join(root,'原目标 中文'),target=path.join(root,'新目标 中文'),foreign=path.join(root,'外部目录');fs.mkdirSync(foreign);fs.writeFileSync(path.join(foreign,'原视频.mkv'),'外部文件保留');
const a=fs.openSync(source,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY),b=fs.openSync(target,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY),s=fs.statSync(path.join(source,'原视频.mkv'),{bigint:true}),expected=Object.fromEntries(['dev','ino','size','birthtimeNs','mtimeNs','ctimeNs'].map(k=>[k,s[k]]));
crypto.pbkdf2('fixture','fixture',1000000,32,'sha256',()=>{});const result=native.renameExclusive(a,'原视频.mkv',b,'改名成功.mkv',expected);fs.closeSync(a);fs.closeSync(b);const c=fs.openSync(foreign,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY),d=fs.openSync(foreign,fs.constants.O_RDONLY|fs.constants.O_DIRECTORY);
result.then(row=>{fs.closeSync(c);fs.closeSync(d);process.stdout.write(JSON.stringify(row));});`);
    const result = await run(process.execPath, [script, binary, f.root], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", UV_THREADPOOL_SIZE: "1" }, timeout: 10000 }); expect(JSON.parse(result.stdout)).toMatchObject({ state: "RENAMED" }); expect(await readFile(join(f.target, "改名成功.mkv"), "utf8")).toBe("保留完整媒体内容"); expect(await readFile(join(f.root, "外部目录/原视频.mkv"), "utf8")).toBe("外部文件保留");
  });
  it("最多保留 64 个等待，完成后释放名额；无法撤销的调用等待其确定结果", async () => {
    const f = await fixture(), script = join(f.root, "capacity.cjs");
    await writeFile(script, `const fs=require('node:fs'),crypto=require('node:crypto'),path=require('node:path'),native=require(process.argv[2]),root=process.argv[3];
const a=fs.openSync(path.join(root,'原目标 中文'),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY),b=fs.openSync(path.join(root,'新目标 中文'),fs.constants.O_RDONLY|fs.constants.O_DIRECTORY),s=fs.statSync(path.join(root,'原目标 中文/原视频.mkv'),{bigint:true}),keys=['dev','ino','size','birthtimeNs','mtimeNs','ctimeNs'],expected=Object.fromEntries(keys.map(k=>[k,s[k]]));
crypto.pbkdf2('fixture','fixture',1000000,32,'sha256',()=>{});let busy=0;const pending=[];for(let n=0;n<65;n++){try{pending.push(native.renameExclusive(a,'原视频.mkv',b,'target-'+n+'.mkv',expected));}catch(error){if(error.code!=='BUSY')throw error;busy++;}}
Promise.all(pending).then(async rows=>{const index=rows.findIndex(row=>row.moved),name='target-'+index+'.mkv',info=fs.statSync(path.join(root,'新目标 中文',name),{bigint:true}),fresh=Object.fromEntries(keys.map(k=>[k,info[k]]));const restored=await native.renameExclusive(b,name,a,'原视频.mkv',fresh);fs.closeSync(a);fs.closeSync(b);process.stdout.write(JSON.stringify({busy,count:rows.length,moved:rows.filter(row=>row.moved).length,restored}));});`);
    const result = await run(process.execPath, [script, binary, f.root], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", UV_THREADPOOL_SIZE: "1" }, timeout: 10000 }); expect(JSON.parse(result.stdout)).toMatchObject({ busy: 1, count: 64, moved: 1, restored: { state: "RENAMED" } }); expect(await readFile(join(f.source, "原视频.mkv"), "utf8")).toBe("保留完整媒体内容");
  });

  it("从根 FD 逐层进入嵌套目录并创建新目标父目录，不跟随源或目标父级符号链接", async () => {
    const f = await fixture(); await mkdir(join(f.source, "已整理子目录")); await writeFile(join(f.source, "已整理子目录/剧集.mkv"), "嵌套媒体"); const snapshot = identity(await lstat(join(f.source, "已整理子目录/剧集.mkv"), { bigint: true }));
    expect(await native.renameBeneath(f.from.fd, ["已整理子目录", "剧集.mkv"], f.to.fd, ["修正作品", "Season 01", "剧集.mkv"], snapshot)).toMatchObject({ state: "RENAMED" }); expect(await readFile(join(f.target, "修正作品/Season 01/剧集.mkv"), "utf8")).toBe("嵌套媒体");
    const foreign = join(f.root, "未授权外部"); await mkdir(foreign); await symlink(foreign, join(f.target, "跳转")); expect(await native.renameBeneath(f.from.fd, ["原视频.mkv"], f.to.fd, ["跳转", "不得创建", "视频.mkv"], f.snapshot)).toMatchObject({ state: "NOT_RENAMED", code: "UNSAFE_PATH" }); await expect(lstat(join(foreign, "不得创建"))).rejects.toMatchObject({ code: "ENOENT" });
    await symlink(f.source, join(f.source, "源跳转")); expect(await native.renameBeneath(f.from.fd, ["源跳转", "原视频.mkv"], f.to.fd, ["不得创建.mkv"], f.snapshot)).toMatchObject({ state: "NOT_RENAMED", code: "UNSAFE_PATH" });
  });
  it("根内改名同样拒绝穿越与无界层级，来源失效不创建目标目录", async () => {
    const f = await fixture(); for (const parts of [[], ["..", "视频.mkv"], ["/tmp", "视频.mkv"], Array.from({ length: 257 }, () => "层级")]) expect(() => native.renameBeneath(f.from.fd, parts, f.to.fd, ["合法.mkv"], f.snapshot)).toThrow(expect.objectContaining({ code: "INVALID_INPUT" }));
    await writeFile(join(f.source, "原视频.mkv"), "改变原文件"); expect(await native.renameBeneath(f.from.fd, ["原视频.mkv"], f.to.fd, ["不应创建", "新视频.mkv"], f.snapshot)).toMatchObject({ state: "NOT_RENAMED", code: "SOURCE_CHANGED" }); await expect(lstat(join(f.target, "不应创建"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("根内发布保留暂存锚点，同名占用或父级符号链接不覆盖且不越界", async () => {
    const f = await fixture(), publish = (parts: string[], snapshot = f.snapshot) => native.linkBeneath(f.from.fd, ["原视频.mkv"], f.to.fd, parts, snapshot);
    expect(await publish(["新目录", "发布.mkv"])).toEqual({ state: "PUBLISHED", code: "OK", published: true, osError: 0 });
    const original = await lstat(join(f.source, "原视频.mkv"), { bigint: true }), published = await lstat(join(f.target, "新目录/发布.mkv"), { bigint: true }); expect(published.ino).toBe(original.ino); expect(original.nlink).toBe(2n);
    const current = identity(original); await writeFile(join(f.target, "占用.mkv"), "第三方保留"); expect(await publish(["占用.mkv"], current)).toMatchObject({ state: "NOT_PUBLISHED", code: "TARGET_EXISTS", published: false }); expect(await readFile(join(f.target, "占用.mkv"), "utf8")).toBe("第三方保留");
    const foreign = join(f.root, "外部发布目录"); await mkdir(foreign); await symlink(foreign, join(f.target, "跳转")); expect(await publish(["跳转", "不得创建", "发布.mkv"], current)).toMatchObject({ state: "NOT_PUBLISHED", code: "UNSAFE_PATH", published: false }); await expect(lstat(join(foreign, "不得创建"))).rejects.toMatchObject({ code: "ENOENT" }); expect(await readFile(join(f.source, "原视频.mkv"), "utf8")).toBe("保留完整媒体内容");
    // link 更新 ctime；复用发布前快照不能领取另一个位置。
    expect(await publish(["过期快照.mkv"])).toMatchObject({ state: "NOT_PUBLISHED", code: "SOURCE_CHANGED" });
  });

});
