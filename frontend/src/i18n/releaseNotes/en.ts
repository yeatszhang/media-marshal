export default {
  v0_2_13_1: {
    items: {
      organizationFailures: 'Batch organization shows live per-file outcomes and failure reasons, and supports larger TMDB season responses.',
      tmdbCache: 'Reuse cached titles and season episodes across tasks and restarts to reduce repeated requests.',
      automaticRecognition: 'Reliable recognition results now organize automatically after title, episode and target-path validation. Only duplicates, low confidence and conflicts require review, with specific reasons shown.',
      floatingBackToTop: 'Dashboard and Review Queue now include a bottom-right floating action group for quickly returning to the top.',
    },
  },
  v0_2_13: {
    items: {
      completedTvBatchCorrection: 'Organized TV episodes can reuse one correct TMDB selection across the same season or entire series.',
      batchCorrectionProgress: 'Batch correction now shows persisted progress, per-episode results, recent job recovery, and failed-item retry.',
    },
  },
  v0_2_12: {
    items: {
      docsSite: 'Documentation pages now collect the user guide, deployment notes, and FAQ in one place.',
      batchRecognitionDialogScroll: 'The batch edit dialog stays centered at a fixed height, with large previews scrolling inside the panel.',
      queueFileNameSorting: 'Review Queue tasks are sorted by filename, making episodes easier to batch select together.',
    },
  },
}
