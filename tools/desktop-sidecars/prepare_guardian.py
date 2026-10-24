"""用固定 Go 工具链构建应用自有守护；仅构建机需要 Go。"""
from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path
from prepare import ROOT, TARGETS, current_target, sha256


def prepare_guardian(target: str) -> None:
    version = subprocess.run(["go", "env", "GOVERSION"], check=True, stdout=subprocess.PIPE, text=True).stdout.strip()
    if version != "go1.26.0":
        raise ValueError("守护构建需要固定 Go 1.26.0")
    destination = ROOT / "apps/desktop/resources/sidecars" / target
    if not (destination / "manifest.json").is_file():
        raise ValueError("请先准备该目标的固定网盘组件")
    with tempfile.TemporaryDirectory(prefix=".guardian-", dir=destination) as directory:
        binary = Path(directory) / ("guardian.exe" if target == "win32-x64" else "guardian")
        system, arch = target.split("-")
        env = {**os.environ, "GOOS": "windows" if system == "win32" else "darwin", "GOARCH": "amd64" if arch == "x64" else "arm64", "CGO_ENABLED": "0", "GOTOOLCHAIN": "local"}
        subprocess.run(["go", "build", "-trimpath", "-buildvcs=false", "-o", str(binary), "."], cwd=Path(__file__).with_name("guardian"), env=env, check=True)
        manifest = {"schemaVersion": 1, "target": target, "goVersion": version, "binary": {"path": f"bin/{binary.name}", "sha256": sha256(binary), "size": binary.stat().st_size}}
        binary.chmod(0o755)
        shutil.copyfile(binary, destination / "bin" / binary.name)
        (destination / "bin" / binary.name).chmod(0o755)
        (destination / "guardian.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"已构建并记录守护摘要：{target}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    choice = parser.add_mutually_exclusive_group()
    choice.add_argument("--target", choices=TARGETS)
    choice.add_argument("--all", action="store_true")
    args = parser.parse_args()
    for target in TARGETS if args.all else [args.target or current_target()]:
        prepare_guardian(target)
