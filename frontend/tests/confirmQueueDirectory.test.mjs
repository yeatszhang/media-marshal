import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadUtility } from './loadUtility.mjs';
const { submitDirectoryConfirmation } = await loadUtility('confirmQueueDirectory');
const messages = { stateChanged: '任务已变化', saveFailed: '保存失败', confirmFailed: '提交失败' };
const option = { tmdbId: 123, mediaType: 'TV_SHOW', title: '某剧', originalTitle: null, year: 2026 };
const task = (id) => ({ id, status: 'AWAITING_CONFIRMATION', mediaType: 'TV_SHOW', parsedSeason: null,
    parsedEpisode: id, parsedEpisodeEnd: null });
test('整目录的每集先保存统一季号，再用一次批量确认提交全部任务及同一作品', async () => {
    const saved = new Map();
    const confirmCalls = [];
    const rows = Array.from({ length: 25 }, (_, n) => ({ taskId: n + 1, season: 1, episode: n + 1, episodeEnd: null }));
    const result = await submitDirectoryConfirmation(rows, option, {
        findTask: task,
        save: async (id, request) => { saved.set(id, request); },
        confirm: async (items) => {
            assert.equal(saved.size, 25);
            confirmCalls.push(items);
            return items.map(item => ({ taskId: item.taskId, success: true, message: null }));
        },
    }, messages);
    assert.equal(confirmCalls.length, 1);
    assert.equal(confirmCalls[0].length, 25);
    assert.ok(confirmCalls[0].every(item => item.tmdbId === 123 && item.mediaType === 'TV_SHOW'));
    assert.deepEqual([...saved.values()].map(request => request.parsedEpisode), rows.map(row => row.episode));
    assert.ok([...saved.values()].every(request => request.parsedSeason === 1));
    assert.equal(result.filter(result => result.success).length, 25);
});
test('坐标保存失败或状态变化的文件不提交，其余文件保留服务端逐项结果', async () => {
    const rows = [1, 2, 3, 4].map(taskId => ({ taskId, season: 1, episode: taskId, episodeEnd: null }));
    const result = await submitDirectoryConfirmation(rows, option, {
        findTask: id => id === 2 ? undefined : task(id),
        save: async (id) => { if (id === 1)
            throw new Error('坐标保存失败'); },
        confirm: async (items) => {
            assert.deepEqual(items.map(item => item.taskId), [3, 4]);
            return [{ taskId: 3, success: true, message: null }, { taskId: 4, success: false, message: '源文件不存在' }];
        },
    }, messages);
    assert.deepEqual(result.map(result => [result.taskId, result.success]), [[1, false], [2, false], [3, true], [4, false]]);
    assert.equal(result[3].message, '源文件不存在');
});
test('坐标未变化时不重复保存，不将没有服务端回执的文件显示为成功', async () => {
    const result = await submitDirectoryConfirmation([{ taskId: 1, season: 1, episode: 1, episodeEnd: null }], option, {
        findTask: id => ({ ...task(id), parsedSeason: 1 }),
        save: async () => { assert.fail('不应保存未修改的坐标'); },
        confirm: async () => [],
    }, messages);
    assert.deepEqual(result, [{ taskId: 1, success: false, message: '提交失败' }]);
});
