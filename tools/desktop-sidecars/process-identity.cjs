// 只观察本测试已取得的进程 ID；创建时间与唯一配置路径共同防止 PID 复用误杀。
const { execFileSync } = require("node:child_process");

function identify(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("进程 ID 无效");
  try {
    if (process.platform === "win32") {
      const code = `$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($p){[pscustomobject]@{pid=$p.ProcessId;parent=$p.ParentProcessId;created=$p.CreationDate.ToUniversalTime().ToString('o');command=$p.CommandLine}|ConvertTo-Json -Compress}`;
      const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", code], { encoding: "utf8", windowsHide: true, timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      return text ? JSON.parse(text) : undefined;
    }
    const text = execFileSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "ppid=", "-o", "lstart=", "-o", "command="], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const match = text.match(/^(\d+)\s+(.{24})\s+(.+)$/);
    if (!match) throw new Error("无法解析进程身份");
    return { pid, parent: Number(match[1]), created: match[2], command: match[3] };
  } catch (error) {
    // 查询超时或工具失败不能算作进程已停止；只有 OS 明确报告不存在才接受。
    if (process.platform !== "win32" && error.status === 1) {
      try { process.kill(pid, 0); } catch (probe) { if (probe.code === "ESRCH") return undefined; }
    }
    throw new Error("无法核实自有进程是否停止", { cause: error });
  }
}

function matches(identity, marker) {
  const current = identify(identity.pid);
  return Boolean(current && current.created === identity.created && current.command === identity.command && current.command.includes(marker));
}

function stopVerified(identity, marker) {
  if (!identity.command.includes(marker)) throw new Error("进程缺少本次执行标识");
  if (matches(identity, marker)) process.kill(identity.pid, "SIGKILL");
}

function children(parentPid) {
  if (!Number.isSafeInteger(parentPid) || parentPid <= 0) throw new Error("父进程 ID 无效");
  if (process.platform === "win32") {
    const code = `$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${parentPid}' | ForEach-Object { $_.ProcessId }) | ConvertTo-Json -Compress`;
    const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", code], { encoding: "utf8", windowsHide: true, timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const value = text ? JSON.parse(text) : [];
    return (value == null ? [] : [].concat(value)).map(identify).filter(Boolean);
  }
  const text = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] });
  return text.trim().split("\n").map((line) => line.trim().split(/\s+/).map(Number)).filter(([, parent]) => parent === parentPid).map(([pid]) => identify(pid)).filter(Boolean);
}

module.exports = { identify, matches, stopVerified, children };
