import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loadUtility } from './loadUtility.mjs'
const { summarizeRecognitionResults } = await loadUtility('queueRecognition')

test('全部校验通过时无需打开人工确认面板', () => {
  const responses = ['DONE', 'PROCESSING'].map(status => ({ task: { status } }))
  assert.deepEqual(summarizeRecognitionResults(responses, []), { automatic: 2, review: 0, failed: 0 })
})

test('自动整理、保留复核和逐项失败分别统计，部分失败不显示全成功', () => {
  const responses = ['PROCESSING', 'AWAITING_CONFIRMATION', 'FAILED'].map(status => ({ task: { status } }))
  assert.deepEqual(summarizeRecognitionResults(responses, [{ taskId: 4, reason: '源文件已不存在' }]),
    { automatic: 1, review: 1, failed: 2 })
})
