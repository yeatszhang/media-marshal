"""桌面生产协议验证；只使用隔离目录和假 CLI，不访问模型账号。"""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]


def request(action, data, request_id="test-1"):
    return dict(protocolVersion=1, requestId=request_id, action=action, input=data)


class CodexStdioTests(unittest.TestCase):
    def execute(self, values):
        executable = os.environ.get("PARSER_EXECUTABLE")
        args = [executable] if executable else [sys.executable, str(ROOT / "main.py")]
        run = subprocess.run(args + ["--codex-stdio"], input="".join(json.dumps(v) + "\n" for v in values),
                             capture_output=True, text=True, timeout=10)
        self.assertEqual(run.returncode, 0)
        self.assertEqual(run.stderr, "")
        return [json.loads(line) for line in run.stdout.splitlines()]

    def config(self, root, cli="/isolated/missing-codex"):
        return dict(runtime_dir=root, codex_path=cli, model="gpt-6-luna", max_daily_calls=10)

    def test_initialization_usage_and_invalid_requests(self):
        with tempfile.TemporaryDirectory() as root:
            rows = self.execute([request("usage", {}), request("initialize", self.config(root)), request("usage", {}),
                                 request("sql", {}), request("recognize", {})])
            self.assertEqual(rows[0]["error"]["code"], "INVALID_REQUEST")
            self.assertEqual(rows[1]["result"], {"status": "ready"})
            self.assertEqual(rows[2]["result"]["calls"], 0)
            self.assertEqual(rows[2]["result"]["call_limit"], 10)
            self.assertFalse(rows[3]["ok"])
            self.assertFalse(rows[4]["ok"])

    def test_missing_cli_reports_repair_and_persists_budget(self):
        with tempfile.TemporaryDirectory() as root:
            context = dict(filename="unknown.mkv", parents=["未知作品"], siblings=["unknown.mkv"])
            rows = self.execute([request("initialize", self.config(root)), request("recognize", context), request("usage", {})])
            self.assertEqual(rows[1]["error"]["code"], "COMPONENT_UNAVAILABLE")
            self.assertNotIn("/isolated", json.dumps(rows[1]))
            self.assertEqual(rows[2]["result"]["calls"], 1)
            rows = self.execute([request("initialize", self.config(root)), request("usage", {})])
            self.assertEqual(rows[1]["result"]["calls"], 1)

    @unittest.skipIf(sys.platform == "win32", "假CLI使用POSIX可执行脚本")
    def test_successful_cli_result_cache_and_usage_cross_process(self):
        with tempfile.TemporaryDirectory() as root:
            cli = Path(root) / "fake-codex"
            result = dict(status="identified", title="隔离作品", year=2026, type="movie",
                          season=None, episode=None, confidence=0.97, reason="隔离官网依据")
            cli.write_text(f'''#!{sys.executable}
import json,sys
from pathlib import Path
sys.stdin.read()
Path(sys.argv[sys.argv.index('--output-last-message')+1]).write_text({json.dumps(result, ensure_ascii=False)!r})
print(json.dumps({{"type":"turn.completed","usage":{{"input_tokens":31,"output_tokens":7,"cached_input_tokens":4}}}}))
''')
            cli.chmod(0o700)
            context = dict(filename="Movie.2026.mkv", parents=["电影"], siblings=["Movie.2026.mkv"])
            rows = self.execute([request("initialize", self.config(root, str(cli))),
                                 request("recognize", context), request("usage", {})])
            self.assertEqual(rows[1]["result"], result)
            self.assertEqual(rows[2]["result"]["calls"], 1)
            self.assertEqual(rows[2]["result"]["input_tokens"], 31)
            cli.unlink()
            cached = self.execute([request("initialize", self.config(root, str(cli))),
                                   request("recognize", context), request("usage", {})])
            self.assertEqual(cached[1]["result"], result)
            self.assertEqual(cached[2]["result"]["calls"], 1)

    @unittest.skipIf(sys.platform == "win32", "进程组检查使用POSIX信号")
    def test_stop_terminates_active_model_process(self):
        with tempfile.TemporaryDirectory() as root:
            pid_path, cli = Path(root) / "pid", Path(root) / "fake-codex"
            cli.write_text(f'#!{sys.executable}\nimport os,time\nfrom pathlib import Path\nPath({str(pid_path)!r}).write_text(str(os.getpid()))\ntime.sleep(30)\n')
            cli.chmod(0o700)
            executable = os.environ.get("PARSER_EXECUTABLE")
            args = [executable] if executable else [sys.executable, str(ROOT / "main.py")]
            process = subprocess.Popen(args + ["--codex-stdio"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            try:
                process.stdin.write(json.dumps(request("initialize", self.config(root, str(cli)))) + "\n"); process.stdin.flush()
                self.assertTrue(json.loads(process.stdout.readline())["ok"])
                process.stdin.write(json.dumps(request("recognize", dict(filename="Movie.mkv"))) + "\n"); process.stdin.flush()
                for _ in range(100):
                    if pid_path.exists(): break
                    time.sleep(0.02)
                self.assertTrue(pid_path.exists())
                process.terminate(); process.wait(timeout=3)
                for _ in range(100):
                    try: os.kill(int(pid_path.read_text()), 0)
                    except ProcessLookupError: break
                    time.sleep(0.02)
                else: self.fail("停止解析器后模型进程仍在运行")
            finally:
                if process.poll() is None: process.kill(); process.wait()
                for stream in (process.stdin, process.stdout, process.stderr): stream.close()


if __name__ == "__main__":
    unittest.main()
