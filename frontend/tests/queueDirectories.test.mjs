import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadUtility } from './loadUtility.mjs';
const { groupQueueDirectories, commonDirectoryOptions, directoryEpisodeIssue, resolveEpisodeSeason } = await loadUtility('queueDirectories');
const task = (id, path, ruleId = 1, assetType = 'VIDEO_FILE') => ({ id, sourcePath: path, ruleId, assetType });
test('同目录跨越原文件分页边界仍组成一组，不跨规则、相邻目录或原盘合并', () => {
    const series = Array.from({ length: 25 }, (_, n) => task(n, `/剧集/某剧/${n + 1}.mkv`));
    const groups = groupQueueDirectories([...series, task(30, '/剧集/某剧/26.mkv', 2),
        task(31, '/剧集/某剧续集/01.mkv'), task(32, '/剧集/某剧/disc', 1, 'BLURAY_DIRECTORY')]);
    assert.deepEqual(groups.map(group => group.tasks.length), [25, 1, 1, 1]);
});
test('批量候选必须同时存在于组内每一个文件，不把第一集独有候选套给其他集', () => {
    const tasks = [task(1, '/剧/01.mkv'), task(2, '/剧/02.mkv')];
    const options = { 1: [{ key: 'TV_SHOW:123' }, { key: 'TV_SHOW:456' }], 2: [{ key: 'TV_SHOW:123' }] };
    assert.deepEqual(commonDirectoryOptions(tasks, id => options[id]), [{ key: 'TV_SHOW:123' }]);
    assert.deepEqual(commonDirectoryOptions(tasks, id => id === 1 ? options[1] : []), []);
});
test('确认前阻止缺失、非法和重叠集号，支持特别篇及合并集', () => {
    const row = { taskId: 1, season: 0, episode: 1, episodeEnd: 2 };
    assert.equal(directoryEpisodeIssue([row], 'TV_SHOW'), null);
    assert.equal(directoryEpisodeIssue([{ ...row, season: null }], 'TV_SHOW'), 'missing');
    assert.equal(directoryEpisodeIssue([{ ...row, episodeEnd: 0 }], 'TV_SHOW'), 'range');
    assert.equal(directoryEpisodeIssue([row, { ...row, taskId: 2, episode: 2 }], 'TV_SHOW'), 'duplicate');
    assert.equal(directoryEpisodeIssue([{ ...row, season: null }], 'MOVIE'), null);
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
