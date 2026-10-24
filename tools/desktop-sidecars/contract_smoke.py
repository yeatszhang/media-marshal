"""用临时本地挂载验证固定版本 OpenList 的管理、分页与只读 WebDAV 契约。"""

from __future__ import annotations

import argparse
import base64
import json
import os
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from prepare import LOCK_PATH, ROOT, current_target, verify


def run(output: Path) -> None:
    target = current_target()
    lock = json.loads(LOCK_PATH.read_text(encoding="utf-8"))
    component = lock["components"]["openlist"]
    asset = component["assets"][target]["binary"]
    binary = ROOT / "apps/desktop/resources/sidecars" / target / "bin" / asset["name"]
    verify(binary, asset["sha256"])
    records = []
    with tempfile.TemporaryDirectory(prefix="marshal-contract-") as directory:
        root = Path(directory).resolve()
        root.chmod(0o700)
        data = root / "openlist"
        data.mkdir(mode=0o700)
        content = root / "source"
        content.mkdir(mode=0o700)
        payload = b"Media Marshal sidecar integration fixture\n"
        (content / "sample.txt").write_bytes(payload)
        (content / "电影 样片.txt").write_bytes(payload)
        with socket.socket() as probe:
            probe.bind(("127.0.0.1", 0))
            port = probe.getsockname()[1]
        endpoint = f"http://127.0.0.1:{port}"
        config = {
            "force": True,
            "jwt_secret": secrets.token_urlsafe(48),
            "scheme": {"address": "127.0.0.1", "http_port": port, "https_port": -1},
            "database": {"type": "sqlite3", "db_file": str(data / "data.db"), "table_prefix": "x_"},
            "log": {"enable": False},
            "cors": {"allow_origins": ["http://127.0.0.1"], "allow_methods": ["GET", "POST"], "allow_headers": ["Authorization", "Content-Type"]},
            "s3": {"enable": False}, "ftp": {"enable": False},
            "sftp": {"enable": False}, "mcp": {"enable": False},
        }
        config_path = data / "config.json"
        config_path.write_text(json.dumps(config), encoding="utf-8")
        config_path.chmod(0o600)
        admin_password = secrets.token_urlsafe(32)
        reader_password = secrets.token_urlsafe(32)
        # 上游会在首次启动 stdout 输出初始密码；丢弃原始进程日志，不留在夹具或诊断中。
        env = {key: value for key, value in os.environ.items() if key in {"PATH", "HOME", "TMPDIR", "SYSTEMROOT", "WINDIR"}}
        env["OPENLIST_ADMIN_PASSWORD"] = admin_password
        process = subprocess.Popen(
            [str(binary), "--data", str(data), "--config", str(config_path), "server"],
            cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            **({"umask": 0o077} if os.name == "posix" else {}),
        )

        def sanitize(value, key=""):
            if key.lower() in {"password", "token", "sign", "raw_url", "addition", "cookie", "jwt_secret", "otp_secret"}:
                return "<已脱敏>" if value else value
            if isinstance(value, dict):
                return {k: sanitize(v, k) for k, v in value.items()}
            if isinstance(value, list):
                return [sanitize(v) for v in value]
            if isinstance(value, str):
                return value.replace(str(root), "<临时目录>").replace(endpoint, "http://127.0.0.1:<端口>")
            return value

        # 不使用系统代理访问回环组件。
        client = urllib.request.build_opener(urllib.request.ProxyHandler({}))

        def api(method, path, body=None, token=None, expected=200):
            request = urllib.request.Request(endpoint + path, method=method)
            if token:
                request.add_header("Authorization", token)
            if body is not None:
                request.data = json.dumps(body).encode()
                request.add_header("Content-Type", "application/json")
            try:
                response = client.open(request, timeout=15)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                result = json.loads(response.read(2 * 1024 * 1024))
                records.append({"method": method, "path": path, "authenticated": token is not None, "request": sanitize(body), "httpStatus": response.status, "response": sanitize(result)})
            if result.get("code") != expected:
                raise RuntimeError(f"契约检查失败：{method} {path}，code={result.get('code')}")
            return result.get("data")

        def dav(method, name="", auth=True, body=None, headers=None, expected=200):
            request = urllib.request.Request(endpoint + "/dav/" + urllib.parse.quote(name), data=body, method=method)
            if auth:
                encoded = base64.b64encode(f"reader:{reader_password}".encode()).decode()
                request.add_header("Authorization", f"Basic {encoded}")
            for key, value in (headers or {}).items():
                request.add_header(key, value)
            try:
                response = client.open(request, timeout=15)
            except urllib.error.HTTPError as error:
                response = error
            with response:
                result = response.read(1024 * 1024)
                records.append({"method": method, "path": "/dav/" + name, "authenticated": auth, "httpStatus": response.status, "headers": {k: v for k, v in response.headers.items() if k.lower() in {"content-length", "content-range", "content-type"}}})
                if response.status != expected:
                    raise RuntimeError(f"WebDAV 契约检查失败：{method}，status={response.status}")
                return result

        try:
            deadline = time.monotonic() + 20
            while True:
                if process.poll() is not None:
                    raise RuntimeError("OpenList 启动失败，未保存可能包含密钥的原始输出")
                try:
                    with client.open(endpoint + "/ping", timeout=1) as response:
                        if response.read() == b"pong":
                            break
                except (OSError, urllib.error.URLError):
                    if time.monotonic() >= deadline:
                        raise RuntimeError("OpenList 就绪超时") from None
                    time.sleep(0.1)
            token = api("POST", "/api/auth/login", {"username": "admin", "password": admin_password})["token"]
            me = api("GET", "/api/me", token=token)
            assert me["username"] == "admin" and me["role"] == 2
            api("GET", "/api/public/init_status")
            api("GET", "/api/admin/driver/info?driver=Quark", token=token)
            storage = api("POST", "/api/admin/storage/create", {
                "mount_path": "/fixture", "driver": "Local", "addition": json.dumps({"root_folder_path": str(content)}),
                "cache_expiration": 1, "web_proxy": True, "webdav_policy": "native_proxy", "proxy_range": True, "enable_sign": True,
            }, token)
            api("GET", "/api/admin/storage/list?page=1&per_page=10", token=token)
            api("POST", "/api/admin/user/create", {"username": "reader", "password": reader_password, "role": 0, "base_path": "/fixture", "permission": 256}, token)
            page1 = api("POST", "/api/fs/list", {"path": "/fixture", "page": 1, "per_page": 1, "refresh": True}, token)
            page2 = api("POST", "/api/fs/list", {"path": "/fixture", "page": 2, "per_page": 1, "refresh": False}, token)
            assert page1["total"] == 2 and len(page1["content"]) == 1 and len(page2["content"]) == 1
            assert page1["content"][0]["name"] != page2["content"][0]["name"]
            api("POST", "/api/fs/get", {"path": "/fixture/sample.txt"}, token)
            api("POST", "/api/fs/list", {"path": "/fixture", "page": 1, "per_page": 10}, expected=401)
            dav("PROPFIND", auth=False, headers={"Depth": "1"}, expected=401)
            dav("PROPFIND", headers={"Depth": "1"}, expected=207)
            assert dav("GET", "sample.txt") == payload
            assert dav("GET", "电影 样片.txt") == payload
            dav("HEAD", "sample.txt")
            assert dav("GET", "sample.txt", headers={"Range": "bytes=0-4"}, expected=206) == payload[:5]
            dav("PUT", "forbidden.txt", body=b"do not write", expected=403)
            assert not (content / "forbidden.txt").exists()
            for route in ["/d/fixture/sample.txt", "/p/fixture/sample.txt"]:
                try:
                    with client.open(endpoint + route, timeout=5) as response:
                        status = response.status
                except urllib.error.HTTPError as error:
                    status = error.code
                    error.close()
                assert status in {401, 403}, f"匿名下载未被拒绝：{route} status={status}"
                records.append({"method": "GET", "path": route, "authenticated": False, "httpStatus": status})
            users = api("GET", "/api/admin/user/list?page=1&per_page=10", token=token)
            assert all(user["disabled"] for user in users["content"] if user["role"] == 1)
            file_permissions = {}
            if os.name == "posix":
                for private_file in data.rglob("*"):
                    if private_file.is_file():
                        mode = private_file.stat().st_mode & 0o777
                        assert mode == 0o600, "组件私有文件权限不符合要求"
                        file_permissions[str(private_file.relative_to(data))] = oct(mode)
            api("POST", f"/api/admin/storage/delete?id={storage['id']}", token=token)
            result = {
                "schemaVersion": 1, "componentVersion": component["version"], "sourceCommit": component["source"]["commit"],
                "target": target, "scope": "临时 Local 驱动，不能作为真实夸克账号或其他平台验收证据", "records": records,
                "security": {"privateDirectoryMode": "0o700" if os.name == "posix" else "尚需 Windows ACL 验收", "privateFileModes": file_permissions, "rawLogsRetained": False},
            }
            serialized = json.dumps(result, indent=2, ensure_ascii=False) + "\n"
            assert admin_password not in serialized and reader_password not in serialized and token not in serialized
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(serialized, encoding="utf-8")
        finally:
            process.terminate()
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
    print(f"OpenList 契约检查通过：{len(records)} 次请求；夹具已脱敏")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=ROOT / "test-results/sidecars/openlist-contract.json")
    args = parser.parse_args()
    run(args.output)
