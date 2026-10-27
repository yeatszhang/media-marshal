// 仅迁移本工具创建的临时验收账号：两个应用身份分别调用系统保护；明文仅短暂存在于私有测试内存。
// 不提供产品凭据读取接口，不接受真实用户资料目录，不输出 Cookie 或密文。
import { _electron } from "@playwright/test";
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep, resolve } from "node:path";
const directory = process.argv[2], executable = resolve("apps/desktop/release/mac-arm64/Media Marshal.app/Contents/MacOS/Media Marshal");
let bridge, application, scratch, cookie, fresh, step = "validate";
try {
  const data = await realpath(directory), temporary = await realpath(tmpdir()); if (!data.startsWith(temporary + sep + "marshal-quark-desktop-")) throw new Error();
  scratch = await mkdtemp(join(tmpdir(), "marshal-protection-test-")); const bootstrap = join(scratch, "bridge.cjs");
  await writeFile(bootstrap, "const {app,BrowserWindow}=require('electron'); app.setName('Media Marshal'); app.whenReady().then(()=>{const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}); window.loadURL('about:blank');});", { mode: 0o600 });
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  step = "source-protection"; bridge = await _electron.launch({ args: [bootstrap, `--user-data-dir=${join(scratch, "data")}`], env }); await bridge.firstWindow();
  cookie = await bridge.evaluate(async ({ safeStorage }, file) => {
    const fs = process.getBuiltinModule("fs"), info = fs.lstatSync(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024 || !await safeStorage.isAsyncEncryptionAvailable()) throw new Error();
    const entries = JSON.parse(fs.readFileSync(file, "utf8"));
    for (const [key, encrypted] of Object.entries(entries)) if (/^cloud:[a-f0-9-]{36}$/.test(key) && typeof encrypted === "string") {
      try { const value = await safeStorage.decryptStringAsync(Buffer.from(encrypted, "base64")); if (value.result.includes("__pus=") && value.result.includes("__puus=")) return value.result; } catch {}
    }
    return null;
  }, join(data, "credentials.json"));
  await bridge.close(); bridge = undefined; if (!cookie) throw new Error();
  const firstConfiguration = process.env.MARSHAL_FIRST_CONFIG === "1";
  if (firstConfiguration) fresh = await mkdtemp(join(tmpdir(), "marshal-quark-desktop-fresh-"));
  const targetDirectory = fresh ?? directory, startupBegin = Date.now();
  step = "packaged-authorization"; application = await _electron.launch({ executablePath: executable, args: [`--user-data-dir=${targetDirectory}`], env }); const page = await application.firstWindow(); await page.getByText("核心已连接", { exact: true }).waitFor();
  const authorizationBegin = Date.now(); const job = await page.evaluate((value) => window.desktopApi.authorizeCloudAccount({ name: "安装态夸克验收", cookie: value, requestKey: crypto.randomUUID() }), cookie); cookie = undefined;
  let result;
  for (let count = 0; count < 200; count++) { result = await page.evaluate((key) => window.desktopApi.getCloudAuthorization(key), job.requestKey); if (result?.state !== "RUNNING") break; await new Promise((done) => setTimeout(done, 250)); }
  if (result?.state !== "SUCCEEDED") { console.log(JSON.stringify({ state: result?.state, failure: result?.failure?.code })); throw new Error(); }
  const authorizationMs = Date.now() - authorizationBegin;
  let rootAuthorizationMs = null;
  if (firstConfiguration) {
    const fs = await import("node:fs/promises"), root = join(fresh, "首次 配置下载目录"); await fs.mkdir(root);
    await application.evaluate(({ dialog }, path) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] }); }, root);
    const begin = Date.now(), selected = await page.evaluate(() => window.desktopApi.chooseDownloadRoot()); rootAuthorizationMs = Date.now() - begin; if (selected?.state !== "AVAILABLE") throw new Error();
  }
  const firstConfigurationMs = firstConfiguration ? Date.now() - startupBegin : null;
  await writeFile("test-results/sidecars/quark-first-configuration.json", JSON.stringify({ target: `${process.platform}-${process.arch}`, packaged: true, freshProfile: firstConfiguration, firstConfigurationMs, rootAuthorizationMs, authorizationMs, scope: "使用已登录会话自动验证新账号与授权目录；总耗时含冷启动，不含人工扫码、凭据输入或目录选择的思考时间", plaintextPersistedOrPrinted: false }, null, 2) + "\n");
  console.log(JSON.stringify({ packagedAuthorizationSucceeded: true, authorizationMs, plaintextPersistedOrPrinted: false, source: "owned-temporary-validation-profile", sourceProtection: "development", targetProtection: "packaged" }));
} catch { console.log(JSON.stringify({ passed: false, step, detail: "未输出原始错误或凭据" })); process.exitCode = 1; }
finally { cookie = undefined; await bridge?.close().catch(() => {}); await application?.close().catch(() => {}); if (scratch) await rm(scratch, { recursive: true, force: true }); if (fresh) await rm(fresh, { recursive: true, force: true }); }
