import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadUtility } from './loadUtility.mjs';
const { groupQueueDirectories, commonDirectoryOptions, summarizeDirectoryCandidates, directoryConfirmationIssue, directoryEpisodeIssue, directoryEpisodeIssues, resolveEpisodeSeason } = await loadUtility('queueDirectories');
const task = (id, path, ruleId = 1, assetType = 'VIDEO_FILE') => ({ id, sourcePath: path, ruleId, assetType });
test('同目录跨越原文件分页边界仍组成一组，不跨规则、相邻目录或原盘合并', () => {
    const series = Array.from({ length: 25 }, (_, n) => task(n, `/剧集/某剧/${n + 1}.mkv`));
    const groups = groupQueueDirectories([...series, task(30, '/剧集/某剧/26.mkv', 2),
        task(31, '/剧集/某剧续集/01.mkv'), task(32, '/剧集/某剧/disc', 1, 'BLURAY_DIRECTORY')]);
    assert.deepEqual(groups.map(group => group.tasks.length), [25, 1, 1, 1]);
});
test('共同候选交集与单文件候选分开计算，不自动宣称每个文件均已识别', () => {
    const tasks = [task(1, '/剧/01.mkv'), task(2, '/剧/02.mkv')];
    const options = { 1: [{ key: 'TV_SHOW:123' }, { key: 'TV_SHOW:456' }], 2: [{ key: 'TV_SHOW:123' }] };
    assert.deepEqual(commonDirectoryOptions(tasks, id => options[id]), [{ key: 'TV_SHOW:123' }]);
    assert.deepEqual(commonDirectoryOptions(tasks, id => id === 1 ? options[1] : []), []);
});
test('19 个文件中部分已识别时显示作品及覆盖数，不把缺候选的目录显示为全部未识别', () => {
    const tasks = Array.from({ length: 19 }, (_, id) => task(id, `/小城日常/S1/${id}.mp4`));
    const identified = { key: 'TV_SHOW:272118', title: '小城日常', confidence: 0.87 };
    const options = id => id >= 13 ? [identified, identified] : id === 0 ? [] : [{ key: `TV_SHOW:${id}`, confidence: 0.4 }];
    const summary = summarizeDirectoryCandidates(tasks, options);
    assert.equal(summary.option.title, '小城日常');
    assert.equal(summary.supportedFiles, 6);
    assert.equal(summary.totalFiles, 19);
    assert.deepEqual(summary.sharedOptions, []);
});
test('目录共同候选优先，存在不同候选时全部交给用户选择，全空不推断作品', () => {
    const tasks = [task(1, '/剧/01.mp4'), task(2, '/剧/02.mp4')];
    const a = { key: 'TV_SHOW:1', confidence: 0.9 };
    const b = { key: 'TV_SHOW:2', confidence: 0.95 };
    const shared = summarizeDirectoryCandidates(tasks, () => [a, b]);
    assert.equal(shared.option.key, a.key);
    assert.equal(shared.supportedFiles, 2);
    assert.deepEqual(shared.sharedOptions, [a, b]);
    const conflict = summarizeDirectoryCandidates(tasks, id => id === 1 ? [a] : [b]);
    assert.equal(conflict.supportedFiles, 1);
    assert.deepEqual(conflict.sharedOptions, []);
    assert.deepEqual(conflict.reviewOptions, [b, a]);
    const empty = summarizeDirectoryCandidates(tasks, () => []);
    assert.equal(empty.option, undefined);
    assert.equal(empty.supportedFiles, 0);
});
test('确认前阻止缺失、非法和重叠集号，支持特别篇及合并集', () => {
    const row = { taskId: 1, season: 0, episode: 1, episodeEnd: 2 };
    assert.equal(directoryEpisodeIssue([row], 'TV_SHOW'), null);
    assert.equal(directoryEpisodeIssue([{ ...row, season: null }], 'TV_SHOW'), 'missing');
    assert.equal(directoryEpisodeIssue([{ ...row, episodeEnd: 0 }], 'TV_SHOW'), 'range');
    assert.equal(directoryEpisodeIssue([row, { ...row, taskId: 2, episode: 2 }], 'TV_SHOW'), 'duplicate');
    assert.equal(directoryEpisodeIssue([{ ...row, season: null }], 'MOVIE'), null);
});

test('重复集号返回双方文件，修正或排除任一文件后解除拦截', () => {
    const rows = [
        { taskId: 1, season: 1, episode: 8 },
        { taskId: 2, season: 1, episode: 8 },
        { taskId: 3, season: 1, episode: 9 },
    ];
    assert.deepEqual(directoryEpisodeIssues(rows, 'TV_SHOW'), [
        { kind: 'duplicate', taskIds: [1, 2], season: 1, episode: 8, episodeEnd: 8 },
    ]);
    assert.deepEqual(directoryEpisodeIssues(rows.slice(1), 'TV_SHOW'), []);
    assert.deepEqual(directoryEpisodeIssues(rows.map(row => row.taskId === 2 ? { ...row, episode: 10 } : row), 'TV_SHOW'), []);
    assert.deepEqual(directoryEpisodeIssues(rows, 'MOVIE'), []);
});

test('合并集展示实际重叠范围，收集所有冲突且不同季互不冲突', () => {
    const rows = [
        { taskId: 1, season: 0, episode: 1, episodeEnd: 4 },
        { taskId: 2, season: 0, episode: 3, episodeEnd: 6 },
        { taskId: 3, season: 0, episode: 4 },
        { taskId: 4, season: 1, episode: 3, episodeEnd: 6 },
    ];
    assert.deepEqual(directoryEpisodeIssues(rows, 'TV_SHOW'), [
        { kind: 'duplicate', taskIds: [1, 2], season: 0, episode: 3, episodeEnd: 4 },
        { kind: 'duplicate', taskIds: [1, 3], season: 0, episode: 4, episodeEnd: 4 },
        { kind: 'duplicate', taskIds: [2, 3], season: 0, episode: 4, episodeEnd: 4 },
    ]);
});

test('缺失与非法输入定位到具体文件，并同时保留其他文件的冲突', () => {
    const rows = [
        { taskId: 1, season: null, episode: 1 },
        { taskId: 2, season: 1, episode: 2, episodeEnd: 1 },
        { taskId: 3, season: 1, episode: 3 },
        { taskId: 4, season: 1, episode: 3 },
    ];
    assert.deepEqual(directoryEpisodeIssues(rows, 'TV_SHOW'), [
        { kind: 'missing', taskIds: [1] },
        { kind: 'range', taskIds: [2] },
        { kind: 'duplicate', taskIds: [3, 4], season: 1, episode: 3, episodeEnd: 3 },
    ]);
});

test('13 个文件仅一个有候选时允许打开整组确认，不要求逐文件重复识别', () => {
    const tasks = Array.from({ length: 13 }, (_, id) => task(id, `/咒术回战/S03/${id}.mp4`));
    const options = id => id === 2 ? [{ key: 'TV_SHOW:95479' }] : [];
    const summary = summarizeDirectoryCandidates(tasks, options);
    assert.equal(summary.missingFiles, 12);
    assert.equal(summary.supportedFiles, 1);
    assert.equal(directoryConfirmationIssue(summary, { loading: false, recognizing: false, submitting: false }), null);
    assert.deepEqual(summary.reviewOptions, [{ key: 'TV_SHOW:95479' }]);
});

test('加载和更新期间仍等待，候选不一致时允许用户选择统一身份，仅全无候选时阻止进入', () => {
    const tasks = [task(1, '/剧/01.mp4'), task(2, '/剧/02.mp4')];
    const state = { loading: false, recognizing: false, submitting: false };
    const missing = summarizeDirectoryCandidates(tasks, () => []);
    assert.equal(directoryConfirmationIssue(missing, { ...state, loading: true }), 'loading');
    assert.equal(directoryConfirmationIssue(missing, { ...state, recognizing: true }), 'recognizing');
    assert.equal(directoryConfirmationIssue(missing, { ...state, submitting: true }), 'submitting');
    const conflict = summarizeDirectoryCandidates(tasks, id => [{ key: `TV_SHOW:${id}` }]);
    assert.equal(conflict.missingFiles, 0);
    assert.equal(directoryConfirmationIssue(conflict, state), null);
    assert.equal(conflict.reviewOptions.length, 2);
    assert.equal(directoryConfirmationIssue(missing, state), 'noCandidates');
    const ready = summarizeDirectoryCandidates(tasks, () => [{ key: 'TV_SHOW:1' }]);
    assert.equal(directoryConfirmationIssue(ready, state), null);
});

test('未标季号默认第一季，明确季号、目录和特别篇优先保留', () => {
  const season = (sourcePath, parsedSeason = null) => resolveEpisodeSeason({ sourcePath, parsedSeason });
  assert.equal(season('/剧/尼古猫猫/03.mkv'), 1);
  assert.equal(season('/剧/某剧/03.mkv', 2), 2);
  assert.equal(season('/剧/S02/03.mkv'), 2);
  assert.equal(season('/剧/Season 03/03.mkv'), 3);
  assert.equal(season('/剧/某剧S02E03.mkv'), 2);
  assert.equal(season('/剧/第二季/03.mkv'), 2);
  assert.equal(season('/剧/第十二季/03.mkv'), 12);
  assert.equal(season('/剧/特别篇/03.mkv'), 0);
  assert.equal(season('/剧/Specials/03.mkv'), 0);
  assert.equal(season('/剧/某剧/03.mkv', 0), 0);
  assert.equal(season('/剧/S02/某剧.S03E01.mkv'), 3);
  assert.equal(season('D:\\剧集\\Season 02\\03.mkv'), 2);
});
