"""桌面解析器：仅通过有界 JSON Lines 处理名称文本，不访问媒体文件。"""

import json
import re
import sys
import os
import threading
import time
from importlib.metadata import version

from guessit import guessit

PROTOCOL_VERSION = 1
MAX_REQUEST_BYTES = 65536
MAX_RESPONSE_BYTES = 1024 * 1024
REQUEST_ID = re.compile(r"[A-Za-z0-9-]{1,64}\Z")


def response(request_id, *, result=None, error=None):
    value = {"protocolVersion": PROTOCOL_VERSION, "requestId": request_id, "ok": error is None}
    value["result" if error is None else "error"] = result if error is None else error
    encoded = json.dumps(value, ensure_ascii=False, default=str).encode("utf-8")
    if len(encoded) > MAX_RESPONSE_BYTES:
        return response(request_id, error={"code": "INVALID_RESPONSE", "message": "解析结果超过允许大小"})
    return encoded + b"\n"


def handle(line):
    request_id = None
    try:
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError()
        candidate = value.get("requestId")
        if not isinstance(candidate, str) or not REQUEST_ID.fullmatch(candidate):
            raise ValueError()
        request_id = candidate
        if type(value.get("protocolVersion")) is not int or value.get("protocolVersion") != PROTOCOL_VERSION:
            return response(request_id, error={"code": "PROTOCOL_MISMATCH", "message": "解析器协议版本不兼容"})
        action = value.get("action")
        if action == "health" and set(value) == {"protocolVersion", "requestId", "action"}:
            return response(request_id, result={"status": "ready", "guessitVersion": version("guessit")})
        if action != "parse" or set(value) != {"protocolVersion", "requestId", "action", "filename"}:
            raise ValueError()
        filename = value["filename"]
        if not isinstance(filename, str) or not filename.strip() or len(filename) > 16384:
            raise ValueError()
        if any(char in filename for char in ("/", "\\", "\0", "\r", "\n")):
            raise ValueError()
    except (ValueError, TypeError, UnicodeDecodeError):
        return response(request_id, error={"code": "INVALID_REQUEST", "message": "名称解析请求无效"})
    try:
        return response(request_id, result=dict(guessit(filename)))
    except Exception:
        # 不将名称、堆栈或未知异常文本写入日志和响应。
        return response(request_id, error={"code": "PARSE_FAILED", "message": "名称解析失败"})


def main():
    if sys.platform != "win32":
        parent_pid = os.getppid()
        def watch_parent():
            # 即使 guessit 正在计算，Core 强杀后也退出；不按进程名查找或杀其他程序。
            while True:
                time.sleep(0.5)
                if os.getppid() != parent_pid:
                    os._exit(0)
        threading.Thread(target=watch_parent, daemon=True).start()
    reader, writer = sys.stdin.buffer, sys.stdout.buffer
    while True:
        line = reader.readline(MAX_REQUEST_BYTES + 1)
        if not line:
            return
        if len(line) > MAX_REQUEST_BYTES:
            while not line.endswith(b"\n"):
                line = reader.readline(MAX_REQUEST_BYTES + 1)
                if not line:
                    break
            output = response(None, error={"code": "INVALID_REQUEST", "message": "请求超过允许大小"})
        else:
            output = handle(line)
        try:
            writer.write(output)
            writer.flush()
        except BrokenPipeError:
            return


if __name__ == "__main__":
    main()
