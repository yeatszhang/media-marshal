// 迁自旧前端，保留原输入、用例名与断言。
import { it as test } from 'vitest'
import assert from 'node:assert/strict'
import {  summarizeOrganizationTasks } from "./recognition-result-rules";

test('后台退回待确认和失败均计入未完成，已提交不计为完成', () => {
  const tasks = ['PROCESSING', 'PENDING', 'DONE', 'AWAITING_CONFIRMATION', 'FAILED', 'SKIPPED']
    .map((status, id) => ({ id, status }))
  assert.deepEqual(summarizeOrganizationTasks(tasks), { pending: 2, done: 1, blocked: 3 })
  tasks[0] = { id: 0, status: 'AWAITING_CONFIRMATION', errorMessage: 'TMDB 连接失败' }
  assert.deepEqual(summarizeOrganizationTasks(tasks), { pending: 1, done: 1, blocked: 4 })
})
