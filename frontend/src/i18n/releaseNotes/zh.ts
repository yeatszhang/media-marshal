export default {
  v0_2_13_1: {
    items: {
      organizationFailures: '批量整理显示持续更新的逐文件结果和失败原因，修复较大 TMDB 分集响应无法读取的问题。',
      tmdbCache: '同一作品及同一季分集共享缓存，成功结果在重启后继续复用，减少重复请求。',
      automaticRecognition: '识别结果通过作品、季集和目标路径校验后自动整理，仅重复文件、低置信度及冲突需要人工处理，并显示具体原因。',
      floatingBackToTop: '仪表盘和待确认队列新增右下角悬浮按钮组，可快速回到页面顶部。',
    },
  },
  v0_2_13: {
    items: {
      completedTvBatchCorrection: '已整理剧集支持按同季或同剧集选择一次正确 TMDB，并批量修正全部分集。',
      batchCorrectionProgress: '批量修正提供持久化进度、逐集结果、最近作业恢复和失败项重试。',
    },
  },
  v0_2_12: {
    items: {
      docsSite: '新增文档站内容，用户手册、部署指南和常见问题更方便集中查看。',
      batchRecognitionDialogScroll: '批量编辑面板保持居中和固定高度，选择大量任务时预览区会在面板内滚动。',
      queueFileNameSorting: '待确认任务按文件名升序排列，同一剧集更容易集中批量选择。',
    },
  },
}
