import type { BatchConfirmItem, BatchConfirmResult, MediaTask, MediaType, QueueRecognitionRequest } from '../types/index'
import type { DirectoryEpisodeRow } from './queueDirectories'

interface DirectoryChoice {
  tmdbId: number
  mediaType: MediaType
  title: string | null
  originalTitle: string | null
  year: number | null
}

interface DirectoryConfirmationApi {
  findTask(id: number): MediaTask | undefined
  save(id: number, request: QueueRecognitionRequest): Promise<void>
  confirm(items: BatchConfirmItem[]): Promise<BatchConfirmResult[]>
}

/** 先保存各文件的坐标，再一次提交目录中的全部选定任务。 */
export async function submitDirectoryConfirmation(
  rows: DirectoryEpisodeRow[], option: DirectoryChoice, api: DirectoryConfirmationApi,
  messages: { stateChanged: string; saveFailed: string; confirmFailed: string },
) {
  const items: BatchConfirmItem[] = []
  const results: BatchConfirmResult[] = []
  for (const row of rows) {
    try {
      const task = api.findTask(row.taskId)
      if (!task || task.status !== 'AWAITING_CONFIRMATION') throw new Error(messages.stateChanged)
      const tv = option.mediaType === 'TV_SHOW'
      const season = tv ? (row.season ?? null) : null
      const episode = tv ? (row.episode ?? null) : null
      const episodeEnd = tv ? (row.episodeEnd ?? null) : null
      const title = option.title || option.originalTitle || task.parsedTitle || ''
      if (task.mediaType !== option.mediaType || task.parsedTitle !== title || task.parsedYear !== option.year || task.parsedSeason !== season
          || task.parsedEpisode !== episode || task.parsedEpisodeEnd !== episodeEnd) {
        await api.save(task.id, {
          mediaType: option.mediaType, parsedTitle: title,
          parsedYear: option.year, parsedSeason: season, parsedEpisode: episode, parsedEpisodeEnd: episodeEnd,
        })
      }
      items.push({ taskId: task.id, tmdbId: option.tmdbId, mediaType: option.mediaType })
    } catch (error) {
      results.push({ taskId: row.taskId, success: false,
        message: error instanceof Error ? error.message : messages.saveFailed })
    }
  }
  if (items.length) {
    const confirmed = await api.confirm(items)
    for (const item of items) {
      results.push(confirmed.find(result => result.taskId === item.taskId)
        ?? { taskId: item.taskId, success: false, message: messages.confirmFailed })
    }
  }
  return results
}
