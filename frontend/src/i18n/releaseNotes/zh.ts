export default {
  v0_2_12: {
    items: {
      docsSite: '新增文档站内容，用户手册、部署指南和常见问题更方便集中查看。',
      batchRecognitionDialogScroll: '批量编辑面板保持居中和固定高度，选择大量任务时预览区会在面板内滚动。',
      queueFileNameSorting: '待确认任务按文件名升序排列，同一剧集更容易集中批量选择。',
    },
  },
  v0_2_11: {
    items: {
      queueBatchRecognition: '待确认剧集可批量修正识别信息，并按文件顺序生成集号。',
      batchRecognitionRematchWait: '批量重新匹配会稳定等待较长的 TMDB 返回，减少前端提前超时。',
    },
  },
  v0_2_10: {
    items: {
      completedTaskCorrection: '已完成任务支持修正匹配，并同步移动或重命名媒体库文件。',
      sampleScanPruning: '默认忽略 Sample 目录，减少无效识别和 TMDB 请求。',
    },
  },
}
