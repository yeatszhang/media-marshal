// M0 手动扫码验收工具：使用独立 Chrome 内存上下文，凭据只经管道传递。
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";

const proxyValue = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const proxy = proxyValue ? { server: new URL(proxyValue).origin } : undefined;
const browser = await chromium.launch({ channel: "chrome", headless: false, proxy });
const context = await browser.newContext({ acceptDownloads: false });
const page = await context.newPage();
await page.goto("https://pan.quark.cn/", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.bringToFront();
console.log("夸克扫码窗口已打开，使用独立会话；不会保存 Cookie 或读取现有浏览器会话。");
let authorized = false;
let worker;
const input = createInterface({ input: process.stdin });
const timer = setInterval(async () => {
  try {
    const cookies = await context.cookies("https://pan.quark.cn/");
    if (!authorized && ["__pus", "__puus"].every((name) => cookies.some((entry) => entry.name === name))) {
      authorized = true;
      console.log("已检测到登录会话，等待指定测试文件。");
    }
  } catch {}
}, 1500);
let closing;
const close = async () => {
  if (closing) return;
  closing = true;
  clearInterval(timer);
  worker?.kill();
  input.close();
  await browser.close().catch(() => {});
};
input.on("line", async (line) => {
  try {
    const command = JSON.parse(line);
    if (command.action === "close") return void close();
    if (command.action !== "probe" || worker || !authorized || typeof command.remotePath !== "string")
      return console.log("尚未登录、已有联调执行或测试参数无效。");
    const cookies = await context.cookies("https://pan.quark.cn/");
    worker = spawn("python3", [join(import.meta.dirname, "quark_probe.py")], { stdio: ["pipe", "pipe", "pipe"], shell: false });
    worker.stdin.end(JSON.stringify({ cookie: cookies.map((entry) => `${entry.name}=${entry.value}`).join("; "), remotePath: command.remotePath, membership: command.membership || "用户未说明" }));
    worker.stdout.on("data", (chunk) => process.stdout.write(chunk));
    worker.stderr.on("data", () => {});
    worker.once("error", () => { console.log("无法启动真实账号联调。"); worker = undefined; });
    worker.once("exit", (code) => { console.log(`真实联调结束，退出码 ${code}。`); worker = undefined; });
  } catch { console.log("联调请求未被接受。"); }
});
input.on("close", () => { void close(); });
browser.on("disconnected", () => { clearInterval(timer); worker?.kill(); input.close(); });
