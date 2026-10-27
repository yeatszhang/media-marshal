import type { MediaTask } from '../types/index'

export function summarizeOrganizationTasks(tasks: MediaTask[]) {
  return {
    pending: tasks.filter(task => task.status === 'PENDING' || task.status === 'PROCESSING').length,
    done: tasks.filter(task => task.status === 'DONE' || task.status === 'CORRECTED').length,
    blocked: tasks.filter(task => task.status === 'AWAITING_CONFIRMATION' || task.status === 'FAILED' || task.status === 'SKIPPED').length,
  }
}
