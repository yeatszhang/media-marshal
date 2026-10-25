"""准备当前本机架构的冻结解析器、许可与完整性清单，不在用户运行时安装依赖。"""
import argparse
import hashlib
import importlib.metadata
import json
import os
from pathlib import Path
import platform
import shutil
import struct
import subprocess
import sys
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "tools/desktop-parser"
PYTHON_LICENSE = "https://raw.githubusercontent.com/python/cpython/v3.11.14/LICENSE"
PYTHON_LICENSE_SHA256 = "3b2f81fe21d181c499c59a256c8e1968455d6689d269aa85373bfb6af41da3bf"


def digest(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def inventory(root):
    values = {}
    total = 0
    for path in sorted(root.rglob("*")):
        relative = path.relative_to(root).as_posix()
        if path.is_symlink():
            target = os.readlink(path)
            if Path(target).is_absolute() or not path.resolve().is_relative_to(root.resolve()) or ".." in Path(target).parts:
                raise ValueError("冻结产物包含未支持的链接")
            values[relative] = {"link": target}
        elif path.is_file():
            size = path.stat().st_size
            total += size
            if size > 128 * 1024 * 1024 or total > 512 * 1024 * 1024:
                raise ValueError("冻结产物超过允许大小")
            values[relative] = {"sha256": digest(path), "size": size}
    if not values or len(values) > 4096:
        raise ValueError("冻结产物文件数无效")
    return values


def prepare(target):
    actual = ("darwin" if sys.platform == "darwin" else "win32" if sys.platform == "win32" else sys.platform) + "-" + {"aarch64": "arm64", "arm64": "arm64", "x86_64": "x64", "amd64": "x64"}.get(platform.machine().lower(), "unknown")
    if target != actual or target not in ("darwin-arm64", "darwin-x64", "win32-x64"):
        raise ValueError("解析器必须在匹配架构的目标系统原生冻结")
    if sys.version_info[:3] != (3, 11, 14):
        raise ValueError("当前解析器构建固定使用 Python 3.11.14")
    versions = {name: importlib.metadata.version(name) for name in ("guessit", "rebulk", "babelfish", "pyinstaller")}
    if versions != {"guessit": "3.8.0", "rebulk": "6.0.1", "babelfish": "0.6.1", "pyinstaller": "6.22.3"}:
        raise ValueError("解析依赖与固定清单不符，请使用带哈希的构建依赖")
    sources = ["main.py", "build.py", "prepare.py", "requirements-build.txt"]
    source_hash = hashlib.sha256(json.dumps({name: digest(SOURCE / name) for name in sources}, sort_keys=True).encode()).hexdigest()
    destination = ROOT / "apps/desktop/resources/parser" / target
    existing = destination / "manifest.json"
    if existing.is_file():
        old = json.loads(existing.read_text())
        if old.get("sourceHash") == source_hash and old.get("target") == target and old.get("pythonVersion") == platform.python_version() and inventory(destination / "runtime") == old.get("files"):
            print(f"冻结解析器及依赖摘要已核验：{target}")
            return
    # 原始构建日志仅属于开发输出；不读取媒体、账号或凭据。
    result = subprocess.run([sys.executable, str(SOURCE / "build.py")], capture_output=True, timeout=180)
    if result.returncode:
        raise ValueError("冻结解析器构建失败；请单独运行 build.py 查看开发日志")
    frozen = SOURCE / "dist/media-marshal-parser"
    inventory(frozen)
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".parser-prepared-", dir=destination.parent))
    try:
        runtime = temporary / "runtime"
        shutil.copytree(frozen, runtime, symlinks=True)
        entry = "media-marshal-parser.exe" if sys.platform == "win32" else "media-marshal-parser"
        if sys.platform == "darwin":
            header = (runtime / entry).read_bytes()[:8]
            if struct.unpack("<II", header) != (0xFEEDFACF, 0x100000C if target.endswith("arm64") else 0x1000007):
                raise ValueError("解析器 Mach-O 架构与目标不符")
        licenses = runtime / "licenses"
        licenses.mkdir()
        for name in versions:
            distribution = importlib.metadata.distribution(name)
            matches = [file for file in distribution.files or [] if "license" in file.name.lower() or "copying" in file.name.lower()]
            if not matches:
                raise ValueError("缺少解析依赖许可")
            for file in matches:
                path = Path(distribution.locate_file(file))
                if path.is_file():
                    shutil.copyfile(path, licenses / f"{name}-{file.name}")
        cache = ROOT / "build-artifacts/desktop-parser/licenses/Python-3.11.14.LICENSE"
        if not cache.is_file():
            cache.parent.mkdir(parents=True, exist_ok=True)
            data = urllib.request.urlopen(PYTHON_LICENSE, timeout=30).read()
            if hashlib.sha256(data).hexdigest() != PYTHON_LICENSE_SHA256:
                raise ValueError("Python 固定许可摘要不符")
            cache.write_bytes(data)
        if digest(cache) != PYTHON_LICENSE_SHA256:
            raise ValueError("Python 许可缓存摘要不符")
        shutil.copyfile(cache, licenses / "Python.LICENSE")
        (runtime / "SOURCE-NOTICE.txt").write_text("Media Marshal 离线名称解析器（未签名内测）\n\nPython 3.11.14，guessit 3.8.0，rebulk 6.0.1，babelfish 0.6.1，PyInstaller 6.22.3。\n版本与构建资产哈希见 ASAR 内 manifest.json；固定 Python 许可来自 " + PYTHON_LICENSE + "。\n对应源码与校验：tools/desktop-parser/main.py、build.py、prepare.py、requirements-build.txt。\n程序通过 stdio 接收名称，不读取媒体文件、不启动 HTTP 服务。\n")
        manifest = {"schemaVersion": 1, "target": target, "protocolVersion": 1, "guessitVersion": "3.8.0", "pythonVersion": platform.python_version(), "sourceHash": source_hash, "entryPoint": entry, "files": inventory(runtime)}
        (temporary / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        if destination.exists():
            shutil.rmtree(destination)
        temporary.rename(destination)
        print(f"冻结解析器已准备：{target}，{len(manifest['files'])} 个受管文件，包含许可")
    finally:
        if temporary.exists():
            shutil.rmtree(temporary)


if __name__ == "__main__":
    arguments = argparse.ArgumentParser()
    arguments.add_argument("--target", required=True)
    try:
        prepare(arguments.parse_args().target)
    except Exception as error:
        raise SystemExit(f"解析器准备失败：{error}")
