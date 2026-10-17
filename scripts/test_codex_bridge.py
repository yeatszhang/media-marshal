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
from unittest.mock import Mock, patch

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

    def test_cli_uses_official_chatgpt_login_and_ignores_third_party_config_and_secrets(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = {'runtime_dir': tmp, 'codex_path': '/local/codex', 'model': 'gpt-6-luna',
                      'provider': {'env_file': '/must-not-read.env', 'env_key': 'THIRD_PARTY_KEY',
                                   'base_url': 'https://third-party.invalid/v1'}}
            recognizer = bridge.Recognizer(config)
            def spawn(command, **kwargs):
                self.assertIn('--ignore-user-config', command)
                self.assertIn('model_provider="openai"', command)
                self.assertIn('forced_login_method="chatgpt"', command)
                self.assertEqual(command[command.index('--sandbox') + 1], 'read-only')
                self.assertIn('features.shell_tool=false', command)
                self.assertIn('--json', command)
                self.assertIn('model_providers.openai.request_max_retries=0', command)
                self.assertIn('model_providers.openai.stream_max_retries=0', command)
                self.assertNotIn('third-party', ' '.join(command))
                self.assertEqual(kwargs['env'], {'HOME': tmp, 'PATH': '/usr/bin', 'CODEX_HOME': tmp + '/auth'})
                self.assertTrue(kwargs['start_new_session'])
                self.assertEqual(json.loads(Path(command[command.index('--output-schema') + 1]).read_text()), bridge.DIRECTORY_SCHEMA)
                output = Path(command[command.index('--output-last-message') + 1])
                process = Mock(returncode=0)
                def communicate(payload, timeout):
                    self.assertEqual(payload, bridge.DIRECTORY_PROMPT + '目录数据')
                    self.assertEqual(timeout, 150)
                    output.write_text(json.dumps(self.directory_result()))
                    return '', ''
                process.communicate.side_effect = communicate
                return process
            environment = {'HOME': tmp, 'PATH': '/usr/bin', 'CODEX_HOME': tmp + '/auth',
                           'OPENAI_API_KEY': 'private-key', 'CODEX_API_KEY': 'private-key',
                           'THIRD_PARTY_KEY': 'private-key', 'OPENAI_BASE_URL': 'https://third-party.invalid',
                           'CHATGPT_BASE_URL': 'https://third-party.invalid'}
            with patch.dict(os.environ, environment, clear=True), patch.object(bridge.subprocess, 'Popen', side_effect=spawn):
                self.assertEqual(recognizer.run_codex('目录数据', bridge.DIRECTORY_SCHEMA, bridge.DIRECTORY_PROMPT),
                                 self.directory_result())

    def test_cli_failure_never_exposes_process_output_and_cleans_request_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            recognizer = bridge.Recognizer({'runtime_dir': tmp, 'codex_path': '/local/codex'})
            process = Mock(returncode=1)
            process.communicate.return_value = ('private-output', 'private-key')
            with patch.object(bridge.subprocess, 'Popen', return_value=process):
                with self.assertRaises(RuntimeError) as failure:
                    recognizer.run_codex('目录数据')
                self.assertNotIn('private', str(failure.exception))
            self.assertEqual(list(Path(tmp).glob('request-*')), [])

    def test_daily_budget_is_atomic_persistent_and_resets_on_shanghai_day(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = {'runtime_dir': tmp, 'max_daily_calls': 3}
            recognizers = [bridge.Recognizer(config) for _ in range(8)]
            def reserve(recognizer):
                try:
                    recognizer.reserve_call()
                    return True
                except bridge.BudgetExceeded:
                    return False
            with ThreadPoolExecutor(max_workers=8) as pool:
                accepted = list(pool.map(reserve, recognizers))
            self.assertEqual(sum(accepted), 3)
            restarted = bridge.Recognizer(config)
            self.assertEqual(restarted.usage_today()['calls'], 3)
            with self.assertRaises(bridge.BudgetExceeded):
                restarted.reserve_call()
            with patch.object(restarted, 'usage_day', return_value='2099-01-02'):
                restarted.reserve_call()
                self.assertEqual(restarted.usage_today()['calls'], 1)
            self.assertEqual(restarted.usage_today()['calls'], 3)
            for limit in (0, -1, True, '3', 1001):
                with self.assertRaises(ValueError):
                    bridge.Recognizer(dict(config, max_daily_calls=limit))

    def test_failed_cli_calls_consume_budget_and_usage_records_only_token_counts(self):
        with tempfile.TemporaryDirectory() as tmp:
            recognizer = bridge.Recognizer({'runtime_dir': tmp, 'codex_path': '/local/codex', 'max_daily_calls': 2})
            process = Mock(returncode=1)
            events = '\n'.join([
                'untrusted private output', json.dumps({'type': 'turn.started'}),
                json.dumps({'type': 'turn.completed', 'usage': {'input_tokens': 120, 'cached_input_tokens': 80, 'output_tokens': 10}}),
                json.dumps({'type': 'turn.completed', 'usage': {'input_tokens': True}})])
            process.communicate.return_value = (events, 'private-key')
            with patch.object(bridge.subprocess, 'Popen', return_value=process) as spawn:
                for _ in range(2):
                    with self.assertRaises(RuntimeError):
                        recognizer.run_codex('目录数据')
                with self.assertRaises(bridge.BudgetExceeded):
                    recognizer.run_codex('目录数据')
                self.assertEqual(spawn.call_count, 2)
            recognizer.record_usage(recognizer.usage_day(), json.dumps({'type': 'turn.completed', 'usage': {}}))
            usage = recognizer.usage_today()
            self.assertEqual((usage['calls'], usage['reported_calls']), (2, 2))
            self.assertEqual((usage['input_tokens'], usage['cached_input_tokens'], usage['output_tokens']), (240, 160, 20))
            self.assertNotIn('private', json.dumps(usage))

    def test_usage_endpoint_requires_authentication(self):
        with tempfile.TemporaryDirectory() as tmp:
            recognizer = bridge.Recognizer({'runtime_dir': tmp})
            server = ThreadingHTTPServer(('127.0.0.1', 0), bridge.make_handler({'token': 'test-token'}, recognizer))
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                url = f'http://127.0.0.1:{server.server_port}/usage'
                with self.assertRaises(urllib.error.HTTPError) as error:
                    urllib.request.urlopen(url)
                self.assertEqual(error.exception.code, 401)
                error.exception.close()
                with urllib.request.urlopen(urllib.request.Request(url, headers={'X-Media-Marshal-Token': 'test-token'})) as response:
                    self.assertEqual(json.load(response), recognizer.usage_today())
                for _ in range(recognizer.daily_call_limit):
                    recognizer.reserve_call()
                request = urllib.request.Request(url.replace('/usage', '/recognize'),
                    data=json.dumps({'filename': '电影.mkv'}).encode(), headers={'X-Media-Marshal-Token': 'test-token'})
                with self.assertRaises(urllib.error.HTTPError) as exhausted:
                    urllib.request.urlopen(request)
                self.assertEqual(exhausted.exception.code, 429)
                self.assertIn('上限', exhausted.exception.read().decode())
                exhausted.exception.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

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

    def cluster_response(self, payload):
        context = json.loads(payload)
        return dict(self.identified(), confidence=0.87, season=None, episode=None)

    def test_cluster_features_keep_hash_duplicates_ranges_and_release_names(self):
        cases = {
            '01-8930371d37e8.mp4': (None, 1, None),
            '08-e05eb3940aad.mp4': (None, 8, None),
            '02-03.mkv': (None, 2, 3),
            'Show_A_S02E03-E04.1080p.mkv': (2, 3, 4),
            'Show.A.S02E03E04.mkv': (2, 3, 4),
            'Show.A.S02E03-1080p.mkv': (2, 3, None),
            '[BeanSub&FZSD][Jujutsu_Kaisen][48][GB][1080P][x264_AAC]-4439f0c824f5.mp4': (None, 48, None),
        }
        for name, expected in cases.items():
            with self.subTest(name=name):
                feature = bridge.episode_feature(name)
                self.assertEqual(tuple(feature[k] for k in ('season', 'episode', 'episode_end')), expected)
        for name in ('电影.2025.mkv', '01.mp4.qkdownloading', '00.mp4', '03-01.mkv', 'intro.txt'):
            self.assertIsNone(bridge.episode_feature(name), name)

    def test_nineteen_files_are_one_cluster_call_and_new_episodes_reuse_identity(self):
        names = [f'{n:02}.mp4' for n in range(1, 14)] + [
            f'{n:02}-8930371d37e8.mp4' for n in (1, 2, 3, 4, 5, 8)]
        calls = []
        def runner(payload):
            calls.append(json.loads(payload))
            return self.cluster_response(payload)
        context = dict(filename=names[0], parents=['S1', '小城日常'], siblings=names, cluster_scope='rule-1-city')
        with tempfile.TemporaryDirectory() as tmp:
            recognizer = bridge.Recognizer({'runtime_dir': tmp}, cluster_runner=runner)
            with ThreadPoolExecutor(max_workers=8) as pool:
                results = list(pool.map(recognizer.recognize_cluster, [dict(context, filename=n) for n in names]))
            self.assertEqual(len(calls), 1)
            self.assertEqual(calls[0]['file_count'], 19)
            self.assertEqual(calls[0]['distinct_episodes'], 13)
            self.assertEqual(len(calls[0]['samples']), 6)
            self.assertTrue(all('-8930371d37e8' not in name for name in calls[0]['samples']))
            self.assertNotIn('files', calls[0])
            self.assertNotIn('siblings', calls[0])
            original = bridge.normalize_directory_context(dict(context, files=names))
            self.assertLess(len(json.dumps(calls[0], ensure_ascii=False)), len(json.dumps(original, ensure_ascii=False)) / 2)
            self.assertTrue(all(r['clustered'] and r['title'] == '正式剧名' and r['season'] == 1 for r in results))
            self.assertEqual([r['episode'] for r in results], list(range(1, 14)) + [1, 2, 3, 4, 5, 8])
            # 旧集数已整理移走，仅有一集新增文件时仍复用已有身份。
            later = dict(context, filename='14.mp4', siblings=['14.mp4'])
            self.assertEqual(recognizer.recognize_cluster(later)['episode'], 14)
            self.assertEqual(recognizer.recognize_cluster(dict(later, parsed={'year': 2026}))['episode'], 14)
            # 同作品其他季独立回填季号，不复用第一季坐标。
            season2 = dict(later, filename='01.mp4', siblings=['01.mp4'], parents=['S02', '小城日常'])
            self.assertEqual(recognizer.recognize_cluster(season2)['season'], 2)
            self.assertEqual(len(calls), 1)
            restarted = bridge.Recognizer({'runtime_dir': tmp}, cluster_runner=lambda _: self.fail('重启后应复用身份'))
            self.assertEqual(restarted.recognize_cluster(later)['episode'], 14)

    def test_cluster_budget_exhaustion_does_not_poison_identity_cache(self):
        with tempfile.TemporaryDirectory() as tmp:
            recognizer = bridge.Recognizer({'runtime_dir': tmp, 'max_daily_calls': 1})
            recognizer.reserve_call()
            result = recognizer.recognize_cluster(self.context())
            self.assertTrue(result['clustered'])
            self.assertEqual(result['status'], 'unknown')
            self.assertIn('上限', result['reason'])
            context = bridge.normalize_context(self.context())
            cache = recognizer.cluster_cache_path(context, bridge.episode_cluster(context))
            self.assertFalse(cache.exists())
            recognizer.cluster_runner = lambda _: self.identified()
            self.assertEqual(recognizer.recognize_cluster(self.context())['status'], 'identified')

    def test_cluster_separates_named_shows_and_isolates_rules_and_years(self):
        calls = []
        def runner(payload):
            calls.append(json.loads(payload))
            return self.cluster_response(payload)
        names = ['A.Show.S01E01.mkv', 'A.Show.S01E02.mkv', 'B.Show.S01E01.mkv', 'B.Show.S01E02.mkv']
        context = dict(filename=names[0], parents=['合集'], siblings=names, cluster_scope='rule-1-folder')
        with tempfile.TemporaryDirectory() as tmp:
            recognizer = bridge.Recognizer({'runtime_dir': tmp}, cluster_runner=runner)
            recognizer.recognize_cluster(context)
            recognizer.recognize_cluster(dict(context, filename=names[2]))
            self.assertEqual(len(calls), 2)
            self.assertEqual(calls[0]['samples'], names[:2])
            self.assertEqual(calls[1]['samples'], names[2:])
            recognizer.recognize_cluster(dict(context, cluster_scope='rule-2-folder'))
            self.assertEqual(len(calls), 3)
            response = recognizer.recognize_cluster(dict(context, parsed={'year': 2025}))
            self.assertEqual(response['status'], 'unknown')
            self.assertEqual(len(calls), 4)

    def test_ambiguous_truncated_or_conflicting_context_never_triggers_cluster_model(self):
        with tempfile.TemporaryDirectory() as tmp:
            recognizer = bridge.Recognizer({'runtime_dir': tmp}, cluster_runner=lambda _: self.fail('不能合并'))
            contexts = [dict(self.context(), parents=['S01', '下载']),
                        dict(self.context(), parents=[]), dict(self.context(), siblings_truncated=True),
                        dict(self.context(), siblings=['01.mkv', '其他作品.mkv']),
                        dict(self.context(), parsed={'type': 'movie'}),
                        dict(self.context(), parsed={'episode': 99}),
                        dict(self.context(), siblings=['01.mkv']),
                        dict(self.context(), siblings=['01.mkv', '01.mp4']),
                        dict(self.context(), parents=['特别篇', '下载']),
                        dict(self.context(), filename='missing.mkv'),
                        dict(self.context(), parents=['S02', '一部剧'], parsed={'season': 3})]
            for context in contexts:
                with self.subTest(context=context):
                    self.assertFalse(recognizer.recognize_cluster(context)['clustered'])

    def test_cluster_coordinates_use_filename_and_nearest_season_instead_of_model(self):
        def runner(payload):
            result = self.cluster_response(payload)
            result.update(season=9, episode=99)
            return result
        cases = [('S02', 2), ('第三季', 3), ('第十二季', 12), ('第二十一季', 21),
                 ('第一百零二季', 102), ('特别篇', 0), ('Specials', 0)]
        with tempfile.TemporaryDirectory() as tmp:
            recognizer = bridge.Recognizer({'runtime_dir': tmp}, cluster_runner=runner)
            for parent, season in cases:
                with self.subTest(parent=parent):
                    context = dict(filename='02-03.mkv', parents=[parent, '一部剧'],
                                   siblings=['01.mkv', '02-03.mkv'], cluster_scope='one-series')
                    result = recognizer.recognize_cluster(context)
                    self.assertEqual((result['season'], result['episode'], result['episode_end']), (season, 2, 3))
            # 文件名中明确的季号优先于目录；原解析有冲突时不套用身份。
            named = dict(filename='Show.S03E02-E04.mkv', parents=['S02', '一部剧'],
                         siblings=['Show.S03E01.mkv', 'Show.S03E02-E04.mkv'])
            result = recognizer.recognize_cluster(named)
            self.assertEqual((result['season'], result['episode'], result['episode_end']), (3, 2, 4))
            self.assertFalse(recognizer.recognize_cluster(dict(named, parsed={'season': 2}))['clustered'])

    def test_cluster_rejects_weak_movie_and_incomplete_model_identity(self):
        for kind in ('weak', 'movie', 'incomplete', 'exception'):
            calls = []
            def runner(payload):
                calls.append(payload)
                if kind == 'exception':
                    raise TimeoutError('模型超时')
                result = self.cluster_response(payload)
                if kind == 'weak':
                    result['confidence'] = 0.59
                elif kind == 'movie':
                    result['type'] = 'movie'
                else:
                    result.pop('title')
                return result
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as tmp:
                recognizer = bridge.Recognizer({'runtime_dir': tmp}, cluster_runner=runner)
                for n in (1, 2):
                    result = recognizer.recognize_cluster(self.context(n))
                    self.assertTrue(result['clustered'])
                    self.assertEqual(result['status'], 'unknown')
                self.assertEqual(len(calls), 1)

    def test_cluster_success_expires_and_corrupt_cache_is_rebuilt(self):
        calls = []
        def runner(payload):
            calls.append(payload)
            return self.cluster_response(payload)
        with tempfile.TemporaryDirectory() as tmp:
            recognizer = bridge.Recognizer({'runtime_dir': tmp}, cluster_runner=runner)
            normalized = bridge.normalize_context(self.context())
            cache = recognizer.cluster_cache_path(normalized, bridge.episode_cluster(normalized))
            recognizer.recognize_cluster(self.context())
            os.utime(cache, (time.time() - 5 * 86400, time.time() - 5 * 86400))
            recognizer.recognize_cluster(self.context(2))
            self.assertEqual(len(calls), 1)
            os.utime(cache, (time.time() - (30 * 86400 + 1), time.time() - (30 * 86400 + 1)))
            self.assertEqual(recognizer.recognize_cluster(self.context(2))['episode'], 2)
            self.assertEqual(len(calls), 2)
            cache.write_text('{invalid')
            self.assertEqual(recognizer.recognize_cluster(self.context(3))['episode'], 3)
            self.assertEqual(len(calls), 3)

    def test_cluster_unknown_and_invalid_results_are_shared_briefly_not_retried_per_file(self):
        for invalid in (False, True):
            calls = []
            def runner(payload):
                calls.append(payload)
                return {'untrusted': 'invalid'} if invalid else self.result()
            with tempfile.TemporaryDirectory() as tmp:
                recognizer = bridge.Recognizer({'runtime_dir': tmp}, cluster_runner=runner)
                for n in (1, 2, 3):
                    result = recognizer.recognize_cluster(self.context(n))
                    self.assertTrue(result['clustered'])
                    self.assertEqual(result['status'], 'unknown')
                self.assertEqual(len(calls), 1)
                recognizer.recognize_cluster(dict(self.context(1), retry_unknown=True))
                self.assertEqual(len(calls), 2)
                normalized = bridge.normalize_context(self.context())
                cache = recognizer.cluster_cache_path(normalized, bridge.episode_cluster(normalized))
                os.utime(cache, (time.time()-301, time.time()-301))
                recognizer.recognize_cluster(self.context(2))
                self.assertEqual(len(calls), 2)
                os.utime(cache, (time.time()-3601, time.time()-3601))
                recognizer.recognize_cluster(self.context(2))
                self.assertEqual(len(calls), 3)

    def test_manual_directory_review_reuses_cluster_identity_without_another_model_call(self):
        calls = []
        def runner(payload):
            calls.append(payload)
            return self.cluster_response(payload)
        with tempfile.TemporaryDirectory() as tmp:
            recognizer = bridge.Recognizer({'runtime_dir': tmp}, cluster_runner=runner)
            context = dict(self.context(), parents=['S02', '一部剧'])
            recognizer.recognize_cluster(context)
            result = recognizer.recognize_directory(dict(context, files=context['siblings']))
            self.assertEqual(len(calls), 1)
            self.assertEqual([r['episode'] for r in result['files']], [1, 2, 3])
            self.assertTrue(all(r['season'] == 2 for r in result['files']))
            # 即使当天模型预算已用完，单文件重试和整目录确认仍可复用身份。
            for _ in range(recognizer.daily_call_limit):
                recognizer.reserve_call()
            recognizer.runner = lambda _: self.fail('缓存命中不应启动新模型')
            single = recognizer.recognize(dict(context, filename='03.mkv'))
            self.assertEqual((single['title'], single['episode'], single['season']), ('正式剧名', 3, 2))
            self.assertEqual(len(calls), 1)

    def test_cluster_http_dispatch_and_authentication(self):
        class ClusterRecognizer:
            def recognize_cluster(inner, value):
                self.assertEqual(value, self.context())
                return dict(self.identified(), clustered=True)
        server = ThreadingHTTPServer(('127.0.0.1', 0), bridge.make_handler({'token': 'test-token'}, ClusterRecognizer()))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            for token in ('', 'test-token'):
                request = urllib.request.Request(f'http://127.0.0.1:{server.server_port}/recognize-cluster',
                    data=json.dumps(self.context()).encode(), headers={'X-Media-Marshal-Token': token})
                if not token:
                    with self.assertRaises(urllib.error.HTTPError) as error:
                        urllib.request.urlopen(request)
                    self.assertEqual(error.exception.code, 401)
                    error.exception.close()
                else:
                    with urllib.request.urlopen(request) as response:
                        self.assertTrue(json.load(response)['clustered'])
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
