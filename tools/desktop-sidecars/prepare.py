"""准备固定版本的桌面伴随程序；只在构建机运行，不属于应用运行依赖。"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import shutil
import stat
import sys
import tarfile
import tempfile
import urllib.request
import zipfile
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[2]
LOCK_PATH = Path(__file__).with_name("sidecars.lock.json")
TARGETS = ("darwin-arm64", "darwin-x64", "win32-x64")


def sha256(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify(path: Path, expected: str) -> None:
    if sha256(path) != expected:
        raise ValueError(f"完整性检查失败：{path.name}")


def download(url: str, destination: Path, expected: str) -> None:
    """缓存同样必须验摘要；损坏缓存直接报错，避免掩盖版本或来源异常。"""
    if destination.exists():
        verify(destination, expected)
        return
    if not url.startswith("https://"):
        raise ValueError("组件来源必须使用 HTTPS")
    destination.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=".download-", dir=destination.parent)
    temporary = Path(name)
    try:
        request = urllib.request.Request(url, headers={"User-Agent": "Media-Marshal-build"})
        with os.fdopen(fd, "wb") as output:
            with urllib.request.urlopen(request, timeout=60) as response:
                if not response.url.startswith("https://"):
                    raise ValueError("拒绝降级到非 HTTPS 下载")
                shutil.copyfileobj(response, output, length=1024 * 1024)
        verify(temporary, expected)
        os.replace(temporary, destination)
    finally:
        temporary.unlink(missing_ok=True)


def safe_member(name: str) -> None:
    path = PurePosixPath(name)
    if not name or path.is_absolute() or ".." in path.parts or "\\" in name or ":" in name:
        raise ValueError("压缩包成员路径无效")


def extract_binary(archive: Path, member: str, destination: Path, size: int) -> None:
    """只读取锁定的普通文件；不展开整个归档、链接或额外资源。"""
    safe_member(member)
    with destination.open("xb") as output:
        if archive.name.endswith(".zip"):
            with zipfile.ZipFile(archive) as package:
                matches = [entry for entry in package.infolist() if entry.filename == member]
                if len(matches) != 1:
                    raise ValueError("压缩包成员不存在或重复")
                entry = matches[0]
                mode = entry.external_attr >> 16
                if entry.is_dir() or stat.S_IFMT(mode) not in {0, stat.S_IFREG} or entry.file_size != size:
                    raise ValueError("压缩包成员类型或长度无效")
                with package.open(entry) as source:
                    shutil.copyfileobj(source, output, length=1024 * 1024)
        else:
            with tarfile.open(archive, "r:gz") as package:
                matches = [entry for entry in package.getmembers() if entry.name == member]
                if len(matches) != 1:
                    raise ValueError("压缩包成员不存在或重复")
                entry = matches[0]
                if not entry.isfile() or entry.size != size:
                    raise ValueError("压缩包成员类型或长度无效")
                source = package.extractfile(entry)
                if source is None:
                    raise ValueError("无法读取组件文件")
                with source:
                    shutil.copyfileobj(source, output, length=1024 * 1024)


def current_target() -> str:
    machine = platform.machine().lower()
    arch = {"arm64": "arm64", "aarch64": "arm64", "amd64": "x64", "x86_64": "x64"}.get(machine)
    target = f"{sys.platform}-{arch}"
    if target not in TARGETS:
        raise ValueError("当前平台没有桌面目标，请使用 --target 指定构建目标")
    return target


def prepare(target: str, lock: dict, cache: Path, output_root: Path) -> Path:
    if target not in TARGETS or lock.get("schemaVersion") != 1:
        raise ValueError("不支持的目标或锁文件版本")
    output_root.mkdir(parents=True, exist_ok=True)
    output = output_root / target
    temporary = Path(tempfile.mkdtemp(prefix=f".{target}-", dir=output_root))
    previous: Path | None = None
    try:
        (temporary / "bin").mkdir()
        (temporary / "licenses").mkdir()
        manifest = {"schemaVersion": 1, "target": target, "components": {}}
        for name in ("openlist", "rclone"):
            component = lock["components"][name]
            asset = component["assets"][target]
            archive = cache / asset["archive"]["name"]
            download(asset["archive"]["url"], archive, asset["archive"]["sha256"])
            binary = asset["binary"]
            safe_member(binary["name"])
            if PurePosixPath(binary["name"]).name != binary["name"]:
                raise ValueError("可执行文件名不得包含目录")
            destination = temporary / "bin" / binary["name"]
            extract_binary(archive, binary["member"], destination, binary["size"])
            verify(destination, binary["sha256"])
            destination.chmod(0o755)
            license_info = component["license"]
            license_path = LOCK_PATH.parent / license_info["file"]
            if not license_path.resolve().is_relative_to(LOCK_PATH.parent.resolve()):
                raise ValueError("许可证路径越界")
            verify(license_path, license_info["sha256"])
            shutil.copyfile(license_path, temporary / "licenses" / license_path.name)
            manifest["components"][name] = {
                "version": component["version"],
                "source": component["source"],
                "archiveSha256": asset["archive"]["sha256"],
                "binary": {"path": f"bin/{binary['name']}", "sha256": binary["sha256"], "size": binary["size"]},
                "license": {"spdx": license_info["spdx"], "path": f"licenses/{license_path.name}", "sha256": license_info["sha256"]},
            }
        (temporary / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        # 只在完整准备成功后替换既有目标，失败时仍保留上次可用产物。
        if output.exists():
            previous = Path(tempfile.mkdtemp(prefix=f".{target}-previous-", dir=output_root))
            previous.rmdir()
            output.rename(previous)
        try:
            temporary.rename(output)
        except BaseException:
            if previous is not None:
                previous.rename(output)
                previous = None
            raise
        return output
    finally:
        shutil.rmtree(temporary, ignore_errors=True)
        if previous is not None:
            shutil.rmtree(previous)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    choice = parser.add_mutually_exclusive_group()
    choice.add_argument("--target", choices=TARGETS)
    choice.add_argument("--all", action="store_true", help="只准备全部目标，不运行其他架构的程序")
    parser.add_argument("--cache-dir", type=Path, default=ROOT / "build-artifacts/desktop-sidecars/downloads")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "apps/desktop/resources/sidecars")
    args = parser.parse_args()
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    for target in TARGETS if args.all else [args.target or current_target()]:
        result = prepare(target, lock, args.cache_dir.resolve(), args.output_dir.resolve())
        print(f"已核验并准备：{target} → {result.relative_to(ROOT) if result.is_relative_to(ROOT) else result}")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, KeyError, tarfile.TarError, zipfile.BadZipFile) as error:
        print(f"组件准备失败：{error}", file=sys.stderr)
        raise SystemExit(1)
