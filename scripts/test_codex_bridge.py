"""验证解析边界、认证及缓存，不调用真实模型。"""
import importlib.util
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
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

    def identified(self):
        return dict(self.result(), status='identified', title='正式剧名', year=2026,
                    type='episode', confidence=0.96, episode=1,
                    reason='作品官网 https://example.com/anime')

    def context(self, episode=1):
        return {'filename': f'{episode:02}.mkv', 'parents': ['一部剧'],
                'siblings': ['01.mkv', '02.mkv', '03.mkv']}

    def test_unknown_expires_and_manual_retry_bypasses_it(self):
        calls = []
        def runner(payload):
            calls.append(payload)
            return self.result()
        with tempfile.TemporaryDirectory() as tmp:
            recognizer = bridge.Recognizer({'runtime_dir': tmp}, runner)
            context = self.context()
            recognizer.recognize(context)
            recognizer.recognize(dict(context, retry_unknown=True))
            self.assertEqual(len(calls), 2)
            cache = recognizer.cache_path('file', bridge.normalize_context(context))
            os.utime(cache, (time.time() - 301, time.time() - 301))
            recognizer.recognize(context)
            self.assertEqual(len(calls), 3)

    def test_policy_change_invalidates_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            recognizer = bridge.Recognizer({'runtime_dir': tmp, 'model': 'first'}, lambda _: self.result())
            first = recognizer.cache_path('file', self.context())
            recognizer.config['model'] = 'second'
            self.assertNotEqual(first, recognizer.cache_path('file', self.context()))
            second = recognizer.cache_path('file', self.context())
            previous = bridge.PROMPT
            try:
                bridge.PROMPT += '新的识别策略'
                self.assertNotEqual(second, recognizer.cache_path('file', self.context()))
            finally:
                bridge.PROMPT = previous

    def test_series_reuses_identity_but_preserves_each_episode(self):
        calls = []
        def runner(payload):
            calls.append(payload)
            return self.identified()
        with tempfile.TemporaryDirectory() as tmp:
            recognizer = bridge.Recognizer({'runtime_dir': tmp}, runner)
            with ThreadPoolExecutor(max_workers=3) as pool:
                results = list(pool.map(recognizer.recognize, [self.context(n) for n in (1, 2, 3)]))
            self.assertEqual([r['episode'] for r in results], [1, 2, 3])
            self.assertTrue(all(r['season'] is None for r in results))
            self.assertEqual(len(calls), 1)

    def test_mixed_folders_and_unknown_or_weak_identity_are_not_shared(self):
        with tempfile.TemporaryDirectory() as tmp:
            recognizer = bridge.Recognizer({'runtime_dir': tmp}, lambda _: self.result())
            for context in [dict(self.context(), parents=[]),
                            dict(self.context(), siblings=['01.mkv', '另一个作品.mkv']),
                            dict(self.context(), siblings=['01.mkv', '01.mp4']),
                            dict(self.context(), parsed={'episode': 99})]:
                self.assertIsNone(recognizer.series_context(bridge.normalize_context(context)))
            for status in ('unknown', 'weak'):
                calls = []
                def runner(payload):
                    calls.append(payload)
                    return self.result() if status == 'unknown' else dict(self.identified(), confidence=0.8)
                recognizer.runner = runner
                recognizer.recognize(dict(self.context(1), parents=[status]))
                recognizer.recognize(dict(self.context(2), parents=[status]))
                self.assertEqual(len(calls), 2)

    def test_cached_identity_does_not_cross_parent_directories(self):
        calls = []
        def runner(payload):
            calls.append(payload)
            return self.identified()
        with tempfile.TemporaryDirectory() as tmp:
            recognizer = bridge.Recognizer({'runtime_dir': tmp}, runner)
            recognizer.recognize(self.context())
            recognizer.recognize(dict(self.context(), parents=['另一部剧']))
            self.assertEqual(len(calls), 2)

    def test_series_cache_survives_a_completed_episode_leaving_folder(self):
        calls = []
        def runner(payload):
            calls.append(payload)
            return self.identified()
        with tempfile.TemporaryDirectory() as tmp:
            recognizer = bridge.Recognizer({'runtime_dir': tmp}, runner)
            recognizer.recognize(self.context(1))
            second = dict(self.context(2), siblings=['02.mkv', '03.mkv'])
            self.assertEqual(recognizer.recognize(second)['episode'], 2)
            self.assertEqual(len(calls), 1)
            # 显式年份冲突时必须重新查证，不能沿用另一年份的作品。
            recognizer.recognize(dict(second, parsed={'year': 2025}))
            self.assertEqual(len(calls), 2)

    def directory_context(self):
        return dict(self.context(), files=['01.mkv', '02.mkv'])

    def directory_result(self):
        return dict(self.identified(), episode=None, files=[
            {'filename': '01.mkv', 'season': None, 'episode': 1, 'episode_end': None},
            {'filename': '02.mkv', 'season': 2, 'episode': 2, 'episode_end': 3}])

    def test_directory_uses_one_model_call_and_caches_complete_result(self):
        calls = []
        def runner(payload):
            calls.append(json.loads(payload))
            return self.directory_result()
        with tempfile.TemporaryDirectory() as tmp:
            recognizer = bridge.Recognizer({'runtime_dir': tmp}, directory_runner=runner)
            first = recognizer.recognize_directory(self.directory_context())
            self.assertIsNone(first['files'][0]['season'])
            self.assertEqual(first['files'][1]['episode_end'], 3)
            self.assertEqual(recognizer.recognize_directory(self.directory_context()), first)
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0]['siblings'], self.context()['siblings'])

    def test_directory_rejects_incomplete_duplicate_and_invented_files(self):
        context = bridge.normalize_directory_context(self.directory_context())
        first, second = self.directory_result()['files']
        for files in [[first], [first, first], [first, dict(second, filename='other.mkv')],
                      [first, dict(second, episode_end=1)], [first, dict(second, season=True)]]:
            with self.assertRaises(ValueError):
                bridge.validate_directory_result(dict(self.directory_result(), files=files), context)
        with self.assertRaises(ValueError):
            bridge.normalize_directory_context(dict(self.directory_context(), files=['missing.mkv']))

    def test_directory_refuses_shared_movie_and_preserves_unknown(self):
        context = bridge.normalize_directory_context(self.directory_context())
        with self.assertRaises(ValueError):
            bridge.validate_directory_result(dict(self.directory_result(), type='movie'), context)
        unknown = dict(self.result(), files=[])
        self.assertEqual(bridge.validate_directory_result(unknown, context), unknown)
        with self.assertRaises(ValueError):
            bridge.validate_directory_result(dict(unknown, files=self.directory_result()['files']), context)

    def test_directory_http_dispatch(self):
        class DirectoryRecognizer:
            def recognize_directory(inner, value):
                self.assertEqual(value, self.directory_context())
                return self.directory_result()
        server = ThreadingHTTPServer(('127.0.0.1', 0), bridge.make_handler(
            {'token': 'test-token'}, DirectoryRecognizer()))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            req = urllib.request.Request(f'http://127.0.0.1:{server.server_port}/recognize-directory',
                data=json.dumps(self.directory_context()).encode(),
                headers={'X-Media-Marshal-Token': 'test-token'})
            with urllib.request.urlopen(req) as response:
                self.assertEqual(json.load(response), self.directory_result())
        finally:
            server.shutdown()
            server.server_close()
            thread.join()

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
