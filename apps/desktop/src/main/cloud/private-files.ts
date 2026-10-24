import { spawn } from "node:child_process";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { DesktopError } from "@media-marshal/contracts";

// 模板只插入 Base64 路径数据和布尔常量；没有 Cookie 或可执行的用户文本。
const windowsAclScript = `
$ErrorActionPreference='Stop'
function Send-PrivateResult([string]$value){
  $writer=[IO.StreamWriter]::new([Console]::OpenStandardOutput(),[Text.UTF8Encoding]::new($false))
  $writer.Write($value);$writer.Flush()
}
$stage='input'
try {
$directory=__PRIVATE_IS_DIRECTORY__
$path=[IO.Path]::GetFullPath([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PRIVATE_PATH_BASE64__')))
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
$system=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$stage='construct'
if($directory){$security=[Security.AccessControl.DirectorySecurity]::new();$inherit=[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'}
else{$security=[Security.AccessControl.FileSecurity]::new();$inherit=[Security.AccessControl.InheritanceFlags]::None}
$security.SetOwner($sid)
$security.SetAccessRuleProtection($true,$false)
foreach($identity in @($sid,$system)){
  $rule=[Security.AccessControl.FileSystemAccessRule]::new($identity,[Security.AccessControl.FileSystemRights]::FullControl,$inherit,[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
  $security.AddAccessRule($rule)
}
$stage='apply'
if($directory){[IO.Directory]::SetAccessControl($path,$security)}else{[IO.File]::SetAccessControl($path,$security)}
$stage='verify'
$actual=if($directory){[IO.Directory]::GetAccessControl($path)}else{[IO.File]::GetAccessControl($path)}
if(!$actual.AreAccessRulesProtected -or $actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value){throw 'private-acl-check'}
$rules=@($actual.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
if($rules.Count -ne 2){throw 'private-acl-count'}
foreach($rule in $rules){
  if($rule.IdentityReference.Value -notin @($sid.Value,$system.Value) -or $rule.AccessControlType -ne 'Allow' -or $rule.FileSystemRights -ne 'FullControl' -or $rule.IsInherited){throw 'private-acl-rule'}
}
Send-PrivateResult 'private'
} catch {
  Send-PrivateResult ('failed:'+$stage+':'+$_.Exception.HResult+':'+$_.Exception.GetType().Name)
  exit 1
}
`;
export class PrivateFileError extends DesktopError {
  constructor(readonly step: string, readonly systemCode?: string) {
    super("STORAGE_ERROR", "无法建立当前用户的私有文件权限", true);
    this.name = "PrivateFileError";
  }
}
async function windowsPrivate(path: string, directory: boolean): Promise<void> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !isAbsolute(systemRoot)) throw new Error();
  const executable = join(systemRoot, "System32/WindowsPowerShell/v1.0/powershell.exe");
  // 不继承宿主的 PSModulePath，防止 PowerShell 7 的模块环境污染系统 5.1 进程。
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH"));
  const script = windowsAclScript.replace("__PRIVATE_PATH_BASE64__", Buffer.from(path, "utf8").toString("base64")).replace("__PRIVATE_IS_DIRECTORY__", directory ? "$true" : "$false");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")], { env: environment, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    const deadline = setTimeout(() => { child.kill(); reject(new Error()); }, 15000);
    child.stdout.on("data", (chunk) => { output = (output + chunk).slice(0, 100); });
    child.once("error", () => { clearTimeout(deadline); reject(new Error()); });
    child.once("close", (code) => {
      clearTimeout(deadline);
      if (code === 0 && output.trim() === "private") resolve();
      else {
        const failure = output.trim().match(/^failed:(input|construct|apply|verify):(-?\d+):([A-Za-z0-9]+)$/);
        reject(new PrivateFileError(failure?.[1] ?? "powershell-control", failure ? `${failure[2]}:${failure[3]}` : undefined));
      }
    });
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
  } catch (error) { if (error instanceof PrivateFileError) throw error; throw new PrivateFileError("path-access"); }
}
export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await secure(path, true);
}
export const ensurePrivateFile = (path: string) => secure(path, false);
