import { app } from "electron";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { CoreSupervisor } from "../../apps/desktop/src/main/core-supervisor";
import { SidecarSupervisor } from "../../apps/desktop/src/main/cloud/sidecar-supervisor";
import { SystemProcessInspector } from "../../apps/desktop/src/main/cloud/process-ownership";
import type { HostBinding } from "../../apps/desktop/src/sidecar-host/application";

// 独立验收入口，不进入桌面发行包，不增加生产 IPC 动作。
const directory = process.argv.find((value) => value.startsWith("--fixture-root="))?.slice("--fixture-root=".length);
if (!directory) throw new Error("缺少独立测试目录");
app.setPath("userData", join(directory, "electron"));
app.on("window-all-closed", () => {});
void app.whenReady().then(async () => {
  const root = resolve("apps/desktop"), target = `${process.platform}-${process.arch}`;
  const privateRoot = join(directory, "sidecars");
  const sidecars = new SidecarSupervisor({ workerPath: join(root, "out/main/sidecar-host.js"), appPath: root, resourceRoot: join(root, "resources/sidecars", target), privateRoot });
  const core = new CoreSupervisor(join(root, "out/main/worker.js"), join(directory, "core"), sidecars);
  const inspector = new SystemProcessInspector();
  await readFile(join(root, "resources/sidecars", target, "guardian.json"));
  await core.start();
  Object.assign(globalThis, { marshalSupervisorFixture: {
    start: (binding: HostBinding) => sidecars.start([binding]),
    async native() { return inspector.candidates(join(privateRoot, "sessions") + (process.platform === "win32" ? "\\" : "/")); },
    async kill(kind: string) {
      const pid = kind === "core" || kind === "host"
        ? app.getAppMetrics().find((metric) => metric.name === (kind === "core" ? "Media Marshal Core" : "Media Marshal Sidecar Host"))?.pid
        : (await this.native()).find((identity) => identity.executable.endsWith(kind + (process.platform === "win32" ? ".exe" : "")))?.pid;
      if (!pid) throw new Error("未找到本次受管进程");
      const identity = await inspector.identify(pid); if (!identity) throw new Error("进程已提前退出");
      await inspector.kill(identity);
    },
    status: () => ({ core: core.state, generation: sidecars.generation }),
    stop: () => sidecars.stop(),
    async close() { await core.stop(); await sidecars.stop(); },
  } });
});
