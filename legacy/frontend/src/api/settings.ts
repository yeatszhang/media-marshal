import http from './http'
import type { ApiResponse, AppSetting, EffectiveSetting } from '@/types'

export const settingsApi = {
  getEmby() {
    return http.get<ApiResponse<{ enabled: boolean; serverUrl: string; apiKeyConfigured: boolean }>>('/api/emby/settings')
  },

  updateEmby(enabled: boolean, serverUrl: string, apiKey: string) {
    return http.put<ApiResponse<void>>('/api/emby/settings', { enabled, serverUrl, apiKey })
  },

  getAll() {
    return http.get<ApiResponse<AppSetting[]>>('/api/settings')
  },

  getEffective(keys: string[]) {
    return http.get<ApiResponse<EffectiveSetting[]>>('/api/settings/effective', {
      params: { keys: keys.join(',') },
    })
  },

  update(key: string, value: string, description?: string, sensitive = false) {
    return http.put<ApiResponse<void>>(`/api/settings/${key}`, {
      value,
      description,
      sensitive,
    })
  },

  updateTmdbProxy(enabled: boolean, httpUrl: string) {
    return http.put<ApiResponse<void>>('/api/settings/tmdb-proxy', {
      enabled,
      httpUrl,
    })
  },

  resetSystem() {
    return http.post<ApiResponse<void>>('/api/settings/reset')
  },
}
