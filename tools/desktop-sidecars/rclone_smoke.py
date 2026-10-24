"""验证锁定 Rclone 的真实 JSON 进度、部分失败、终止与重跑语义。"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import tempfile
import time
from pathlib import Path

from prepare import LOCK_PATH, ROOT, current_target, verify


def run(output: Path):
    target = current_target()
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    component = lock["components"]["rclone"]
    asset = component["assets"][target]["binary"]
    binary = ROOT / "apps/desktop/resources/sidecars" / target / "bin" / asset["name"]
    verify(binary, asset["sha256"])
    report = {"componentVersion": component["version"], "target": target, "scope": "临时本地文件，不能证明网盘传输或其他平台兼容", "checks": []}
    with tempfile.TemporaryDirectory(prefix="marshal-rclone-") as directory:
        root = Path(directory).resolve()
        source = root / "source"
        source.mkdir()
        config = root / "rclone.conf"
        config.write_text("", encoding="utf-8")
        config.chmod(0o600)
        env = {key: value for key, value in os.environ.items() if key in {"PATH", "HOME", "TMPDIR", "SYSTEMROOT", "WINDIR"}}
        flags = ["--config", str(config), "--use-json-log", "--stats", "100ms", "--stats-log-level", "INFO", "--log-level", "INFO", "--retries", "1", "--low-level-retries", "1", "--transfers", "2", "--multi-thread-streams", "1", "--local-no-clone"]

        def records(stderr: bytes):
            lines = stderr.decode("utf-8", errors="replace").splitlines()
            result = []
            for line in lines:
                entry = json.loads(line)
                # 测试输入均为自造文件；实际临时目录和时间不进入版本控制。
                entry.pop("time", None)
                serialized = json.dumps(entry, ensure_ascii=False).replace(str(root), "<临时目录>")
                result.append(json.loads(serialized))
            return result

        def execute(args):
            process = subprocess.run([str(binary), *args, *flags], cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30)
            return process.returncode, records(process.stderr)

        payload = b"Media Marshal rclone fixture\n"
        names = ["sample.txt", "中文 空格.txt", "-flag.txt"]
        if os.name != "nt":
            names.append("line\nbreak.txt")
        else:
            try:
                (source / "line\nbreak.txt").write_bytes(payload)
            except OSError:
                report["unsupportedNames"] = ["换行文件名：Windows 文件系统拒绝创建"]
            else:
                raise RuntimeError("Windows 名称校验结果与预期不符")
        for name in names:
            (source / name).write_bytes(payload)
        code, logs = execute(["copy", str(source), str(root / "completed")])
        assert code == 0 and all((root / "completed" / name).read_bytes() == payload for name in names)
        stats = [line for line in logs if "stats" in line]
        assert stats and stats[-1]["stats"]["transfers"] == len(names)
        report["checks"].append({"check": "特殊名称与 JSON 统计", "exitCode": code, "names": names, "logs": logs})

        file_list = root / "files.txt"
        (source / "blocked.txt").write_bytes(payload)
        blocker = root / "partial-batch/blocked.txt"
        blocker.mkdir(parents=True)
        (blocker / "keep.txt").write_bytes(b"occupied")
        file_list.write_text("sample.txt\nblocked.txt\n", encoding="utf-8")
        code, logs = execute(["copy", str(source), str(root / "partial-batch"), "--files-from-raw", str(file_list)])
        assert code != 0 and (root / "partial-batch/sample.txt").read_bytes() == payload
        report["checks"].append({"check": "非零退出但部分文件完成", "exitCode": code, "completedFilePresent": True, "logs": logs})

        large_source = root / "large-source"
        large_source.mkdir()
        data = b"MediaMarshal" * (512 * 1024)
        (large_source / "large.bin").write_bytes(data)
        stopped = root / "stopped"
        with tempfile.TemporaryFile() as error_stream:
            child = subprocess.Popen([str(binary), "copy", str(large_source), str(stopped), *flags, "--bwlimit", "1M"], cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=error_stream)
            try:
                deadline = time.monotonic() + 10
                while True:
                    if child.poll() is not None:
                        raise RuntimeError("限速传输在停止前已退出")
                    if stopped.exists() and any(p.stat().st_size >= 128 * 1024 for p in stopped.iterdir() if p.is_file()):
                        break
                    if time.monotonic() >= deadline:
                        raise RuntimeError("限速传输未产生暂存数据")
                    time.sleep(0.05)
                child.terminate()
                child.wait(timeout=8)
                assert child.returncode != 0 and not (stopped / "large.bin").exists()
                error_stream.seek(0)
                stop_logs = records(error_stream.read())
            finally:
                if child.poll() is None:
                    child.kill()
                    child.wait(timeout=5)
        # 新 attempt 使用全新目录，不依赖残留 .partial 的续传语义。
        code, restart_logs = execute(["copy", str(large_source), str(root / "restarted")])
        digest = hashlib.sha256((root / "restarted/large.bin").read_bytes()).digest()
        assert code == 0 and digest == hashlib.sha256(data).digest()
        report["checks"].append({"check": "停止后新 attempt 重新下载", "stopExitCode": child.returncode, "restartExitCode": code, "size": len(data), "byteResumeGuaranteed": False, "stopLogs": stop_logs, "restartLogs": restart_logs})
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print("Rclone 实测通过：特殊名称、JSON 统计、部分失败、停止及新 attempt 重跑。")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "test-results/sidecars/rclone-smoke.json")
    run(parser.parse_args().output)
