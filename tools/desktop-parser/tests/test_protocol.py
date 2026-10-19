"""同一套夹具验证源码进程和冻结产物。"""

import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]


def request(action="parse", **extra):
    return {"protocolVersion": 1, "requestId": "fixture-1", "action": action, **extra}


def execute(lines):
    executable = os.environ.get("PARSER_EXECUTABLE")
    args = [executable] if executable else [sys.executable, str(ROOT / "main.py")]
    env = dict(os.environ)
    env.pop("PYTHONPATH", None)
    env.pop("PYTHONHOME", None)
    if executable:
        env["PATH"] = ""
    process = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    stdout, stderr = process.communicate(b"".join(lines), timeout=15)
    if process.returncode != 0:
        raise AssertionError(f"解析器异常退出：{process.returncode}，stderr={stderr!r}")
    if stderr:
        raise AssertionError(f"解析器不应输出名称或日志：{stderr!r}")
    return [json.loads(line) for line in stdout.splitlines()]


def encoded(value):
    return json.dumps(value, ensure_ascii=False).encode("utf-8") + b"\n"


class ProtocolTests(unittest.TestCase):
    def test_health_and_eof(self):
        self.assertEqual(execute([encoded(request("health"))])[0]["result"], {"status": "ready", "guessitVersion": "3.8.0"})

    def test_original_movie_fixture(self):
        result = execute([encoded(request(filename="The.Dark.Knight.2008.1080p.BluRay.x264.mkv"))])[0]["result"]
        self.assertEqual(result["title"], "The Dark Knight")
        self.assertEqual(result["year"], 2008)
        self.assertEqual(result["type"], "movie")

    def test_original_episode_fixture(self):
        result = execute([encoded(request(filename="Breaking.Bad.S03E07.1080p.mkv"))])[0]["result"]
        self.assertEqual((result["title"], result["season"], result["episode"], result["type"]), ("Breaking Bad", 3, 7, "episode"))

    def test_multi_episode(self):
        result = execute([encoded(request(filename="Show.S01E02E03.mkv"))])[0]["result"]
        self.assertEqual(result["episode"], [2, 3])

    def test_invalid_json_and_oversized_line_recover(self):
        replies = execute([b"not json\n", b"x" * 65537 + b"\n", encoded(request("health"))])
        self.assertEqual(len(replies), 3)
        self.assertEqual(replies[0]["error"]["code"], "INVALID_REQUEST")
        self.assertEqual(replies[1]["error"]["code"], "INVALID_REQUEST")
        self.assertTrue(replies[2]["ok"])

    def test_reject_version_extra_fields_and_paths(self):
        for value in [dict(request("health"), protocolVersion=0), dict(request("health"), sql="SELECT 1"), request(filename="/tmp/secret.mkv"), request(filename="")]:
            self.assertFalse(execute([encoded(value)])[0]["ok"])

    def test_shell_text_is_data(self):
        reply = execute([encoded(request(filename="Movie.$(touch SHOULD_NOT_EXIST).2024.mkv"))])[0]
        self.assertTrue(reply["ok"])
        self.assertFalse((Path.cwd() / "SHOULD_NOT_EXIST").exists())


if __name__ == "__main__":
    unittest.main()
