import type { MediaTask, MediaType } from '../types/index'

export function queueParentPath(path: string) {
  const normalized = path.replace(/\\/g, '/')
  return normalized.slice(0, normalized.lastIndexOf('/')) || '/'
}

export function groupQueueDirectories(tasks: MediaTask[]) {
  const groups = new Map<string, { key: string; directory: string; tasks: MediaTask[] }>()
  for (const task of tasks) {
    const directory = queueParentPath(task.sourcePath)
    // 目录批量操作只处理普通视频，原盘和镜像继续独立展示。
    const key = JSON.stringify([task.ruleId, directory,
      task.assetType && task.assetType !== 'VIDEO_FILE' ? task.id : null])
    const group = groups.get(key)
    if (group) group.tasks.push(task)
    else groups.set(key, { key, directory, tasks: [task] })
  }
  return [...groups.values()]
}

export function commonDirectoryOptions<T extends { key: string }>(tasks: MediaTask[], options: (id: number) => T[]): T[] {
  if (!tasks.length) return []
  const keys = tasks.slice(1).map(task => new Set(options(task.id).map(option => option.key)))
  return options(tasks[0].id).filter(option => keys.every(set => set.has(option.key)))
}

/** 共同候选优先；部分文件已有的候选也可由用户选为整组身份。 */
export function summarizeDirectoryCandidates<T extends { key: string; confidence?: number | null }>(
  tasks: MediaTask[], options: (id: number) => T[],
) {
  const candidates = new Map<string, { option: T; count: number; confidence: number }>()
  let missingFiles = 0
  for (const task of tasks) {
    const seen = new Set<string>()
    const taskOptions = options(task.id)
    if (!taskOptions.length) missingFiles++
    for (const option of taskOptions) {
      if (seen.has(option.key)) continue
      seen.add(option.key)
      const current = candidates.get(option.key)
      if (current) {
        current.count++
        current.confidence += option.confidence ?? 0
      } else {
        candidates.set(option.key, { option, count: 1, confidence: option.confidence ?? 0 })
      }
    }
  }
  const sharedOptions = commonDirectoryOptions(tasks, options)
  const ranked = [...candidates.values()].sort((a, b) => b.count - a.count || b.confidence - a.confidence)
  const sharedKeys = new Set(sharedOptions.map(option => option.key))
  const reviewOptions = [...sharedOptions, ...ranked.filter(item => !sharedKeys.has(item.option.key)).map(item => item.option)]
  const leading = sharedOptions.length
    ? candidates.get(sharedOptions[0].key)
    : ranked[0]
  return {
    option: leading?.option,
    supportedFiles: leading?.count ?? 0,
    totalFiles: tasks.length,
    missingFiles,
    sharedOptions,
    reviewOptions,
  }
}

/** 卡片与按钮共用同一禁用原因，避免看得到作品却不知道为何无法确认。 */
export function directoryConfirmationIssue(
  summary: { reviewOptions: unknown[] },
  state: { loading: boolean; recognizing: boolean; submitting: boolean },
) {
  if (state.submitting) return 'submitting'
  if (state.recognizing) return 'recognizing'
  if (state.loading) return 'loading'
  if (!summary.reviewOptions.length) return 'noCandidates'
  return null
}

/** 优先保留已解析季号及路径中的明确标记，其余按用户约定使用第一季。 */
export function resolveEpisodeSeason(task: Pick<MediaTask, 'parsedSeason' | 'sourcePath'>): number {
  if (task.parsedSeason != null) return task.parsedSeason
  const parts = task.sourcePath.replace(/\\/g, '/').split('/').slice(-5).reverse()
  for (const part of parts) {
    const marker = part.match(/(?:^|[^a-z0-9])(?:s|season[\s._-]*)(\d{1,3})(?=$|[^a-z0-9]|e\d)|第\s*([\d零〇一二三四五六七八九十百两]{1,5})\s*季/i)
    if (marker) {
      const number = marker[1] ? Number(marker[1]) : chineseSeasonNumber(marker[2])
      if (number >= 0 && number <= 999) return number
    }
    if (/(?:^|[^a-z0-9])(?:specials?|ova|oad|sp)(?=$|[^a-z0-9]|\d)|特别篇|特別篇|特典/i.test(part)) return 0
  }
  return 1
}

function chineseSeasonNumber(text: string): number {
  if (/^\d+$/.test(text)) return Number(text)
  let total = 0, current = 0
  const units = /[十百]/.test(text)
  for (const ch of text) {
    if (ch === '十' || ch === '百') {
      total += (current || 1) * (ch === '十' ? 10 : 100)
      current = 0
    } else {
      const digit = ch === '两' ? 2 : ch === '〇' ? 0 : '零一二三四五六七八九'.indexOf(ch)
      if (digit < 0) return -1
      current = units ? digit : current * 10 + digit
    }
  }
  return total + current
}

export interface DirectoryEpisodeRow {
  taskId: number
  season: number | null | undefined
  episode: number | null | undefined
  episodeEnd: number | null | undefined
}

export type DirectoryEpisodeIssueDetail =
  | { kind: 'missing' | 'range'; taskIds: number[] }
  | { kind: 'duplicate'; taskIds: number[]; season: number; episode: number; episodeEnd: number }

/** 返回所有受影响文件和实际重叠范围，供拦截提示与行状态共用。 */
export function directoryEpisodeIssues(rows: DirectoryEpisodeRow[], type: MediaType): DirectoryEpisodeIssueDetail[] {
  if (type !== 'TV_SHOW') return []
  const issues: DirectoryEpisodeIssueDetail[] = []
  const valid: { taskId: number; season: number; episode: number; episodeEnd: number }[] = []
  for (const row of rows) {
    const { season, episode, episodeEnd } = row
    if (season == null || episode == null) {
      issues.push({ kind: 'missing', taskIds: [row.taskId] })
      continue
    }
    if (!Number.isInteger(season) || season < 0 || season > 999
        || !Number.isInteger(episode) || episode < 1 || episode > 10000
        || (episodeEnd != null && (!Number.isInteger(episodeEnd) || episodeEnd < episode || episodeEnd > 10000))) {
      issues.push({ kind: 'range', taskIds: [row.taskId] })
      continue
    }
    for (const other of valid) {
      const start = Math.max(episode, other.episode)
      const end = Math.min(episodeEnd ?? episode, other.episodeEnd)
      if (season === other.season && start <= end) {
        issues.push({ kind: 'duplicate', taskIds: [other.taskId, row.taskId], season, episode: start, episodeEnd: end })
      }
    }
    valid.push({ taskId: row.taskId, season, episode, episodeEnd: episodeEnd ?? episode })
  }
  return issues
}

export function directoryEpisodeIssue(rows: DirectoryEpisodeRow[], type: MediaType) {
  return directoryEpisodeIssues(rows, type)[0]?.kind ?? null
}
