import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { collect, options, selectTarget } from "./desktop-logs.mjs";
import { debugPort } from "./desktop-debug.mjs";

test("参数和目标选择拒绝歧义，启动与读取命令提供帮助和可执行错误", () => {
  assert.equal(debugPort(), 9222);
  for (const value of ["0", "65536", "1.5", "abc", ""]) assert.throws(() => debugPort(value));
  for (const args of [
    ["--duration", "0"],
    ["--duration", "NaN"],
    ["--list", "--target", "a"],
    ["--unexpected"],
  ]) {
    assert.throws(() => options(args));
  }
  const targets = [
    { id: "a", type: "page" },
    { id: "b", type: "webview" },
  ];
  assert.equal(selectTarget(targets).id, "a");
  assert.equal(selectTarget(targets, "b").id, "b");
  assert.throws(() => selectTarget([...targets, { id: "c", type: "page" }]), /--target/);
  assert.throws(() => selectTarget(targets, "不存在"), /--list/);
  for (const script of ["desktop-debug.mjs", "desktop-logs.mjs"]) {
    const result = spawnSync(
      process.execPath,
      ["--experimental-strip-types", `scripts/${script}`, "--help"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /用法/);
  }
  const result = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/desktop-logs.mjs", "--port", "65536"],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stderr.trim().split("\n")[0]).message, /端口/);
});

test("调试发现失败时返回启动修复动作", async () => {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  await assert.rejects(collect({ port, list: true }), /desktop:dev:debug/);
});

test("开发启动复用原命令，显式端口覆盖环境并清除 Electron Node 模式", async () => {
  const directory = await mkdtemp(join(tmpdir(), "marshal-cdp-launch-test-"));
  try {
    const npm = join(directory, "npm.cjs");
    await writeFile(
      npm,
      "console.log(JSON.stringify({args:process.argv.slice(2),port:process.env.REMOTE_DEBUGGING_PORT,nodeMode:process.env.ELECTRON_RUN_AS_NODE}));process.exit(Number(process.env.PROBE_EXIT ?? 0));",
    );
    const result = spawnSync(process.execPath, ["scripts/desktop-debug.mjs", "--port", "9333"], {
      env: {
        ...process.env,
        npm_execpath: npm,
        REMOTE_DEBUGGING_PORT: "9444",
        ELECTRON_RUN_AS_NODE: "1",
        PROBE_EXIT: "7",
      },
      encoding: "utf8",
    });
    assert.equal(result.status, 7, result.stderr);
    const probe = JSON.parse(result.stdout.trim().split("\n").at(-1));
    assert.deepEqual(probe, { args: ["run", "desktop:dev"], port: "9333" });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("拒绝远端 WebSocket，CDP 命令无响应时有界超时且不留下连接", { timeout: 10000 }, async () => {
  let remote = true;
  const sockets = new Set();
  const server = createServer((_request, response) => {
    const port = server.address().port;
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify([
        {
          id: "probe",
          type: "page",
          url: "https://example.test/path?token=秘密",
          webSocketDebuggerUrl: `ws://${remote ? "example.test" : "127.0.0.1"}:${port}/devtools/page/probe`,
        },
      ]),
    );
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (request, socket) => {
    const accept = createHash("sha1")
      .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    // 此替身故意不回复 CDP 命令，只完成关闭握手。
    socket.on("data", (bytes) => {
      if ((bytes[0] & 15) === 8) socket.end(Buffer.from([0x88, 0]));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = server.address().port;
    await assert.rejects(collect({ port }), /本机 WebSocket/);
    remote = false;
    await assert.rejects(
      collect({ port }, () => {}),
      /超时/,
    );
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
});

test(
  "隔离 Electron 读取历史、实时控制台、对象、异常、浏览器及访客日志并正确断开",
  { timeout: 30000 },
  async () => {
    const require = createRequire(import.meta.url);
    const directory = await mkdtemp(join(tmpdir(), "marshal-cdp-logs-test-"));
    const profile = join(directory, "profile");
    const main = join(directory, "main.cjs");
    const guest =
      "data:text/html;charset=utf-8," +
      encodeURIComponent(
        '<title>访客日志夹具</title><script>console.warn("访客日志", {count: 9})</script>',
      );
    const host =
      "data:text/html;charset=utf-8," +
      encodeURIComponent(`<title>主页面日志夹具</title><script>
    window.getterReads = 0;
    console.log("启动前日志", {count: 7, token: "对象令牌秘密", nested: {password: "嵌套密码秘密"}, get danger() { window.getterReads++; return "不应执行"; }});
  </script>`);
    await writeFile(
      main,
      `
    const {app, BrowserWindow} = require('electron');
    app.setPath('userData', ${JSON.stringify(profile)});
    app.whenReady().then(async () => {
      app.dock?.hide();
      global.win = new BrowserWindow({show: false, webPreferences: {sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: true}});
      await win.loadURL(${JSON.stringify(host)});
      process.send({event:'ready'});
    });
    process.on('message', async message => {
      if(message.action === 'emit') {
        await win.webContents.executeJavaScript('console.error("连接后日志 token=文本令牌秘密 https://example.test/path?token=地址秘密"); setTimeout(() => { throw new TypeError("异常原始秘密") }, 0); fetch("http://127.0.0.1:1/missing").catch(() => {});');
        process.send({event:'emitted'});
      }
      if(message.action === 'guest') {
        await win.webContents.executeJavaScript(${JSON.stringify(`(() => { const view=document.createElement('webview'); view.src=${JSON.stringify(guest)}; document.body.append(view); })()`)});
      }
      if(message.action === 'burst') {
        await win.webContents.executeJavaScript('console.log("x".repeat(300000)); console.info("超大消息后继续");');
      }
      if(message.action === 'getter') process.send({event:'getter', count: await win.webContents.executeJavaScript('window.getterReads')});
      if(message.action === 'close') win.destroy();
    });
  `,
    );
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(require("electron"), [main, "--remote-debugging-port=0"], {
      env,
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    const messages = [];
    child.on("message", (message) => messages.push(message));
    async function until(predicate, description) {
      for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        assert.equal(child.exitCode, null, stderr);
        await delay(50);
      }
      assert.fail(description);
    }
    const controller = new AbortController();
    let reading;
    try {
      await until(() => messages.some((message) => message.event === "ready"), "Electron 未就绪");
      const port = Number(
        (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0],
      );
      const records = [];
      await collect({ port, list: true }, (record) => records.push(record));
      assert.equal(records[0].targets.length, 1);
      assert.equal(records[0].targets[0].url, "[data:地址已省略]");
      const hostId = records[0].targets[0].id;
      reading = collect({ port }, (record) => records.push(record), controller.signal);
      await until(
        () =>
          records.some((record) => record.event === "console" && record.args[0] === "启动前日志"),
        "未收到历史日志",
      );
      const object = records.find((record) => record.event === "console").args[1];
      assert.equal(object.properties.count, 7);
      assert.equal(object.properties.token, "[已脱敏]");
      assert.equal(object.properties.danger, "[访问器未读取]");
      assert.equal(object.properties.nested.properties.password, "[已脱敏]");
      child.send({ action: "emit" });
      child.send({ action: "burst" });
      await until(
        () =>
          records.some((record) => record.event === "exception") &&
          records.some((record) => record.event === "browser") &&
          records.some((record) => record.args?.[0] === "超大消息后继续"),
        "实时、异常或浏览器日志缺失",
      );
      child.send({ action: "getter" });
      await until(() => messages.some((message) => message.event === "getter"), "未读取访问器计数");
      assert.equal(messages.find((message) => message.event === "getter").count, 0);
      controller.abort();
      await reading;
      reading = undefined;
      assert.equal(child.exitCode, null);
      assert.ok(records.at(-1).dropped > 0);
      assert.equal(records.at(-1).historyComplete, false);
      const output = JSON.stringify(records);
      for (const secret of [
        "对象令牌秘密",
        "嵌套密码秘密",
        "文本令牌秘密",
        "地址秘密",
        "异常原始秘密",
      ])
        assert.ok(!output.includes(secret), secret);
      assert.ok(
        records.some(
          (record) =>
            record.event === "exception" &&
            record.type === "TypeError" &&
            record.stackTrace.callFrames.length,
        ),
      );

      // 通过真实命令入口核对 JSONL、定时停止和 Ctrl+C，避免只验证内部函数。
      const cliArgs = [
        "--disable-warning=MODULE_TYPELESS_PACKAGE_JSON",
        "--disable-warning=ExperimentalWarning",
        "--experimental-strip-types",
        "scripts/desktop-logs.mjs",
        "--port",
        String(port),
        "--target",
        hostId,
      ];
      for (const interrupt of [false, true]) {
        const cli = spawn(
          process.execPath,
          [...cliArgs, ...(interrupt ? [] : ["--duration", "0.15"])],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        let output = "",
          errors = "";
        const exited = once(cli, "exit");
        cli.stdout.on("data", (chunk) => {
          output += chunk;
        });
        cli.stderr.on("data", (chunk) => {
          errors += chunk;
        });
        try {
          if (interrupt) {
            await until(() => output.includes('"event":"connected"'), "命令入口未连接");
            cli.kill("SIGINT");
          }
          const [code] = await exited;
          assert.equal(code, 0, errors);
          assert.equal(errors, "");
          const lines = output
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line));
          assert.equal(lines[0].event, "connected");
          assert.equal(lines.at(-1).event, "disconnected");
          assert.equal(child.exitCode, null);
        } finally {
          if (cli.exitCode === null && cli.signalCode === null) {
            cli.kill("SIGKILL");
            await exited;
          }
        }
      }

      child.send({ action: "guest" });
      let guestTarget;
      for (let i = 0; i < 100 && !guestTarget; i++) {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        guestTarget = targets.find(
          (target) => target.type === "webview" && target.title === "访客日志夹具",
        );
        if (!guestTarget) await delay(50);
      }
      assert.ok(guestTarget, "真正的 webview 独立目标未出现");
      const guestRecords = [];
      await collect({ port, target: guestTarget.id, duration: 0.3 }, (record) =>
        guestRecords.push(record),
      );
      assert.ok(
        guestRecords.some(
          (record) =>
            record.event === "console" &&
            record.args[0] === "访客日志" &&
            record.args[1].properties.count === 9,
        ),
      );
      assert.equal(child.exitCode, null);

      const closedRecords = [];
      const disconnected = collect({ port, target: hostId }, (record) =>
        closedRecords.push(record),
      );
      const rejected = assert.rejects(disconnected, /已关闭/);
      await until(
        () => closedRecords.some((record) => record.event === "connected"),
        "重新连接未成功",
      );
      // 等待 Runtime／Log 启用，确保本断言验证的是采集中目标关闭。
      await delay(100);
      child.send({ action: "close" });
      await rejected;
      assert.equal(closedRecords.at(-1).event, "disconnected");
    } finally {
      controller.abort();
      await reading?.catch(() => {});
      if (child.exitCode === null) {
        const exited = once(child, "exit");
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
        await exited;
        clearTimeout(timer);
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
