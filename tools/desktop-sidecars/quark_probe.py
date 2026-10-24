"""凭据仅从 stdin 读取；只读验证用户指定文件的最多 8 MiB 内容。"""
from __future__ import annotations

import base64
import json
import os
import posixpath
import secrets
import signal
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from prepare import LOCK_PATH, ROOT, current_target, verify


def run():
    request = json.load(sys.stdin)
    cookie, remote = request["cookie"], request["remotePath"]
    if not cookie or "\n" in cookie or "\r" in cookie or not remote.startswith("/") or any(p in {".", ".."} for p in remote.split("/")):
        raise ValueError("凭据或测试路径无效")
    component = json.loads(LOCK_PATH.read_text())["components"]["openlist"]
    target = current_target()
    asset = component["assets"][target]["binary"]
    binary = ROOT / "apps/desktop/resources/sidecars" / target / "bin" / asset["name"]
    verify(binary, asset["sha256"])
    report = {"target": target, "version": component["version"], "driver": "Quark", "membership": request.get("membership", "用户未说明"), "checks": [], "passed": False}
    client = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    process = None
    phase = "初始化"
    with tempfile.TemporaryDirectory(prefix="marshal-quark-probe-") as directory:
        root = Path(directory).resolve()
        root.chmod(0o700)
        try:
            with socket.socket() as socket_probe:
                socket_probe.bind(("127.0.0.1", 0))
                port = socket_probe.getsockname()[1]
            endpoint = f"http://127.0.0.1:{port}"
            config = root / "config.json"
            config.write_text(json.dumps({"force": True, "jwt_secret": secrets.token_urlsafe(48), "scheme": {"address": "127.0.0.1", "http_port": port, "https_port": -1}, "database": {"type": "sqlite3", "db_file": str(root / "data.db"), "table_prefix": "x_"}, "log": {"enable": False}, "s3": {"enable": False}, "ftp": {"enable": False}, "sftp": {"enable": False}, "mcp": {"enable": False}}))
            config.chmod(0o600)
            password, reader = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            keys = {"PATH", "HOME", "TMPDIR", "SYSTEMROOT", "WINDIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"}
            environment = {key: value for key, value in os.environ.items() if key in keys}
            environment.update(OPENLIST_ADMIN_PASSWORD=password, NO_PROXY="127.0.0.1,localhost")
            process = subprocess.Popen([str(binary), "--data", str(root), "--config", str(config), "server"], cwd=root, env=environment, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, **({"umask": 0o077} if os.name == "posix" else {}))

            def interrupted(*_):
                raise KeyboardInterrupt
            signal.signal(signal.SIGTERM, interrupted)

            def api(path, body=None, token=None):
                headers = {"Content-Type": "application/json"}
                if token: headers["Authorization"] = token
                req = urllib.request.Request(endpoint + path, data=json.dumps(body).encode() if body is not None else None, headers=headers)
                try: response = client.open(req, timeout=30)
                except urllib.error.HTTPError as error: response = error
                with response: result = json.loads(response.read(2 * 1024 * 1024))
                return result

            def success(path, body=None, token=None):
                result = api(path, body, token)
                if result.get("code") != 200:
                    report["upstreamCode"] = result.get("code")
                    raise RuntimeError("上游请求失败")
                return result.get("data")

            deadline = time.monotonic() + 20
            while True:
                if process.poll() is not None: raise RuntimeError("组件已退出")
                try:
                    with client.open(endpoint + "/ping", timeout=1) as response:
                        if response.read() == b"pong": break
                except OSError:
                    if time.monotonic() >= deadline: raise TimeoutError("组件就绪超时") from None
                    time.sleep(0.1)
            token = success("/api/auth/login", {"username": "admin", "password": password})["token"]
            phase = "真实账号挂载"
            success("/api/admin/storage/create", {"driver": "Quark", "mount_path": "/quark", "addition": json.dumps({"cookie": cookie, "root_folder_id": "0", "use_transcoding_address": False}), "web_proxy": True, "webdav_policy": "native_proxy", "proxy_range": True, "enable_sign": True}, token)
            report["checks"].append({"check": phase, "passed": True})
            success("/api/admin/user/create", {"username": "reader", "password": reader, "role": 0, "base_path": "/quark", "permission": 256}, token)
            phase = "根目录读取"
            success("/api/fs/list", {"path": "/quark", "page": 1, "per_page": 1, "refresh": True}, token)
            phase = "测试路径定位"
            candidates = [remote]
            if remote.startswith("/文件/"):
                candidates.append(remote.removeprefix("/文件"))
            metadata = None
            for candidate in candidates:
                result = api("/api/fs/get", {"path": "/quark" + candidate}, token)
                if result.get("code") == 200:
                    metadata, remote = result["data"], candidate
                    break
            if metadata is None: raise FileNotFoundError("无法定位指定测试文件")
            phase = "父目录读取"
            listing = success("/api/fs/list", {"path": "/quark" + posixpath.dirname(remote), "page": 1, "per_page": 1, "refresh": True}, token)
            report["checks"].append({"check": phase, "passed": True, "count": listing["total"]})
            phase = "测试文件信息"
            if metadata["is_dir"] or metadata["size"] <= 0: raise ValueError("请选择非空文件")
            report["fileSize"] = metadata["size"]
            report["versionEvidence"] = {"stableId": "fid" in metadata or "id" in metadata, "hashAvailable": bool(metadata.get("hash_info")), "mtimeAvailable": bool(metadata.get("modified")), "comparison": "弱元数据比较"}
            auth = "Basic " + base64.b64encode(f"reader:{reader}".encode()).decode()

            def read(range_value=None, authenticated=True):
                req = urllib.request.Request(endpoint + "/dav/" + urllib.parse.quote(remote.lstrip("/")))
                if authenticated: req.add_header("Authorization", auth)
                if range_value: req.add_header("Range", range_value)
                try: response = client.open(req, timeout=60)
                except urllib.error.HTTPError as error: response = error
                with response: return response.status, response.read(8 * 1024 * 1024 + 1)

            phase = "匿名读取拒绝"
            assert read(authenticated=False)[0] == 401
            report["checks"].append({"check": phase, "passed": True})
            phase = "代理下载"
            sample_size = min(metadata["size"], 8 * 1024 * 1024)
            sampled = metadata["size"] > sample_size
            status, payload = read(f"bytes=0-{sample_size - 1}" if sampled else None)
            assert status == (206 if sampled else 200) and len(payload) == sample_size
            report["checks"].append({"check": phase, "passed": True, "bytes": len(payload), "wholeFile": not sampled})
            phase = "Range 字节一致性"
            end = min(1023, len(payload) - 1)
            status, partial = read(f"bytes=0-{end}")
            assert status == 206 and partial == payload[:end + 1]
            report["checks"].append({"check": phase, "passed": True, "bytes": len(partial)})
            phase = "失效 Cookie"
            invalid = api("/api/admin/storage/create", {"driver": "Quark", "mount_path": "/invalid", "addition": json.dumps({"cookie": "__pus=invalid; __puus=invalid", "root_folder_id": "0"})}, token)
            invalid_list = api("/api/fs/list", {"path": "/invalid", "page": 1, "per_page": 1, "refresh": True}, token)
            assert invalid.get("code") != 200 or invalid_list.get("code") != 200
            report["checks"].append({"check": phase, "passed": True, "createCode": invalid.get("code"), "listCode": invalid_list.get("code")})
            report["passed"] = True
        except BaseException as error:
            report.update(failedPhase=phase, errorCategory=type(error).__name__)
        finally:
            if process is not None and process.poll() is None:
                process.terminate()
                try: process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
    output = ROOT / "test-results/sidecars/quark-probe.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(report, ensure_ascii=False), flush=True)
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(run())
