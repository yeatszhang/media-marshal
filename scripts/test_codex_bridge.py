"""验证解析边界、认证及缓存，不调用真实模型。"""
import importlib.util
import json
from pathlib import Path
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer

spec = importlib.util.spec_from_file_location('bridge', Path(__file__).with_name('codex-bridge.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTest(unittest.TestCase):
    def result(self):
        return {'status': 'unknown', 'title': None, 'year': None, 'type': None,
                'season': None, 'episode': None, 'confidence': 0, 'reason': '缺少作品名'}

    def test_rejects_invalid_numeric_fields(self):
        for key, value in [('confidence', float('nan')), ('episode', True), ('year', 1)]:
            result = self.result()
            result[key] = value
            with self.assertRaises(ValueError):
                bridge.validate_result(result)

    def test_rejects_unbounded_context(self):
        for context in [{'filename': 'x.mkv', 'parents': ['x'] * 5},
                        {'filename': 'x.mkv', 'siblings': ['x'] * 81}]:
            with self.assertRaises(ValueError):
                bridge.normalize_context(context)

    def test_cache_avoids_repeated_calls_including_unknown(self):
        calls = []
        def runner(payload):
            calls.append(payload)
            return self.result()
        with tempfile.TemporaryDirectory() as tmp:
            recognizer = bridge.Recognizer({'runtime_dir': tmp}, runner)
            context = {'filename': '01.mkv', 'parents': ['无意义简称']}
            self.assertEqual(recognizer.recognize(context), self.result())
            self.assertEqual(recognizer.recognize(context), self.result())
            self.assertEqual(len(calls), 1)

    def test_http_requires_token_and_never_exposes_cli_error(self):
        class FailingRecognizer:
            def recognize(self, value):
                raise RuntimeError('不应返回的内部数据')
        config = {'token': 'test-token'}
        server = ThreadingHTTPServer(('127.0.0.1', 0), bridge.make_handler(config, FailingRecognizer()))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for token, expected in [('', 401), ('test-token', 503)]:
                req = urllib.request.Request(f'http://127.0.0.1:{server.server_port}/recognize',
                        data=b'{}', headers={'X-Media-Marshal-Token': token})
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(req)
                self.assertEqual(error.exception.code, expected)
                self.assertNotIn('内部数据', error.exception.read().decode())
                error.exception.close()
        finally:
            server.shutdown()
            server.server_close()
            thread.join()


if __name__ == '__main__':
    unittest.main()
