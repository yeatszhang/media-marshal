import type { ReleaseNote } from '@/types'

export const releaseNotes: ReleaseNote[] = [
  {
    version: 'v0.2.12',
    date: '2026-07-29',
    items: [
      { type: 'feature', key: 'releaseNotes.v0_2_12.items.docsSite' },
      { type: 'fix', key: 'releaseNotes.v0_2_12.items.batchRecognitionDialogScroll' },
    ],
  },
  {
    version: 'v0.2.11',
    date: '2026-07-25',
    items: [
      { type: 'feature', key: 'releaseNotes.v0_2_11.items.queueBatchRecognition' },
      { type: 'optimization', key: 'releaseNotes.v0_2_11.items.batchRecognitionRematchWait' },
    ],
  },
  {
    version: 'v0.2.10',
    date: '2026-06-29',
    items: [
      { type: 'feature', key: 'releaseNotes.v0_2_10.items.completedTaskCorrection' },
      { type: 'optimization', key: 'releaseNotes.v0_2_10.items.sampleScanPruning' },
    ],
  },
]
