import type { ReleaseNote } from '@/types'

export const releaseNotes: ReleaseNote[] = [
  {
    version: 'v0.2.13.1',
    date: '2026-08-29',
    items: [
      { type: 'feature', key: 'releaseNotes.v0_2_13_1.items.floatingBackToTop' },
    ],
  },
  {
    version: 'v0.2.13',
    date: '2026-08-29',
    items: [
      { type: 'feature', key: 'releaseNotes.v0_2_13.items.completedTvBatchCorrection' },
      { type: 'optimization', key: 'releaseNotes.v0_2_13.items.batchCorrectionProgress' },
    ],
  },
  {
    version: 'v0.2.12',
    date: '2026-07-29',
    items: [
      { type: 'feature', key: 'releaseNotes.v0_2_12.items.docsSite' },
      { type: 'fix', key: 'releaseNotes.v0_2_12.items.batchRecognitionDialogScroll' },
      { type: 'optimization', key: 'releaseNotes.v0_2_12.items.queueFileNameSorting' },
    ],
  },
]
