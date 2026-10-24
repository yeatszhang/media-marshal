import { spawn } from "node:child_process";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DesktopError } from "@media-marshal/contracts";

// 路径通过 stdin 当数据传入，不拼进 PowerShell 源码或 argv。
const windowsAclScript = `
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)
$request=[Console]::In.ReadToEnd() | ConvertFrom-Json
$path=[IO.Path]::GetFullPath([string]$request.path)
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
if($request.directory){$security=[Security.AccessControl.DirectorySecurity]::new();$inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}
else{$security=[Security.AccessControl.FileSecurity]::new();$inherit=[Security.AccessControl.InheritanceFlags]::None}
$security.SetOwner($sid)
$security.SetAccessRuleProtection($true,$false)
foreach($identity in @($sid,$system)){
  $rule=[Security.AccessControl.FileSystemAccessRule]::new($identity,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
  $security.AddAccessRule($rule)
}
Set-Acl -LiteralPath $path -AclObject $security
$actual=Get-Acl -LiteralPath $path
if(!$actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'private-acl-check'}
$rules=@($actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
if($rules.Count -ne 2){throw 'private-acl-count'}
foreach($rule in $rules){
  if($rule.IdentityReference.Value -notin @($sid.Value,$system.Value) -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or $rule.IsInherited){throw 'private-acl-rule'}
}
[Console]::Out.Write('private')
`;
async function windowsPrivate(path: string, directory: boolean): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new Error();
  const executable = join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsAclScript, "utf16le").toString("base64")], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    let output = "";
    const deadline = setTimeout(() => { child.kill(); reject(new Error()); }, 15000);
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(0, 100); });
    child.once("error", () => { clearTimeout(deadline); reject(new Error()); });
    child.once("close", (code) => { clearTimeout(deadline); if (code === 0 && output.trim() === "private") resolve(); else reject(new Error()); });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ path, directory }));
  });
}
async function secure(path: string, directory: boolean): Promise<void> {
  try {
    if (!isAbsolute(path)) throw new Error();
    const info = await lstat(path);
    if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error();
    if (process.platform === "win32") await windowsPrivate(path, directory);
    else {
      await chmod(path, directory ? 0o700 : 0o600);
      const checked = await lstat(path);
      if ((checked.mode & 0o777) !== (directory ? 0o700 : 0o600) || checked.uid !== process.getuid?.()) throw new Error();
    }
  } catch { throw new DesktopError("STORAGE_ERROR", "无法建立当前用户的私有文件权限", true); }
}
export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await secure(path, true);
}
export const ensurePrivateFile = (path: string) => secure(path, false);
