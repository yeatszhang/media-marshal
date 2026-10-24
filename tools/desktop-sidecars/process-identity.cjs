// 只观察本测试已取得的进程 ID；创建时间与唯一配置路径共同防止 PID 复用误杀。
const { execFileSync } = require("node:child_process");

function identify(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("进程 ID 无效");
  try {
    if (process.platform === "win32") {
      const code = `$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}'; if($p){[pscustomobject]@{pid=$p.ProcessId;parent=$p.ParentProcessId;created=$p.CreationDate.ToUniversalTime().ToString('o');command=$p.CommandLine}|ConvertTo-Json -Compress}`;
      const text = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", code], { encoding: "utf8", windowsHide: true, timeout: 10000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      return text ? JSON.parse(text) : undefined;
    }
    const text = execFileSync("/bin/ps", ["-ww", "-p", String(pid), "-o", "ppid=", "-o", "lstart=", "-o", "command="], { encoding: "utf8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }).trim();
    const match = text.match(/^(\d+)\s+(.{24})\s+(.+)$/);
    return match ? { pid, parent: Number(match[1]), created: match[2], command: match[3] } : undefined;
  } catch { return undefined; }
}

function matches(identity, marker) {
  const current = identify(identity.pid);
  return Boolean(current && current.created === identity.created && current.command === identity.command && current.command.includes(marker));
}

function stopVerified(identity, marker) {
  if (!identity.command.includes(marker)) throw new Error("进程缺少本次执行标识");
  if (matches(identity, marker)) process.kill(identity.pid, "SIGKILL");
}

module.exports = { identify, matches, stopVerified };
