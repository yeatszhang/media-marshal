"""桌面 Codex 独立进程协议；配置仅来自 Core，业务请求仅包含有界名称上下文。"""
import json
import os
import re
import signal
import sys
import threading
import time

from codex_recognition import Recognizer, BudgetExceeded

MAX_BYTES = 65536


def main():
    recognizer = None
    parent = os.getppid()

    def stop(*_args):
        process = getattr(recognizer, "active_process", None)
        if process is not None and process.poll() is None:
            try:
                if sys.platform == "win32":
                    process.kill()
                else:
                    os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        os._exit(0)

    signal.signal(signal.SIGTERM, stop)
    if sys.platform != "win32":
        def watch_parent():
            while True:
                time.sleep(0.25)
                if os.getppid() != parent:
                    stop()
        threading.Thread(target=watch_parent, daemon=True).start()

    reader = sys.stdin.buffer
    while True:
        line = reader.readline(MAX_BYTES + 1)
        if not line:
            stop()
        request_id = None
        try:
            if len(line) > MAX_BYTES:
                while line and not line.endswith(b"\n"):
                    line = reader.readline(MAX_BYTES + 1)
                raise ValueError()
            value = json.loads(line)
            request_id = value.get("requestId")
            if (not isinstance(request_id, str) or not re.fullmatch(r"[A-Za-z0-9-]{1,64}", request_id)
                    or value.get("protocolVersion") != 1 or type(value.get("protocolVersion")) is not int
                    or set(value) != {"protocolVersion", "requestId", "action", "input"}):
                raise ValueError()
            action, data = value["action"], value["input"]
            if action == "initialize" and recognizer is None:
                if (not isinstance(data, dict) or set(data) != {"runtime_dir", "codex_path", "model", "max_daily_calls"}
                        or not os.path.isabs(data["runtime_dir"])
                        or not isinstance(data["codex_path"], str) or not data["codex_path"]
                        or not isinstance(data["model"], str) or not data["model"]
                        or type(data["max_daily_calls"]) is not int or not 1 <= data["max_daily_calls"] <= 1000):
                    raise ValueError()
                recognizer = Recognizer(dict(data, timeout_seconds=150, web_search="live"))
                result = {"status": "ready"}
            elif recognizer is None:
                raise ValueError()
            elif action == "usage" and data == {}:
                result = recognizer.usage_today()
            elif action in ("recognize", "recognize-cluster", "recognize-directory"):
                result = {"recognize": recognizer.recognize, "recognize-cluster": recognizer.recognize_cluster,
                          "recognize-directory": recognizer.recognize_directory}[action](data)
            else:
                raise ValueError()
            reply = {"protocolVersion": 1, "requestId": request_id, "ok": True, "result": result}
        except Exception as error:
            if isinstance(error, BudgetExceeded):
                code, message = "BUDGET_EXCEEDED", "Codex 今日调用预算已用完，请明日重试或人工选择作品"
            elif isinstance(error, FileNotFoundError):
                code, message = "COMPONENT_UNAVAILABLE", "找不到 Codex CLI，请安装并在设置中核对可执行文件路径"
            elif isinstance(error, TimeoutError):
                code, message = "TIMEOUT", "Codex 识别超时，请检查网络后重试"
            elif isinstance(error, (ValueError, TypeError, KeyError, AttributeError)):
                code, message = "INVALID_REQUEST", "Codex 请求或结构化结果无效，请核对名称后重试"
            else:
                code, message = "RECOGNITION_FAILED", "Codex 调用未完成，请检查本机登录状态和网络后重试"
            reply = {"protocolVersion": 1, "requestId": request_id, "ok": False, "error": {"code": code, "message": message}}
        output = json.dumps(reply, ensure_ascii=False).encode("utf-8")
        if len(output) > 1024 * 1024:
            output = json.dumps({"protocolVersion": 1, "requestId": request_id, "ok": False,
                                 "error": {"code": "INVALID_RESPONSE", "message": "Codex 结果超过允许大小"}}).encode()
        sys.stdout.buffer.write(output + b"\n")
        sys.stdout.buffer.flush()
