import type { QueueRecognitionResponse } from '../types/index'

export function summarizeRecognitionResults(
  updated: QueueRecognitionResponse[], skipped: { taskId: number; reason: string }[],
) {
  return {
    automatic: updated.filter(({ task }) => task.status === 'PROCESSING' || task.status === 'DONE').length,
    review: updated.filter(({ task }) => task.status === 'AWAITING_CONFIRMATION').length,
    failed: skipped.length + updated.filter(({ task }) => task.status === 'FAILED').length,
  }
}
