import { afterEach, expect, it } from "vitest";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexProcess } from "./codex-process.js";

const cleanup: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(timeout = 3000) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "marshal-codex-process-"))); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "fake-engine.mjs");
  await writeFile(script, `import readline from 'node:readline';
readline.createInterface({input:process.stdin}).on('line',line=>{
 const v=JSON.parse(line), reply=result=>process.stdout.write(JSON.stringify({protocolVersion:1,requestId:v.requestId,ok:true,result})+'\\n');
 if(v.action==='initialize'){reply({status:'ready'});return;}
 if(v.input.mode==='slow'){setTimeout(()=>reply({late:true}),30000);return;}
 if(v.input.mode==='malformed'){process.stdout.write('private-invalid-output\\n');return;}
 if(v.input.mode==='budget'){process.stdout.write(JSON.stringify({protocolVersion:1,requestId:v.requestId,ok:false,error:{code:'BUDGET_EXCEEDED',message:'private-untrusted'}})+'\\n');return;}
 reply({action:v.action,secret:process.env.OPENAI_API_KEY??null,model:v.input.model??null});
});`);
  const gateway = new CodexProcess(() => ({ executable: process.execPath, args: [script], runtimeDirectory: root, cliPath: "codex", model: "gpt-6-luna", dailyCalls: 10 }), timeout);
  cleanup.push(() => gateway.close()); return gateway;
}

it("独立请求复用配置且过滤凭据，不透传引擎错误正文", async () => {
  const gateway = await fixture(), key = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "private-key";
  try {
    expect(await gateway.request("usage", {})).toEqual({ action: "usage", secret: null, model: null });
    await expect(gateway.request("recognize", { mode: "budget" })).rejects.toMatchObject({ message: expect.stringContaining("今日调用预算") });
    expect(await gateway.request("usage", {})).toMatchObject({ action: "usage" });
  } finally { if (key === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = key; }
});

it("取消长调用后排空自有进程，后续请求仍可执行", async () => {
  const gateway = await fixture(), controller = new AbortController();
  const pending = gateway.request("recognize", { mode: "slow" }, controller.signal);
  const assertion = expect(pending).rejects.toMatchObject({ code: "INTERRUPTED" });
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(await gateway.request("usage", {})).toMatchObject({ action: "usage" });
  controller.abort(); await assertion;
  expect(await gateway.request("usage", {})).toMatchObject({ action: "usage" });
});

it("协议损坏与超时均可控失败，不保存原始输出；关闭后拒绝新请求", async () => {
  const gateway = await fixture(300);
  await expect(gateway.request("recognize", { mode: "malformed" })).rejects.toMatchObject({ message: "Codex 识别协议响应无效，请重启核心后重试" });
  await expect(gateway.request("recognize", { mode: "slow" })).rejects.toMatchObject({ code: "TIMEOUT" });
  await gateway.close(); await expect(gateway.request("usage", {})).rejects.toMatchObject({ code: "COMPONENT_UNAVAILABLE" });
});
