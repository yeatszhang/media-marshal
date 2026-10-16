<template>
  <div class="queue-view">
    <div class="page-header">
      <div>
        <h2>{{ t('queue.title') }}</h2>
        <p class="page-desc">{{ t('queue.directory.description', { directories: queueDirectories.length, files: queueTasks.length }) }}</p>
      </div>
      <el-button :loading="loading" @click="loadQueue">
        {{ t('common.refresh') }}
      </el-button>
    </div>

    <el-empty v-if="!loading && queueTasks.length === 0" :description="t('queue.empty')" />

    <div v-else class="queue-list" v-loading="loading">
      <details class="directory-advanced">
        <summary>{{ t('queue.directory.advanced') }}</summary>
      <div class="global-search-panel">
        <div class="panel-header">
          <div>
            <h3>{{ t('queue.globalSearchTitle') }}</h3>
            <p>{{ currentCandidateSummary }}</p>
          </div>
          <el-button link type="primary" @click="searchPanelExpanded = !searchPanelExpanded">
            {{ searchPanelExpanded ? t('queue.collapseSearch') : t('queue.expandSearch') }}
          </el-button>
        </div>

        <div v-if="searchPanelExpanded" class="global-search-body">
          <div class="global-search-row">
            <el-select v-model="globalSearchMediaType" class="media-type-select">
              <el-option :label="t('task.mediaType.MOVIE')" value="MOVIE" />
              <el-option :label="t('task.mediaType.TV_SHOW')" value="TV_SHOW" />
            </el-select>
            <el-input
              v-model="globalSearchKeyword"
              :placeholder="t('queue.globalSearchPlaceholder')"
              clearable
              @keyup.enter="handleGlobalSearch"
            />
            <el-button
              type="primary"
              :loading="globalSearchLoading"
              :disabled="!globalSearchKeyword.trim()"
              @click="handleGlobalSearch"
            >
              {{ t('queue.search') }}
            </el-button>
          </div>

          <el-empty
            v-if="globalSearchPerformed && !globalSearchLoading && globalSearchResults.length === 0"
            :description="t('queue.noSearchResults')"
            :image-size="80"
          />

          <div v-if="globalSearchResults.length > 0" class="global-result-list">
            <button
              v-for="option in globalSearchResults"
              :key="option.key"
              class="global-result-card"
              :class="{ 'is-selected': currentCandidate?.key === option.key }"
              type="button"
              @click="setCurrentCandidate(option)"
            >
              <el-image
                v-if="option.posterUrl"
                class="poster"
                :src="option.posterUrl"
                :alt="displayTitle(option)"
                fit="cover"
                lazy
              />
              <div v-else class="poster poster--empty">
                {{ t('queue.noPoster') }}
              </div>
              <div class="candidate-info">
                <div class="candidate-title">{{ displayTitle(option) }}</div>
                <div class="candidate-meta">
                  <span>{{ option.year ?? t('queue.unknown') }}</span>
                  <span>{{ t(`task.mediaType.${option.mediaType}`) }}</span>
                  <span>{{ t('queue.confidence') }} {{ formatConfidence(option.confidence) }}</span>
                </div>
                <p class="overview">{{ option.overview || t('queue.noOverview') }}</p>
              </div>
            </button>
          </div>
        </div>
      </div>

      <div class="batch-toolbar">
        <div class="batch-actions">
          <el-button size="small" @click="selectCurrentPageTasks">
            {{ t('queue.selectCurrentPageTasks') }}
            <el-tooltip :content="t('queue.selectCurrentPageTasksHelp')" placement="top">
              <el-icon class="button-help-icon" @click.stop.prevent>
                <QuestionFilled />
              </el-icon>
            </el-tooltip>
          </el-button>
          <el-button size="small" @click="clearCurrentPageSelection">
            {{ t('queue.clearPageSelection') }}
            <el-tooltip :content="t('queue.clearPageSelectionHelp')" placement="top">
              <el-icon class="button-help-icon" @click.stop.prevent>
                <QuestionFilled />
              </el-icon>
            </el-tooltip>
          </el-button>
          <el-divider direction="vertical" class="batch-divider" />
          <el-button size="small" :disabled="!canApplyCurrentCandidate" @click="applyCurrentCandidateToSelectedTasks">
            {{ t('queue.applyCurrentCandidate') }}
            <el-tooltip :content="t('queue.applyCurrentCandidateHelp')" placement="top">
              <el-icon class="button-help-icon" @click.stop.prevent>
                <QuestionFilled />
              </el-icon>
            </el-tooltip>
          </el-button>
          <el-button
            size="small"
            type="success"
            plain
            :disabled="!canOpenBatchRecognition"
            @click="openBatchRecognitionEditor"
          >
            {{ t('queue.batchRecognition.open', { count: currentPageSelectedTaskIds.length }) }}
            <el-tooltip :content="t('queue.batchRecognition.openHelp')" placement="top">
              <el-icon class="button-help-icon" @click.stop.prevent>
                <QuestionFilled />
              </el-icon>
            </el-tooltip>
          </el-button>
          <el-button
            size="small"
            type="primary"
            :loading="batchConfirming"
            :disabled="currentPageBatchItems.length === 0"
            @click="handleBatchConfirm"
          >
            {{ t('queue.batchConfirm', { count: currentPageBatchItems.length }) }}
            <el-tooltip :content="t('queue.batchConfirmHelp')" placement="top">
              <el-icon class="button-help-icon" @click.stop.prevent>
                <QuestionFilled />
              </el-icon>
            </el-tooltip>
          </el-button>
          <el-button
            size="small"
            type="warning"
            :loading="batchSkipping"
            :disabled="currentPageSelectedTaskIds.length === 0"
            @click="handleBatchSkip"
          >
            {{ t('queue.batchSkip', { count: currentPageSelectedTaskIds.length }) }}
            <el-tooltip :content="t('queue.batchSkipHelp')" placement="top">
              <el-icon class="button-help-icon" @click.stop.prevent>
                <QuestionFilled />
              </el-icon>
            </el-tooltip>
          </el-button>
        </div>
        <el-text size="small" type="info">
          {{ t('queue.pageSelectionHint') }}
        </el-text>
      </div>

      <div v-if="visibleCandidateGroups.length > 0 && displayedDirectories.every(group => group.tasks.length === 1)" class="candidate-groups">
        <el-alert
          v-for="group in visibleCandidateGroups"
          :key="group.key"
          type="info"
          show-icon
          :closable="false"
        >
          <template #title>
            <span>
              {{ t('queue.sameCandidateHint', { count: group.count, title: group.title }) }}
            </span>
            <el-button size="small" link type="primary" @click="quickSelectCandidateGroup(group.key)">
              {{ t('queue.quickSelect') }}
            </el-button>
          </template>
        </el-alert>
        <el-button
          v-if="candidateGroups.length > 3"
          size="small"
          link
          type="primary"
          @click="recommendationExpanded = !recommendationExpanded"
        >
          {{ recommendationExpanded
            ? t('queue.collapseRecommendations')
            : t('queue.expandRecommendations', { count: candidateGroups.length - 3 }) }}
        </el-button>
      </div>

      </details>
      <template v-for="group in displayedDirectories" :key="group.key">
        <el-card v-if="group.tasks.length > 1" class="directory-card" shadow="never">
          <template #header>
            <div class="directory-header">
              <div class="directory-heading">
                <el-checkbox :model-value="group.tasks.every(task => selectedTaskIds.has(task.id))"
                             :indeterminate="group.tasks.some(task => selectedTaskIds.has(task.id)) && !group.tasks.every(task => selectedTaskIds.has(task.id))"
                             :aria-label="t('queue.directory.selectAll')"
                             @change="(checked) => group.tasks.forEach(task => toggleTaskSelection(task.id, Boolean(checked)))" />
                <div>
                  <h3>{{ sourceFileName(group.directory) }}</h3>
                  <div class="directory-path" :title="group.directory">{{ group.directory }}</div>
                </div>
                <el-tag>{{ t('queue.directory.fileCount', { count: group.tasks.length }) }}</el-tag>
              </div>
              <div class="directory-actions">
                <el-button :loading="recognitionActionLoading === 'codex-directory' && group.tasks.some(task => task.id === codexTaskId)"
                           :disabled="recognitionActionLoading !== null || directorySubmitting"
                           @click="handleCodexDirectoryRecognition(group.tasks[0])">
                  {{ t('queue.directory.recognize') }}
                </el-button>
                <el-button type="primary" :disabled="directoryOptions(group).length === 0 || recognitionActionLoading !== null || directorySubmitting"
                           @click="openDirectoryReview(group)">
                  {{ t('queue.directory.confirm', { count: group.tasks.length }) }}
                </el-button>
                <el-button link @click="toggleDirectoryDetails(group.key)">
                  {{ expandedDirectories.has(group.key) ? t('queue.directory.collapse') : t('queue.directory.expand') }}
                </el-button>
              </div>
            </div>
          </template>
          <div class="directory-identity">
            <el-image v-if="directoryOptions(group)[0]?.posterUrl" class="directory-poster"
                      :src="directoryOptions(group)[0].posterUrl!" fit="cover" />
            <div>
              <h3>{{ directoryOptions(group)[0] ? displayTitle(directoryOptions(group)[0]) : t('queue.directory.unrecognized') }}</h3>
              <p>{{ directoryOptions(group)[0] ? t('queue.directory.sharedCandidate', { count: directoryOptions(group).length }) : t('queue.directory.recognizeHint') }}</p>
              <el-tag v-if="directoryOptions(group)[0]" size="small" type="info">
                {{ directoryOptions(group)[0].year ?? t('queue.unknown') }} · {{ t(`task.mediaType.${directoryOptions(group)[0].mediaType}`) }}
              </el-tag>
            </div>
          </div>
          <el-table :data="group.tasks" size="small" max-height="290" class="directory-files">
            <el-table-column :label="t('queue.directory.filename')" min-width="180">
              <template #default="{ row }">{{ sourceFileName(row.sourcePath) }}</template>
            </el-table-column>
            <el-table-column :label="t('queue.episode')" min-width="170">
              <template #default="{ row }">{{ formatSeasonEpisode(row) }}</template>
            </el-table-column>
            <el-table-column :label="t('queue.directory.fileStatus')" min-width="180">
              <template #default="{ row }">
                <el-text v-if="batchErrorByTask[row.id]" type="danger">{{ batchErrorByTask[row.id] }}</el-text>
                <el-text v-else-if="row.metadataWarning || row.errorMessage?.includes('TMDB')" type="warning">{{ row.metadataWarning || row.errorMessage }}</el-text>
                <el-text v-else-if="row.mediaType === 'TV_SHOW' && row.parsedEpisode == null" type="warning">{{ t('queue.directory.needsCoordinates') }}</el-text>
                <el-text v-else type="info">{{ t('queue.directory.readyToReview') }}</el-text>
              </template>
            </el-table-column>
          </el-table>
          <details v-if="group.tasks[0].errorMessage?.startsWith('Codex')" class="directory-evidence">
            <summary>{{ t('queue.directory.evidence') }}</summary>
            <p>{{ group.tasks[0].errorMessage }}</p>
          </details>
        </el-card>
        <template v-if="group.tasks.length === 1 || expandedDirectories.has(group.key)">
      <el-card v-for="task in group.tasks" :key="task.id" class="queue-card" shadow="never">
        <template #header>
          <div class="card-header">
            <el-checkbox
              :model-value="selectedTaskIds.has(task.id)"
              @change="(checked) => toggleTaskSelection(task.id, Boolean(checked))"
            />
            <div class="file-path" :title="task.sourcePath">{{ task.sourcePath }}</div>
            <div class="header-tags">
              <el-button size="small" type="primary" plain
                         :loading="codexTaskId === task.id && recognitionActionLoading === 'codex'"
                         :disabled="recognitionActionLoading !== null"
                         @click="handleCodexRecognition(task)">
                {{ t('queue.codexRematch') }}
              </el-button>
              <el-tooltip v-if="!task.assetType || task.assetType === 'VIDEO_FILE'"
                          :content="t('queue.codexDirectoryHelp')" placement="top">
                <el-button
                           size="small" type="primary" plain
                           :loading="codexTaskId === task.id && recognitionActionLoading === 'codex-directory'"
                           :disabled="recognitionActionLoading !== null"
                           @click="handleCodexDirectoryRecognition(task)">
                  {{ t('queue.codexDirectoryRematch') }}
                </el-button>
              </el-tooltip>
              <el-tag :type="selectedTaskIds.has(task.id) ? (selectedOptionByTask[task.id] ? 'success' : 'info') : 'info'" size="small">
                {{ taskSelectionStatus(task.id) }}
              </el-tag>
              <el-tag :type="assetTypeTagType(task.assetType)" size="small">
                {{ t(`task.assetType.${task.assetType || 'VIDEO_FILE'}`) }}
              </el-tag>
              <el-tag type="warning" size="small">
                {{ t('queue.confidence') }}: {{ formatConfidence(task.matchConfidence) }}
              </el-tag>
              <el-tag size="small">{{ t(`task.status.${task.status}`) }}</el-tag>
            </div>
          </div>
        </template>

        <el-alert
          v-if="task.errorMessage"
          :title="task.errorMessage"
          :type="task.errorMessage.startsWith('Codex') ? 'info' : 'warning'"
          :closable="false"
          style="margin-bottom: 12px; overflow-wrap: anywhere"
        />
        <el-alert
          v-if="task.metadataWarning && task.metadataWarning !== task.errorMessage"
          :title="task.metadataWarning"
          type="warning"
          :closable="false"
          show-icon
          style="margin-bottom: 12px; overflow-wrap: anywhere"
        />
        <el-descriptions :column="4" size="small" border class="task-meta">
          <el-descriptions-item :label="t('queue.parsedTitle')">
            {{ formatParsedTitle(task) }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('queue.mediaType')">
            {{ task.mediaType ? t(`task.mediaType.${task.mediaType}`) : t('queue.unknown') }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('queue.episode')">
            {{ formatSeasonEpisode(task) }}
          </el-descriptions-item>
          <el-descriptions-item :label="t('queue.resolution')">
            {{ formatResolution(task) }}
          </el-descriptions-item>
        </el-descriptions>

        <div class="candidate-section">
          <div class="section-title">
            <span>{{ t('queue.candidates') }}</span>
            <el-button link type="primary" :loading="candidateLoadingByTask[task.id]" @click="loadCandidates(task.id)">
              {{ t('common.refresh') }}
            </el-button>
          </div>

          <el-empty
            v-if="!candidateLoadingByTask[task.id] && getTaskOptions(task.id).length === 0"
            :description="t('queue.noCandidates')"
            :image-size="80"
          />

          <el-radio-group
            v-else
            v-model="selectedOptionByTask[task.id]"
            class="candidate-list"
            @change="markManualSelection(task.id)"
          >
            <el-radio
              v-for="option in getTaskOptions(task.id)"
              :key="option.key"
              class="candidate-option"
              :label="option.key"
              border
            >
              <div class="candidate-content">
                <el-image
                  v-if="option.posterUrl"
                  class="poster"
                  :src="option.posterUrl"
                  :alt="displayTitle(option)"
                  fit="cover"
                  lazy
                />
                <div v-else class="poster poster--empty">
                  {{ t('queue.noPoster') }}
                </div>

                <div class="candidate-info">
                  <div class="candidate-title-row">
                    <span class="candidate-title">{{ displayTitle(option) }}</span>
                  </div>
                  <div class="candidate-tag-row">
                    <el-tag v-if="option.rank != null" size="small" type="warning">
                      {{ t('queue.rank', { rank: option.rank }) }}
                    </el-tag>
                    <el-tag size="small" type="info">
                      {{ option.origin === 'candidate' ? t('queue.systemCandidate') : t('queue.searchCandidate') }}
                    </el-tag>
                  </div>
                  <div class="candidate-meta">
                    <span>{{ option.year ?? t('queue.unknown') }}</span>
                    <span>{{ t(`task.mediaType.${option.mediaType}`) }}</span>
                    <span>{{ t('queue.confidence') }} {{ formatConfidence(option.confidence) }}</span>
                  </div>
                  <p class="overview">{{ option.overview || t('queue.noOverview') }}</p>
                </div>
              </div>
            </el-radio>
          </el-radio-group>
        </div>

        <div class="actions">
          <el-text v-if="batchErrorByTask[task.id]" type="danger" size="small">
            {{ batchErrorByTask[task.id] }}
          </el-text>
          <el-button
            type="primary"
            :loading="actionLoadingByTask[task.id]"
            :disabled="!selectedOptionByTask[task.id]"
            @click="handleConfirm(task.id)"
          >
            {{ t('queue.confirm') }}
          </el-button>
          <el-button
            type="warning"
            plain
            :loading="actionLoadingByTask[task.id]"
            @click="openRecognitionEditor(task)"
          >
            {{ t('queue.editRecognition') }}
          </el-button>
          <el-button :loading="actionLoadingByTask[task.id]" @click="handleSkip(task.id)">
            {{ t('queue.skip') }}
          </el-button>
        </div>
      </el-card>
        </template>
      </template>
      <div class="pagination-row">
        <el-pagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :page-sizes="[10, 20, 50, 100]"
          :total="queueDirectories.length"
          layout="total, sizes, prev, pager, next"
        />
      </div>
    </div>

    <el-dialog v-model="directoryReviewVisible" :title="t('queue.directory.reviewTitle')"
               width="min(96vw, 960px)" align-center destroy-on-close
               :close-on-click-modal="!directorySubmitting" :close-on-press-escape="!directorySubmitting"
               :show-close="!directorySubmitting" :before-close="closeDirectoryReview">
      <div v-loading="directorySubmitting">
        <p class="directory-path">{{ directoryReviewPath }}</p>
        <p>{{ t('queue.directory.reviewHint', { count: directoryReviewRows.length }) }}</p>
        <el-form label-position="top">
          <el-form-item :label="t('queue.directory.oneCandidate')" required>
            <el-select v-model="directoryReviewChoice" class="recognition-field" :placeholder="t('queue.directory.chooseCandidate')">
              <el-option v-for="option in directoryReviewOptions" :key="option.key" :value="option.key"
                         :label="`${displayTitle(option)} · ${option.year ?? t('queue.unknown')} · ${t(`task.mediaType.${option.mediaType}`)}`" />
            </el-select>
          </el-form-item>
        </el-form>
        <div v-if="directorySelectedOption?.mediaType === 'TV_SHOW'" class="directory-season-row">
          <span>{{ t('queue.directory.uniformSeason') }}</span>
          <el-input-number v-model="directoryReviewSeason" :min="0" :max="999" controls-position="right" />
          <el-button :disabled="directoryReviewSeason == null" @click="applyDirectorySeason">{{ t('queue.directory.applySeason') }}</el-button>
          <el-text type="info" size="small">{{ t('queue.directory.seasonDefault') }}</el-text>
        </div>
        <el-alert v-if="directoryReviewIssue" :title="directoryReviewIssue" type="warning" :closable="false" class="batch-alert" />
        <el-table :data="directoryReviewRows" max-height="400" size="small">
          <el-table-column width="52">
            <template #default="{ row }"><el-checkbox v-model="row.included" :aria-label="t('queue.directory.includeFile')" /></template>
          </el-table-column>
          <el-table-column :label="t('queue.directory.filename')" min-width="150">
            <template #default="{ row }">{{ sourceFileName(row.task.sourcePath) }}</template>
          </el-table-column>
          <template v-if="directorySelectedOption?.mediaType === 'TV_SHOW'">
            <el-table-column :label="t('queue.parsedSeason')" width="140">
              <template #default="{ row }"><el-input-number v-model="row.season" :disabled="!row.included" :min="0" :max="999" size="small" controls-position="right" class="directory-coordinate" /></template>
            </el-table-column>
            <el-table-column :label="t('queue.parsedEpisode')" width="140">
              <template #default="{ row }"><el-input-number v-model="row.episode" :disabled="!row.included" :min="1" :max="10000" size="small" controls-position="right" class="directory-coordinate" /></template>
            </el-table-column>
            <el-table-column :label="t('queue.directory.episodeEnd')" width="140">
              <template #default="{ row }"><el-input-number v-model="row.episodeEnd" :disabled="!row.included" :min="1" :max="10000" size="small" controls-position="right" class="directory-coordinate" /></template>
            </el-table-column>
          </template>
          <el-table-column :label="t('queue.directory.fileStatus')" min-width="130">
            <template #default="{ row }"><el-text :type="row.error ? 'danger' : 'info'">{{ row.error || t('queue.directory.readyToReview') }}</el-text></template>
          </el-table-column>
        </el-table>
      </div>
      <template #footer>
        <div class="directory-review-footer">
          <el-text size="small" type="info">{{ t('queue.directory.organizeHint') }}</el-text>
          <div>
            <el-button :disabled="directorySubmitting" @click="directoryReviewVisible = false">{{ t('common.cancel') }}</el-button>
            <el-button type="primary" :loading="directorySubmitting"
                       :disabled="!!directoryReviewIssue || directoryIncludedRows.length === 0 || directorySubmitting"
                       @click="confirmDirectory">
              {{ t('queue.directory.organize', { count: directoryIncludedRows.length }) }}
            </el-button>
          </div>
        </div>
      </template>
    </el-dialog>

    <el-drawer
      v-model="recognitionDrawerVisible"
      :title="t('queue.recognitionEditorTitle')"
      size="min(92vw, 420px)"
      class="recognition-drawer"
    >
      <el-form label-position="top" class="recognition-form">
        <el-form-item :label="t('queue.sourcePath')">
          <el-input :model-value="recognitionTask?.sourcePath || ''" readonly disabled />
        </el-form-item>
        <el-form-item :label="t('queue.assetType')">
          <el-tag :type="assetTypeTagType(recognitionTask?.assetType)">
            {{ t(`task.assetType.${recognitionTask?.assetType || 'VIDEO_FILE'}`) }}
          </el-tag>
        </el-form-item>
        <el-form-item :label="t('queue.mediaType')">
          <el-select v-model="recognitionForm.mediaType" class="recognition-field">
            <el-option :label="t('task.mediaType.MOVIE')" value="MOVIE" />
            <el-option :label="t('task.mediaType.TV_SHOW')" value="TV_SHOW" />
          </el-select>
        </el-form-item>
        <el-form-item :label="t('queue.parsedTitle')" required>
          <el-input v-model="recognitionForm.parsedTitle" :placeholder="t('queue.parsedTitlePlaceholder')" />
        </el-form-item>
        <el-form-item :label="t('queue.parsedYear')">
          <el-input-number
            v-model="recognitionForm.parsedYear"
            class="recognition-field"
            :min="1"
            :max="9999"
            controls-position="right"
          />
        </el-form-item>
        <template v-if="recognitionForm.mediaType === 'TV_SHOW'">
          <el-form-item :label="t('queue.parsedSeason')" required>
            <el-input-number
              v-model="recognitionForm.parsedSeason"
              class="recognition-field"
              :min="0"
              :max="999"
              controls-position="right"
            />
          </el-form-item>
          <el-form-item :label="t('queue.parsedEpisode')" required>
            <el-input-number
              v-model="recognitionForm.parsedEpisode"
              class="recognition-field"
              :min="0"
              :max="9999"
              controls-position="right"
            />
          </el-form-item>
        </template>
        <el-form-item :label="t('queue.resolution')">
          <el-input :model-value="recognitionTask?.parsedResolution || t('queue.unknown')" readonly disabled />
        </el-form-item>
        <el-form-item :label="t('queue.currentCandidate')">
          <el-input :model-value="currentRecognitionCandidateSummary" readonly disabled />
        </el-form-item>
      </el-form>
      <template #footer>
        <div class="drawer-actions">
          <el-button @click="recognitionDrawerVisible = false">
            {{ t('common.cancel') }}
          </el-button>
          <el-button
            :loading="recognitionActionLoading === 'save'"
            :disabled="recognitionActionLoading !== null"
            @click="handleSaveRecognition"
          >
            {{ t('queue.saveRecognition') }}
          </el-button>
          <el-button :loading="recognitionActionLoading === 'codex'"
                     :disabled="recognitionActionLoading !== null" @click="handleCodexRecognition()">
            {{ t('queue.codexRematch') }}
          </el-button>
          <el-button
            type="primary"
            :loading="recognitionActionLoading === 'rematch'"
            :disabled="recognitionActionLoading !== null"
            @click="handleSaveRecognitionAndRematch"
          >
            {{ t('queue.saveAndRematch') }}
          </el-button>
        </div>
      </template>
    </el-drawer>

    <el-dialog
      v-model="batchRecognitionDialogVisible"
      :title="t('queue.batchRecognition.title')"
      width="min(96vw, 1180px)"
      class="batch-recognition-dialog"
      align-center
      destroy-on-close
    >
      <div class="batch-recognition-layout">
        <section class="batch-recognition-section batch-recognition-summary">
          <div class="batch-section-header">
            <div>
              <h3>{{ t('queue.batchRecognition.summaryTitle') }}</h3>
              <p>{{ t('queue.batchRecognition.summaryHint') }}</p>
            </div>
            <el-tag type="primary">
              {{ t('queue.batchRecognition.selectedCount', { count: currentPageSelectedTaskIds.length }) }}
            </el-tag>
          </div>

          <el-descriptions :column="4" size="small" border>
            <el-descriptions-item :label="t('queue.batchRecognition.sourceSummary')" :span="2">
              <span class="mono-text">{{ batchSourceSummary }}</span>
            </el-descriptions-item>
            <el-descriptions-item :label="t('queue.batchRecognition.sourceDirCount')">
              {{ batchSourceDirCount }}
            </el-descriptions-item>
            <el-descriptions-item :label="t('queue.batchRecognition.watchRuleCount')">
              {{ batchWatchRuleCount }}
            </el-descriptions-item>
          </el-descriptions>
        </section>

        <div class="batch-recognition-main">
          <section class="batch-recognition-section">
            <div class="batch-section-header">
              <div>
                <h3>{{ t('queue.batchRecognition.fieldsTitle') }}</h3>
                <p>{{ t('queue.batchRecognition.fieldsHint') }}</p>
              </div>
            </div>

            <div class="batch-field-grid">
              <div class="batch-field" :class="{ 'is-disabled': !batchRecognitionFields.MEDIA_TYPE }">
                <el-checkbox v-model="batchRecognitionFields.MEDIA_TYPE">
                  {{ t('queue.mediaType') }}
                </el-checkbox>
                <el-select
                  v-model="batchRecognitionForm.mediaType"
                  :disabled="!batchRecognitionFields.MEDIA_TYPE"
                  class="batch-field-control"
                >
                  <el-option :label="t('task.mediaType.MOVIE')" value="MOVIE" />
                  <el-option :label="t('task.mediaType.TV_SHOW')" value="TV_SHOW" />
                </el-select>
              </div>

              <div class="batch-field" :class="{ 'is-disabled': !batchRecognitionFields.PARSED_TITLE }">
                <el-checkbox v-model="batchRecognitionFields.PARSED_TITLE">
                  {{ t('queue.parsedTitle') }}
                </el-checkbox>
                <el-input
                  v-model="batchRecognitionForm.parsedTitle"
                  :disabled="!batchRecognitionFields.PARSED_TITLE"
                  :placeholder="t('queue.parsedTitlePlaceholder')"
                  class="batch-field-control"
                />
              </div>

              <div class="batch-field" :class="{ 'is-disabled': !batchRecognitionFields.PARSED_YEAR }">
                <el-checkbox v-model="batchRecognitionFields.PARSED_YEAR">
                  {{ t('queue.parsedYear') }}
                </el-checkbox>
                <el-input-number
                  v-model="batchRecognitionForm.parsedYear"
                  :disabled="!batchRecognitionFields.PARSED_YEAR"
                  :min="0"
                  :max="9999"
                  controls-position="right"
                  class="batch-field-control"
                />
              </div>

              <div class="batch-field" :class="{ 'is-disabled': !batchRecognitionFields.PARSED_SEASON }">
                <el-checkbox v-model="batchRecognitionFields.PARSED_SEASON">
                  {{ t('queue.parsedSeason') }}
                </el-checkbox>
                <el-input-number
                  v-model="batchRecognitionForm.parsedSeason"
                  :disabled="!batchRecognitionFields.PARSED_SEASON"
                  :min="0"
                  :max="999"
                  controls-position="right"
                  class="batch-field-control"
                />
              </div>
            </div>

            <div v-if="showBatchSequentialControls" class="sequence-panel">
              <div class="sequence-switch-row">
                <div>
                  <strong>{{ t('queue.batchRecognition.sequenceTitle') }}</strong>
                  <p>{{ t('queue.batchRecognition.sequenceHint') }}</p>
                </div>
                <el-switch
                  v-model="batchRecognitionForm.episodeAssignmentMode"
                  active-value="SEQUENTIAL"
                  inactive-value="PRESERVE"
                />
              </div>

              <div v-if="batchRecognitionForm.episodeAssignmentMode === 'SEQUENTIAL'" class="sequence-controls">
                <el-form-item :label="t('queue.batchRecognition.episodeStart')">
                  <el-input-number
                    v-model="batchRecognitionForm.episodeStart"
                    :min="0"
                    :max="9999"
                    controls-position="right"
                  />
                </el-form-item>
                <el-form-item :label="t('queue.batchRecognition.sortDirection')">
                  <el-segmented
                    v-model="batchRecognitionForm.episodeSortDirection"
                    :options="[
                      { label: t('queue.batchRecognition.sortAsc'), value: 'ASC' },
                      { label: t('queue.batchRecognition.sortDesc'), value: 'DESC' },
                    ]"
                  />
                </el-form-item>
              </div>
            </div>
          </section>

          <section
            v-loading="batchRecognitionPreviewLoading"
            class="batch-recognition-section batch-preview-section"
          >
            <div class="batch-section-header">
              <div>
                <h3>{{ t('queue.batchRecognition.previewTitle') }}</h3>
                <p>{{ t('queue.batchRecognition.previewHint') }}</p>
              </div>
              <div v-if="batchRecognitionPreview" class="preview-tags">
                <el-tag type="success">{{ t('queue.batchRecognition.editableCount', { count: batchRecognitionPreview.editableCount }) }}</el-tag>
                <el-tag type="danger">{{ t('queue.batchRecognition.blockerCount', { count: batchRecognitionPreview.blockerCount }) }}</el-tag>
                <el-tag type="warning">{{ t('queue.batchRecognition.warningCount', { count: batchRecognitionPreview.warningCount }) }}</el-tag>
              </div>
            </div>

            <el-alert
              v-if="!hasBatchRecognitionAction && !batchRecognitionPreview && !batchRecognitionPreviewLoading"
              type="info"
              :closable="false"
              :title="t('queue.batchRecognition.noActionHint')"
              class="batch-alert"
            />
            <el-alert
              v-for="blocker in batchRecognitionPreview?.blockers || []"
              :key="`blocker-${blocker}`"
              type="error"
              :closable="false"
              :title="blocker"
              class="batch-alert"
            />
            <el-alert
              v-for="warning in batchRecognitionPreview?.warnings || []"
              :key="`warning-${warning}`"
              type="warning"
              :closable="false"
              :title="warning"
              class="batch-alert"
            />

            <el-table
              :data="batchRecognitionPreview?.items || []"
              height="100%"
              size="small"
              class="batch-preview-table"
            >
              <el-table-column type="index" :label="t('queue.batchRecognition.index')" width="70" />
              <el-table-column prop="sourcePath" :label="t('queue.sourcePath')" min-width="260" show-overflow-tooltip>
                <template #default="{ row }">
                  <span class="mono-text">{{ row.sourcePath }}</span>
                </template>
              </el-table-column>
              <el-table-column :label="t('queue.batchRecognition.mediaTypeChange')" width="150">
                <template #default="{ row }">
                  {{ formatPreviewMediaType(row.currentMediaType) }}
                  <template v-if="hasPreviewValueChanged(row.currentMediaType, row.effectiveMediaType)">
                    <span class="change-arrow">-&gt;</span>
                    {{ formatPreviewMediaType(row.effectiveMediaType) }}
                  </template>
                </template>
              </el-table-column>
              <el-table-column :label="t('queue.batchRecognition.titleChange')" min-width="180" show-overflow-tooltip>
                <template #default="{ row }">
                  {{ formatNullable(row.currentTitle) }}
                  <template v-if="hasPreviewValueChanged(row.currentTitle, row.effectiveTitle)">
                    <span class="change-arrow">-&gt;</span>
                    {{ formatNullable(row.effectiveTitle) }}
                  </template>
                </template>
              </el-table-column>
              <el-table-column :label="t('queue.batchRecognition.yearChange')" width="120">
                <template #default="{ row }">
                  {{ formatNullable(row.currentYear) }}
                  <template v-if="hasPreviewValueChanged(row.currentYear, row.effectiveYear)">
                    <span class="change-arrow">-&gt;</span>
                    {{ formatNullable(row.effectiveYear) }}
                  </template>
                </template>
              </el-table-column>
              <el-table-column :label="t('queue.batchRecognition.seasonChange')" width="120">
                <template #default="{ row }">
                  {{ formatNullable(row.currentSeason) }}
                  <template v-if="hasPreviewValueChanged(row.currentSeason, row.effectiveSeason)">
                    <span class="change-arrow">-&gt;</span>
                    {{ formatNullable(row.effectiveSeason) }}
                  </template>
                </template>
              </el-table-column>
              <el-table-column :label="t('queue.batchRecognition.episodeChange')" width="140">
                <template #default="{ row }">
                  {{ formatPreviewEpisode(row, 'current') }}
                  <template v-if="hasPreviewEpisodeChanged(row)">
                    <span class="change-arrow">-&gt;</span>
                    {{ formatPreviewEpisode(row, 'effective') }}
                  </template>
                </template>
              </el-table-column>
              <el-table-column :label="t('queue.batchRecognition.messages')" min-width="210">
                <template #default="{ row }">
                  <div class="preview-message-tags">
                    <el-tag
                      v-for="blocker in row.blockers"
                      :key="`b-${row.taskId}-${blocker}`"
                      type="danger"
                      size="small"
                    >
                      {{ blocker }}
                    </el-tag>
                    <el-tag
                      v-for="warning in row.warnings"
                      :key="`w-${row.taskId}-${warning}`"
                      type="warning"
                      size="small"
                    >
                      {{ warning }}
                    </el-tag>
                    <el-tag
                      v-if="row.blockers.length === 0 && row.warnings.length === 0 && !hasPreviewRowChanged(row)"
                      type="info"
                      size="small"
                    >
                      {{ t('queue.batchRecognition.noChange') }}
                    </el-tag>
                    <span v-else-if="row.blockers.length === 0 && row.warnings.length === 0">-</span>
                  </div>
                </template>
              </el-table-column>
            </el-table>
          </section>
        </div>
      </div>

      <template #footer>
        <div class="dialog-actions">
          <el-button @click="batchRecognitionDialogVisible = false">
            {{ t('common.cancel') }}
          </el-button>
          <el-button
            :loading="batchRecognitionActionLoading === 'save'"
            :disabled="!batchRecognitionCanApply || batchRecognitionPreviewLoading"
            @click="handleSaveBatchRecognition"
          >
            {{ t('queue.batchRecognition.saveOnly') }}
          </el-button>
          <el-button
            type="primary"
            :loading="batchRecognitionActionLoading === 'rematch'"
            :disabled="!batchRecognitionCanApply || batchRecognitionPreviewLoading"
            @click="handleSaveBatchRecognitionAndRematch"
          >
            {{ t('queue.batchRecognition.saveAndRematch') }}
          </el-button>
        </div>
      </template>
    </el-dialog>

    <FloatingActionGroup :label="t('common.backToTop')" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMediaStore } from '@/stores/mediaStore'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import { mediaApi } from '@/api/media'
import FloatingActionGroup from '@/components/FloatingActionGroup.vue'
import { groupQueueDirectories, commonDirectoryOptions, directoryEpisodeIssue, resolveEpisodeSeason } from '@/utils/queueDirectories'
import type { DirectoryEpisodeRow } from '@/utils/queueDirectories'
import { submitDirectoryConfirmation } from '@/utils/confirmQueueDirectory'
import type {
  BatchConfirmItem,
  BatchRecognitionField,
  EpisodeAssignmentMode,
  EpisodeSortDirection,
  MatchResult,
  MediaAssetType,
  MediaTask,
  MediaType,
  QueueBatchRecognitionPreview,
  QueueBatchRecognitionPreviewItem,
  QueueBatchRecognitionRequest,
  QueueRecognitionRequest,
  QueueRecognitionResponse,
  TaskCandidate,
} from '@/types'

const { t } = useI18n()
const mediaStore = useMediaStore()
const { queueTasks, loading } = storeToRefs(mediaStore)

type OptionOrigin = 'candidate' | 'search'

interface QueueOption {
  key: string
  origin: OptionOrigin
  tmdbId: number
  title: string | null
  originalTitle: string | null
  year: number | null
  mediaType: MediaType
  overview: string | null
  posterUrl: string | null
  confidence: number | null
  rank: number | null
}

const candidateOptionsByTask = reactive<Record<number, QueueOption[]>>({})
const searchOptionsByTask = reactive<Record<number, QueueOption[]>>({})
const selectedOptionByTask = reactive<Record<number, string>>({})
const candidateLoadingByTask = reactive<Record<number, boolean>>({})
const actionLoadingByTask = reactive<Record<number, boolean>>({})
const batchErrorByTask = reactive<Record<number, string>>({})
const manualSelectedTaskIds = reactive(new Set<number>())
const selectedTaskIds = reactive(new Set<number>())
const currentPage = ref(1)
const pageSize = ref(20)
const batchConfirming = ref(false)
const batchSkipping = ref(false)
const globalSearchKeyword = ref('')
const globalSearchMediaType = ref<MediaType>('TV_SHOW')
const globalSearchLoading = ref(false)
const globalSearchPerformed = ref(false)
const globalSearchResults = ref<QueueOption[]>([])
const currentCandidate = ref<QueueOption | null>(null)
const searchPanelExpanded = ref(false)
const recommendationExpanded = ref(false)
const recognitionDrawerVisible = ref(false)
const recognitionTask = ref<MediaTask | null>(null)
const recognitionActionLoading = ref<'save' | 'rematch' | 'codex' | 'codex-directory' | null>(null)
const codexTaskId = ref<number | null>(null)
const recognitionForm = reactive<QueueRecognitionRequest>({
  mediaType: 'MOVIE',
  parsedTitle: '',
  parsedYear: null,
  parsedSeason: null,
  parsedEpisode: null,
  parsedEpisodeEnd: null,
})
type DirectoryGroup = ReturnType<typeof groupQueueDirectories>[number]
interface DirectoryReviewRow extends DirectoryEpisodeRow {
  task: MediaTask
  included: boolean
  error: string
}
const expandedDirectories = reactive(new Set<string>())
const directoryReviewVisible = ref(false)
const directoryReviewPath = ref('')
const directoryReviewOptions = ref<QueueOption[]>([])
const directoryReviewChoice = ref('')
const directoryReviewRows = ref<DirectoryReviewRow[]>([])
const directoryReviewSeason = ref<number | undefined>()
const directorySubmitting = ref(false)
const directorySelectedOption = computed(() => directoryReviewOptions.value.find(option => option.key === directoryReviewChoice.value))
const directoryIncludedRows = computed(() => directoryReviewRows.value.filter(row => row.included))
const directoryReviewIssue = computed(() => {
  if (!directorySelectedOption.value) return t('queue.directory.chooseCandidate')
  const issue = directoryEpisodeIssue(directoryIncludedRows.value, directorySelectedOption.value.mediaType)
  return issue ? t(`queue.directory.issue.${issue}`) : ''
})
const batchRecognitionDialogVisible = ref(false)
const batchRecognitionPreviewLoading = ref(false)
const batchRecognitionPreview = ref<QueueBatchRecognitionPreview | null>(null)
const batchRecognitionActionLoading = ref<'save' | 'rematch' | null>(null)
let batchRecognitionPreviewTimer: ReturnType<typeof window.setTimeout> | null = null
let batchRecognitionPreviewRequestId = 0
const batchRecognitionFields = reactive<Record<BatchRecognitionField, boolean>>({
  MEDIA_TYPE: false,
  PARSED_TITLE: false,
  PARSED_YEAR: false,
  PARSED_SEASON: false,
})
const batchRecognitionForm = reactive<{
  mediaType: MediaType
  parsedTitle: string
  parsedYear: number | null
  parsedSeason: number | null
  episodeAssignmentMode: EpisodeAssignmentMode
  episodeStart: number | null
  episodeSortDirection: EpisodeSortDirection
}>({
  mediaType: 'TV_SHOW',
  parsedTitle: '',
  parsedYear: null,
  parsedSeason: null,
  episodeAssignmentMode: 'PRESERVE',
  episodeStart: 1,
  episodeSortDirection: 'ASC',
})

const queueFileNameCollator = new Intl.Collator('zh-CN', {
  numeric: true,
  sensitivity: 'base',
})

const sortedQueueTasks = computed(() => {
  return [...queueTasks.value].sort(compareQueueTaskByFileNameAsc)
})

const queueDirectories = computed(() => groupQueueDirectories(sortedQueueTasks.value))
const displayedDirectories = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return queueDirectories.value.slice(start, start + pageSize.value)
})
// 按目录分页，整部剧不会被文件分页截断。
const displayedTasks = computed(() => displayedDirectories.value.flatMap(group => group.tasks))

const currentPageBatchItems = computed<BatchConfirmItem[]>(() => {
  return displayedTasks.value
    .map((task) => {
      if (!selectedTaskIds.has(task.id)) return null
      const selected = getSelectedOption(task.id)
      return selected
        ? { taskId: task.id, tmdbId: selected.tmdbId, mediaType: selected.mediaType }
        : null
    })
    .filter((item): item is BatchConfirmItem => item !== null)
})

const currentPageSelectedTaskIds = computed(() => {
  return displayedTasks.value
    .filter((task) => selectedTaskIds.has(task.id))
    .map((task) => task.id)
})

const currentPageSelectedTasks = computed(() => {
  return displayedTasks.value.filter((task) => selectedTaskIds.has(task.id))
})

const canApplyCurrentCandidate = computed(() => {
  return Boolean(currentCandidate.value) && displayedTasks.value.some((task) => selectedTaskIds.has(task.id))
})

const canOpenBatchRecognition = computed(() => currentPageSelectedTaskIds.value.length > 0)

const showBatchSequentialControls = computed(() => {
  if (batchRecognitionFields.MEDIA_TYPE) {
    return batchRecognitionForm.mediaType === 'TV_SHOW'
  }
  return currentPageSelectedTasks.value.length > 0
    && currentPageSelectedTasks.value.every((task) => task.mediaType === 'TV_SHOW')
})

const hasBatchRecognitionAction = computed(() => {
  return Object.values(batchRecognitionFields).some(Boolean)
    || (showBatchSequentialControls.value && batchRecognitionForm.episodeAssignmentMode === 'SEQUENTIAL')
})

const batchRecognitionRequest = computed<QueueBatchRecognitionRequest>(() => buildBatchRecognitionRequest())

const batchRecognitionCanApply = computed(() => {
  return Boolean(batchRecognitionPreview.value?.canApply)
    && hasBatchRecognitionAction.value
    && currentPageSelectedTaskIds.value.length > 0
})

const batchSourceSummary = computed(() => {
  const tasks = currentPageSelectedTasks.value
  if (tasks.length === 0) return '-'
  if (tasks.length === 1) return tasks[0].sourcePath
  return t('queue.batchRecognition.sourceRangeSummary', {
    first: sourceFileName(tasks[0].sourcePath),
    last: sourceFileName(tasks[tasks.length - 1].sourcePath),
  })
})

const batchSourceDirCount = computed(() => {
  return new Set(currentPageSelectedTasks.value.map((task) => parentPath(task.sourcePath))).size
})

const batchWatchRuleCount = computed(() => {
  return new Set(currentPageSelectedTasks.value.map((task) => task.ruleId ?? -1)).size
})

const candidateGroups = computed(() => {
  const groups = new Map<string, { key: string, title: string, count: number, totalConfidence: number, option: QueueOption, firstIndex: number }>()
  let index = 0
  for (const task of displayedTasks.value) {
    const seenInTask = new Set<string>()
    for (const option of candidateOptionsByTask[task.id] ?? []) {
      if (seenInTask.has(option.key)) continue
      seenInTask.add(option.key)

      const group = groups.get(option.key)
      if (group) {
        group.count++
        group.totalConfidence += option.confidence ?? 0
      } else {
        groups.set(option.key, {
          key: option.key,
          title: displayTitle(option),
          count: 1,
          totalConfidence: option.confidence ?? 0,
          option,
          firstIndex: index++,
        })
      }
    }
  }

  return [...groups.values()]
    .filter((group) => group.count > 1)
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count
      const confidenceDiff = (b.totalConfidence / b.count) - (a.totalConfidence / a.count)
      if (confidenceDiff !== 0) return confidenceDiff
      return a.firstIndex - b.firstIndex
    })
})

const visibleCandidateGroups = computed(() => {
  return recommendationExpanded.value ? candidateGroups.value : candidateGroups.value.slice(0, 3)
})

const currentCandidateSummary = computed(() => {
  if (!currentCandidate.value) {
    return t('queue.noCurrentCandidate')
  }
  return t('queue.currentCandidateSummary', {
    title: displayTitle(currentCandidate.value),
    year: currentCandidate.value.year ?? t('queue.unknown'),
    mediaType: t(`task.mediaType.${currentCandidate.value.mediaType}`),
  })
})

const currentRecognitionCandidateSummary = computed(() => {
  const task = recognitionTask.value
  if (!task) return t('queue.noCurrentCandidate')
  const selected = getSelectedOption(task.id)
  const fallback = getTaskOptions(task.id)[0]
  const candidate = selected ?? fallback
  if (!candidate) return t('queue.noCurrentCandidate')
  return t('queue.currentCandidateSummary', {
    title: displayTitle(candidate),
    year: candidate.year ?? t('queue.unknown'),
    mediaType: t(`task.mediaType.${candidate.mediaType}`),
  })
})

onMounted(loadQueue)

watch([currentPage, pageSize], async () => {
  await loadCurrentPageCandidates()
})

watch(pageSize, () => {
  currentPage.value = 1
})

watch(sortedQueueTasks, () => {
  const maxPage = Math.max(1, Math.ceil(queueDirectories.value.length / pageSize.value))
  if (currentPage.value > maxPage) {
    currentPage.value = maxPage
  }
})

watch(() => recognitionForm.mediaType, (mediaType) => {
  if (mediaType === 'MOVIE') {
    recognitionForm.parsedSeason = null
    recognitionForm.parsedEpisode = null
    recognitionForm.parsedEpisodeEnd = null
  }
})

watch(showBatchSequentialControls, (visible) => {
  if (!visible) {
    batchRecognitionForm.episodeAssignmentMode = 'PRESERVE'
  }
})

watch(batchRecognitionRequest, () => {
  scheduleBatchRecognitionPreview()
}, { deep: true })

async function loadQueue() {
  await mediaStore.fetchQueue()
  await loadCurrentPageCandidates()
}

async function loadCurrentPageCandidates() {
  const tasks = displayedTasks.value
  for (let start = 0; start < tasks.length; start += 8) {
    await Promise.allSettled(tasks.slice(start, start + 8).map(task => loadCandidates(task.id)))
  }
}

async function loadCandidates(taskId: number) {
  candidateLoadingByTask[taskId] = true
  try {
    const res = await mediaApi.getTaskCandidates(taskId)
    const options = res.data.data.map(mapCandidateToOption)
    candidateOptionsByTask[taskId] = options

    const selected = options.find((option) => option.key === selectedOptionByTask[taskId])
    const backendSelected = options.find((option) =>
      res.data.data.some((candidate) => candidate.selected && option.tmdbId === candidate.tmdbId && option.mediaType === candidate.mediaType),
    )
    selectedOptionByTask[taskId] = selected?.key ?? backendSelected?.key ?? ''
  } finally {
    candidateLoadingByTask[taskId] = false
  }
}

async function handleGlobalSearch() {
  const keyword = globalSearchKeyword.value.trim()
  if (!keyword) return

  globalSearchLoading.value = true
  globalSearchPerformed.value = true
  try {
    const res = await mediaApi.searchMetadata(keyword, globalSearchMediaType.value)
    globalSearchResults.value = res.data.data
      .map(mapSearchResultToOption)
      .filter((option): option is QueueOption => option !== null)
    if (globalSearchResults.value.length > 0) {
      setCurrentCandidate(globalSearchResults.value[0])
    }
  } catch {
    ElMessage.error(t('queue.searchFailed'))
  } finally {
    globalSearchLoading.value = false
  }
}

async function handleConfirm(taskId: number) {
  const selected = getTaskOptions(taskId).find((option) => option.key === selectedOptionByTask[taskId])
  if (!selected) return
  const task = displayedTasks.value.find((item) => item.id === taskId)
  if (selected.mediaType === 'TV_SHOW' && task
    && task.parsedEpisode == null) {
    ElMessage.warning(t('queue.validation.seasonEpisodeRequired'))
    openRecognitionEditor(task)
    return
  }

  actionLoadingByTask[taskId] = true
  try {
    await mediaStore.confirmTask(taskId, selected.tmdbId, selected.mediaType)
    ElMessage.success(t('queue.confirmSuccess'))
  } finally {
    actionLoadingByTask[taskId] = false
  }
}

async function handleSkip(taskId: number) {
  try {
    await ElMessageBox.confirm(t('queue.skipConfirm'), t('queue.skipTitle'), {
      confirmButtonText: t('queue.skip'),
      cancelButtonText: t('common.cancel'),
      type: 'warning',
    })
  } catch {
    return
  }

  actionLoadingByTask[taskId] = true
  try {
    await mediaStore.skipTask(taskId)
    ElMessage.success(t('queue.skipSuccess'))
  } finally {
    actionLoadingByTask[taskId] = false
  }
}

function selectCurrentPageTasks() {
  for (const task of displayedTasks.value) {
    selectedTaskIds.add(task.id)
  }
}

function quickSelectCandidateGroup(groupKey: string) {
  for (const task of displayedTasks.value) {
    const option = (candidateOptionsByTask[task.id] ?? []).find((item) => item.key === groupKey)
    if (option) {
      selectedTaskIds.add(task.id)
      selectedOptionByTask[task.id] = option.key
      manualSelectedTaskIds.add(task.id)
      delete batchErrorByTask[task.id]
    }
  }
}

function setCurrentCandidate(option: QueueOption) {
  currentCandidate.value = option
}

async function applyCurrentCandidateToSelectedTasks() {
  const candidate = currentCandidate.value
  if (!candidate) {
    ElMessage.warning(t('queue.selectCandidateFirst'))
    return
  }

  const selectedTasks = displayedTasks.value.filter((task) => selectedTaskIds.has(task.id))
  if (selectedTasks.length === 0) {
    ElMessage.warning(t('queue.selectTasksFirst'))
    return
  }

  const mismatched = selectedTasks.filter((task) => task.mediaType && task.mediaType !== candidate.mediaType)
  if (mismatched.length > 0) {
    ElMessage.warning(t('queue.mediaTypeMismatch'))
    return
  }

  const overwriteCount = selectedTasks.filter((task) => Boolean(selectedOptionByTask[task.id])).length
  if (overwriteCount > 0) {
    try {
      await ElMessageBox.confirm(
        t('queue.overwriteCandidateConfirm', { count: overwriteCount }),
        t('queue.overwriteCandidateTitle'),
        {
          confirmButtonText: t('common.confirm'),
          cancelButtonText: t('common.cancel'),
          type: 'warning',
        },
      )
    } catch {
      return
    }
  }

  for (const task of selectedTasks) {
    ensureSearchOptionForTask(task.id, candidate)
    selectedOptionByTask[task.id] = candidate.key
    manualSelectedTaskIds.add(task.id)
    delete batchErrorByTask[task.id]
  }
}

function clearCurrentPageSelection() {
  for (const task of displayedTasks.value) {
    selectedTaskIds.delete(task.id)
    selectedOptionByTask[task.id] = ''
    manualSelectedTaskIds.delete(task.id)
  }
}

function markManualSelection(taskId: number) {
  selectedTaskIds.add(taskId)
  manualSelectedTaskIds.add(taskId)
  delete batchErrorByTask[taskId]
}

function toggleTaskSelection(taskId: number, checked: boolean) {
  if (checked) {
    selectedTaskIds.add(taskId)
  } else {
    selectedTaskIds.delete(taskId)
  }
}

async function handleBatchConfirm() {
  const items = currentPageBatchItems.value
  if (items.length === 0) return

  const lowConfidenceCount = displayedTasks.value.filter((task) => {
    const selected = getSelectedOption(task.id)
    return selected && (selected.confidence == null || selected.confidence < 0.6)
  }).length

  try {
    await ElMessageBox.confirm(
      t('queue.batchConfirmMessage', { count: items.length, lowConfidenceCount }),
      t('queue.batchConfirmTitle'),
      {
        confirmButtonText: t('queue.batchConfirmAction'),
        cancelButtonText: t('common.cancel'),
        type: 'warning',
      },
    )
  } catch {
    return
  }

  batchConfirming.value = true
  try {
    for (const item of items) {
      delete batchErrorByTask[item.taskId]
    }

    const res = await mediaApi.batchConfirm(items)
    const results = res.data.data.results
    const successCount = results.filter((result) => result.success).length
    const failedResults = results.filter((result) => !result.success)
    for (const result of failedResults) {
      batchErrorByTask[result.taskId] = result.message || t('queue.batchConfirmUnknownError')
    }

    ElMessage.success(t('queue.batchConfirmResult', { success: successCount, failed: failedResults.length }))
    await loadQueue()
  } finally {
    batchConfirming.value = false
  }
}

async function handleBatchSkip() {
  const taskIds = currentPageSelectedTaskIds.value
  if (taskIds.length === 0) return

  try {
    await ElMessageBox.confirm(
      t('queue.batchSkipConfirm', { count: taskIds.length }),
      t('queue.batchSkipTitle'),
      {
        confirmButtonText: t('queue.batchSkipAction'),
        cancelButtonText: t('common.cancel'),
        type: 'warning',
      },
    )
  } catch {
    return
  }

  batchSkipping.value = true
  try {
    let successCount = 0
    let failedCount = 0
    for (const taskId of taskIds) {
      try {
        await mediaStore.skipTask(taskId)
        selectedTaskIds.delete(taskId)
        selectedOptionByTask[taskId] = ''
        manualSelectedTaskIds.delete(taskId)
        successCount++
      } catch (error) {
        failedCount++
        batchErrorByTask[taskId] = error instanceof Error ? error.message : t('queue.batchSkipUnknownError')
      }
    }

    ElMessage.success(t('queue.batchSkipResult', { success: successCount, failed: failedCount }))
    await loadQueue()
  } finally {
    batchSkipping.value = false
  }
}

function openBatchRecognitionEditor() {
  if (currentPageSelectedTaskIds.value.length === 0) {
    ElMessage.warning(t('queue.selectTasksFirst'))
    return
  }

  resetBatchRecognitionForm()
  batchRecognitionDialogVisible.value = true
  scheduleBatchRecognitionPreview()
}

function resetBatchRecognitionForm() {
  batchRecognitionFields.MEDIA_TYPE = false
  batchRecognitionFields.PARSED_TITLE = false
  batchRecognitionFields.PARSED_YEAR = false
  batchRecognitionFields.PARSED_SEASON = false

  const tasks = currentPageSelectedTasks.value
  batchRecognitionForm.mediaType = commonValue(tasks.map((task) => task.mediaType)) ?? 'TV_SHOW'
  batchRecognitionForm.parsedTitle = commonValue(tasks.map((task) => task.parsedTitle)) ?? ''
  batchRecognitionForm.parsedYear = commonValue(tasks.map((task) => task.parsedYear))
  batchRecognitionForm.parsedSeason = commonValue(tasks.map((task) => task.parsedSeason))
  batchRecognitionForm.episodeAssignmentMode = 'PRESERVE'
  batchRecognitionForm.episodeStart = 1
  batchRecognitionForm.episodeSortDirection = 'ASC'
  batchRecognitionPreview.value = null
}

function commonValue<T>(values: Array<T | null | undefined>) {
  const [first] = values
  if (values.length === 0) return null
  return values.every((value) => value === first) ? (first ?? null) : null
}

function buildBatchRecognitionRequest(): QueueBatchRecognitionRequest {
  const updateFields = (Object.entries(batchRecognitionFields) as Array<[BatchRecognitionField, boolean]>)
    .filter(([, enabled]) => enabled)
    .map(([field]) => field)
  const sequentialEnabled = showBatchSequentialControls.value
    && batchRecognitionForm.episodeAssignmentMode === 'SEQUENTIAL'
  const request: QueueBatchRecognitionRequest = {
    taskIds: currentPageSelectedTaskIds.value,
    updateFields,
    episodeAssignmentMode: sequentialEnabled ? 'SEQUENTIAL' : 'PRESERVE',
    episodeStart: sequentialEnabled ? batchRecognitionForm.episodeStart : null,
    episodeSortDirection: sequentialEnabled ? batchRecognitionForm.episodeSortDirection : 'ASC',
  }
  if (batchRecognitionFields.MEDIA_TYPE) {
    request.mediaType = batchRecognitionForm.mediaType
  }
  if (batchRecognitionFields.PARSED_TITLE) {
    request.parsedTitle = batchRecognitionForm.parsedTitle
  }
  if (batchRecognitionFields.PARSED_YEAR) {
    request.parsedYear = batchRecognitionForm.parsedYear
  }
  if (batchRecognitionFields.PARSED_SEASON) {
    request.parsedSeason = batchRecognitionForm.parsedSeason
  }
  return request
}

function scheduleBatchRecognitionPreview() {
  if (!batchRecognitionDialogVisible.value) return
  batchRecognitionPreviewLoading.value = true
  if (batchRecognitionPreviewTimer) {
    window.clearTimeout(batchRecognitionPreviewTimer)
  }
  batchRecognitionPreviewTimer = window.setTimeout(() => {
    void loadBatchRecognitionPreview()
  }, 250)
}

async function loadBatchRecognitionPreview() {
  if (!batchRecognitionDialogVisible.value) return

  const requestId = ++batchRecognitionPreviewRequestId
  batchRecognitionPreviewLoading.value = true
  try {
    const res = await mediaApi.previewBatchRecognition(batchRecognitionRequest.value)
    if (requestId === batchRecognitionPreviewRequestId) {
      batchRecognitionPreview.value = res.data.data
    }
  } catch {
    if (requestId === batchRecognitionPreviewRequestId) {
      batchRecognitionPreview.value = null
    }
  } finally {
    if (requestId === batchRecognitionPreviewRequestId) {
      batchRecognitionPreviewLoading.value = false
    }
  }
}

async function handleSaveBatchRecognition() {
  await submitBatchRecognition(false)
}

async function handleSaveBatchRecognitionAndRematch() {
  await submitBatchRecognition(true)
}

async function submitBatchRecognition(rematch: boolean) {
  if (!batchRecognitionCanApply.value) return

  batchRecognitionActionLoading.value = rematch ? 'rematch' : 'save'
  const taskIds = [...currentPageSelectedTaskIds.value]
  try {
    const request = batchRecognitionRequest.value
    if (rematch) {
      const res = await mediaApi.rematchBatchRecognition(request)
      const result = res.data.data
      clearBatchRecognitionSelections(taskIds)
      ElMessage.success(t('queue.batchRecognition.rematchSuccess', {
        updated: result.updatedCount,
        matched: result.matchedCount,
        empty: result.emptyCount,
        failed: result.failedCount,
      }))
    } else {
      const res = await mediaApi.updateBatchRecognition(request)
      clearBatchRecognitionSelections(taskIds)
      ElMessage.success(t('queue.batchRecognition.saveSuccess', { count: res.data.data.updatedCount }))
    }
    batchRecognitionDialogVisible.value = false
    await loadQueue()
  } catch {
    ElMessage.error(rematch ? t('queue.batchRecognition.rematchFailed') : t('queue.batchRecognition.saveFailed'))
  } finally {
    batchRecognitionActionLoading.value = null
  }
}

function clearBatchRecognitionSelections(taskIds: number[]) {
  for (const taskId of taskIds) {
    selectedOptionByTask[taskId] = ''
    searchOptionsByTask[taskId] = []
    manualSelectedTaskIds.delete(taskId)
    delete batchErrorByTask[taskId]
  }
  currentCandidate.value = null
}

function openRecognitionEditor(task: MediaTask) {
  recognitionTask.value = task
  recognitionForm.mediaType = task.mediaType ?? 'MOVIE'
  recognitionForm.parsedTitle = task.parsedTitle ?? ''
  recognitionForm.parsedYear = task.parsedYear
  recognitionForm.parsedSeason = task.mediaType === 'TV_SHOW' ? resolveEpisodeSeason(task) : task.parsedSeason
  recognitionForm.parsedEpisode = task.parsedEpisode
  recognitionForm.parsedEpisodeEnd = task.parsedEpisodeEnd
  globalSearchMediaType.value = recognitionForm.mediaType
  if (recognitionForm.parsedTitle) {
    globalSearchKeyword.value = recognitionForm.parsedTitle
  }
  recognitionDrawerVisible.value = true
}

async function handleSaveRecognition() {
  await submitRecognition(false)
}

async function handleSaveRecognitionAndRematch() {
  await submitRecognition(true)
}

async function handleCodexRecognition(selectedTask?: MediaTask) {
  const task = selectedTask ?? recognitionTask.value
  if (!task) return
  recognitionActionLoading.value = 'codex'
  codexTaskId.value = task.id
  try {
    const res = await mediaApi.codexRematchTask(task.id)
    applyRecognitionResponse(task.id, res.data.data, true)
    if (recognitionDrawerVisible.value) openRecognitionEditor(res.data.data.task)
    ElMessage.success(t('queue.codexRematchSuccess'))
  } catch {
    // HTTP 层已展示失败原因；保留当前候选和文件。
  } finally {
    recognitionActionLoading.value = null
    codexTaskId.value = null
  }
}

function directoryOptions(group: DirectoryGroup) {
  return commonDirectoryOptions(group.tasks, getTaskOptions)
}

function toggleDirectoryDetails(key: string) {
  if (expandedDirectories.has(key)) expandedDirectories.delete(key)
  else expandedDirectories.add(key)
}

function openDirectoryReview(group: DirectoryGroup) {
  const options = directoryOptions(group)
  if (!options.length) {
    ElMessage.warning(t('queue.directory.noCommonCandidate'))
    return
  }
  directoryReviewPath.value = group.directory
  directoryReviewOptions.value = options
  const selected = getSelectedOption(group.tasks[0].id)
  const sharedSelection = selected && group.tasks.every(task => getSelectedOption(task.id)?.key === selected.key)
  directoryReviewChoice.value = sharedSelection ? selected.key : (options.length === 1 ? options[0].key : '')
  directoryReviewRows.value = group.tasks.map(task => ({
    taskId: task.id, task, included: true, error: '',
    season: resolveEpisodeSeason(task), episode: task.parsedEpisode, episodeEnd: task.parsedEpisodeEnd,
  }))
  const seasons = new Set(directoryReviewRows.value.map(row => row.season))
  directoryReviewSeason.value = seasons.size === 1 ? (directoryReviewRows.value[0].season ?? undefined) : undefined
  directoryReviewVisible.value = true
}

function closeDirectoryReview(done: () => void) {
  if (!directorySubmitting.value) done()
}

function applyDirectorySeason() {
  if (directoryReviewSeason.value == null) return
  for (const row of directoryIncludedRows.value) row.season = directoryReviewSeason.value
}

async function confirmDirectory() {
  const option = directorySelectedOption.value
  if (!option || directoryReviewIssue.value || directorySubmitting.value) return
  const rows = [...directoryIncludedRows.value]
  if (!rows.length) return
  directorySubmitting.value = true
  const failed = new Set<number>()
  try {
    for (const row of rows) {
      row.error = ''
      delete batchErrorByTask[row.taskId]
    }
    const results = await submitDirectoryConfirmation(rows, option, {
      findTask: id => queueTasks.value.find(task => task.id === id),
      save: async (id, request) => {
        const res = await mediaApi.updateTaskRecognition(id, request)
        mediaStore.updateTask(res.data.data.task)
      },
      confirm: async items => (await mediaApi.batchConfirm(items)).data.data.results,
    }, {
      stateChanged: t('queue.directory.stateChanged'),
      saveFailed: t('queue.recognitionSaveFailed'),
      confirmFailed: t('queue.batchConfirmUnknownError'),
    })
    let submitted = 0
    for (const result of results) {
      if (result.success) {
        submitted++
        mediaStore.updateTaskStatus(result.taskId, 'PROCESSING')
        selectedTaskIds.delete(result.taskId)
        selectedOptionByTask[result.taskId] = ''
        manualSelectedTaskIds.delete(result.taskId)
      } else {
        failed.add(result.taskId)
        const row = rows.find(row => row.taskId === result.taskId)!
        row.error = result.message || t('queue.batchConfirmUnknownError')
        batchErrorByTask[result.taskId] = row.error
      }
    }
    const message = t('queue.directory.submitted', { success: submitted, failed: failed.size })
    if (failed.size) {
      directoryReviewRows.value = rows.filter(row => failed.has(row.taskId))
      ElMessage.warning(message)
    } else {
      directoryReviewVisible.value = false
      ElMessage.success(message)
    }
    await loadQueue()
  } catch {
    // 保留确认面板与输入；刷新实际状态，已被接收的任务不会再次提交。
    await loadQueue()
    directoryReviewRows.value = directoryReviewRows.value.filter(row => queueTasks.value.some(task => task.id === row.taskId))
    if (!directoryReviewRows.value.length) directoryReviewVisible.value = false
  } finally {
    directorySubmitting.value = false
  }
}

async function handleCodexDirectoryRecognition(task: MediaTask) {
  recognitionActionLoading.value = 'codex-directory'
  codexTaskId.value = task.id
  const editorTask = recognitionTask.value
  const editorTaskId = editorTask?.id
  try {
    const res = await mediaApi.codexRematchDirectory(task.id)
    for (const response of res.data.data.updated) {
      applyRecognitionResponse(response.task.id, response, true)
    }
    const editorResponse = res.data.data.updated.find((response) => response.task.id === editorTaskId)
    recognitionTask.value = editorResponse?.task ?? editorTask
    if (recognitionDrawerVisible.value && editorResponse) openRecognitionEditor(editorResponse.task)
    const message = t('queue.codexDirectorySuccess', {
      count: res.data.data.updated.length,
      skipped: res.data.data.skipped.length,
    })
    if (res.data.data.skipped.length) ElMessage.warning(message)
    else ElMessage.success(message)
    const updatedIds = new Set(res.data.data.updated.map(response => response.task.id))
    const group = queueDirectories.value.find(group => group.tasks.some(item => item.id === task.id))
    if (group && updatedIds.size) openDirectoryReview({ ...group, tasks: group.tasks.filter(item => updatedIds.has(item.id)) })
  } catch {
    // HTTP 层展示失败原因，原有候选继续可用。
  } finally {
    recognitionActionLoading.value = null
    codexTaskId.value = null
  }
}

async function submitRecognition(rematch: boolean) {
  const task = recognitionTask.value
  if (!task || !validateRecognitionForm()) return

  recognitionActionLoading.value = rematch ? 'rematch' : 'save'
  try {
    const request = buildRecognitionRequest()
    const res = rematch
      ? await mediaApi.rematchTaskRecognition(task.id, request)
      : await mediaApi.updateTaskRecognition(task.id, request)

    applyRecognitionResponse(task.id, res.data.data, rematch)
    globalSearchMediaType.value = request.mediaType
    globalSearchKeyword.value = request.parsedTitle
    ElMessage.success(rematch ? t('queue.rematchSuccess') : t('queue.recognitionSaveSuccess'))
    if (rematch) {
      recognitionDrawerVisible.value = false
    }
  } catch {
    ElMessage.error(rematch ? t('queue.rematchFailed') : t('queue.recognitionSaveFailed'))
  } finally {
    recognitionActionLoading.value = null
  }
}

function validateRecognitionForm() {
  if (!recognitionForm.parsedTitle.trim()) {
    ElMessage.warning(t('queue.validation.titleRequired'))
    return false
  }
  if (recognitionForm.mediaType === 'TV_SHOW'
    && (recognitionForm.parsedSeason == null || recognitionForm.parsedEpisode == null)) {
    ElMessage.warning(t('queue.validation.seasonEpisodeRequired'))
    return false
  }
  return true
}

function buildRecognitionRequest(): QueueRecognitionRequest {
  return {
    mediaType: recognitionForm.mediaType,
    parsedTitle: recognitionForm.parsedTitle.trim(),
    parsedYear: recognitionForm.parsedYear,
    parsedSeason: recognitionForm.mediaType === 'TV_SHOW' ? recognitionForm.parsedSeason : null,
    parsedEpisode: recognitionForm.mediaType === 'TV_SHOW' ? recognitionForm.parsedEpisode : null,
    parsedEpisodeEnd: recognitionForm.mediaType === 'TV_SHOW' ? recognitionForm.parsedEpisodeEnd : null,
  }
}

function applyRecognitionResponse(taskId: number, response: QueueRecognitionResponse, rematch: boolean) {
  mediaStore.updateTask(response.task)
  recognitionTask.value = response.task
  if (!rematch) return

  const options = response.candidates.map(mapCandidateToOption)
  candidateOptionsByTask[taskId] = options
  searchOptionsByTask[taskId] = []
  selectedOptionByTask[taskId] = ''
  currentCandidate.value = null
}

function getTaskOptions(taskId: number) {
  const candidates = candidateOptionsByTask[taskId] ?? []
  const searches = searchOptionsByTask[taskId] ?? []
  const seen = new Set(candidates.map((option) => option.key))
  return [...candidates, ...searches.filter((option) => !seen.has(option.key))]
}

function getSelectedOption(taskId: number) {
  return getTaskOptions(taskId).find((option) => option.key === selectedOptionByTask[taskId])
}

function ensureSearchOptionForTask(taskId: number, option: QueueOption) {
  const existing = getTaskOptions(taskId).some((item) => item.key === option.key)
  if (existing) return

  const taskSearchOptions = searchOptionsByTask[taskId] ?? []
  searchOptionsByTask[taskId] = [
    ...taskSearchOptions,
    {
      ...option,
      origin: 'search',
      rank: null,
    },
  ]
}

function taskSelectionStatus(taskId: number) {
  if (!selectedTaskIds.has(taskId)) {
    return t('queue.taskNotSelected')
  }
  if (selectedOptionByTask[taskId]) {
    return t('queue.taskSelectedWithCandidate')
  }
  return t('queue.taskSelectedWithoutCandidate')
}

function mapCandidateToOption(candidate: TaskCandidate): QueueOption {
  return {
    key: buildOptionKey(candidate.tmdbId, candidate.mediaType),
    origin: 'candidate',
    tmdbId: candidate.tmdbId,
    title: candidate.title,
    originalTitle: candidate.originalTitle,
    year: candidate.year,
    mediaType: candidate.mediaType,
    overview: candidate.overview,
    posterUrl: candidate.posterUrl,
    confidence: candidate.confidence,
    rank: candidate.rank,
  }
}

function mapSearchResultToOption(result: MatchResult): QueueOption | null {
  const tmdbId = Number.parseInt(result.sourceId, 10)
  if (Number.isNaN(tmdbId)) return null

  return {
    key: buildOptionKey(tmdbId, result.mediaType),
    origin: 'search',
    tmdbId,
    title: result.title,
    originalTitle: result.originalTitle,
    year: result.year,
    mediaType: result.mediaType,
    overview: result.overview,
    posterUrl: result.posterUrl,
    confidence: result.confidence,
    rank: null,
  }
}

function buildOptionKey(tmdbId: number, mediaType: MediaType) {
  return `${mediaType}:${tmdbId}`
}

function displayTitle(option: QueueOption) {
  return option.title || option.originalTitle || t('queue.unknownTitle')
}

function formatParsedTitle(task: MediaTask) {
  const title = task.parsedTitle || t('queue.unknownTitle')
  return task.parsedYear ? `${title} (${task.parsedYear})` : title
}

function formatSeasonEpisode(task: MediaTask) {
  if (task.parsedSeason == null && task.parsedEpisode == null) return t('queue.notApplicable')
  const parts: string[] = []
  if (task.parsedSeason != null) parts.push(t('queue.season', { season: task.parsedSeason }))
  if (task.parsedEpisode != null) {
    const episode = task.parsedEpisodeEnd != null
      ? `${task.parsedEpisode}-${task.parsedEpisodeEnd}`
      : task.parsedEpisode
    parts.push(t('queue.episodeNumber', { episode }))
  }
  return parts.join(' / ')
}

function formatPreviewEpisode(item: QueueBatchRecognitionPreviewItem, prefix: 'current' | 'effective') {
  const episode = prefix === 'current' ? item.currentEpisode : item.effectiveEpisode
  const episodeEnd = prefix === 'current' ? item.currentEpisodeEnd : item.effectiveEpisodeEnd
  if (episode == null) return '-'
  return episodeEnd != null ? `${episode}-${episodeEnd}` : `${episode}`
}

function formatPreviewMediaType(mediaType: MediaType | null | undefined) {
  return mediaType ? t(`task.mediaType.${mediaType}`) : '-'
}

function hasPreviewValueChanged<T>(current: T | null | undefined, effective: T | null | undefined) {
  return (current ?? null) !== (effective ?? null)
}

function hasPreviewEpisodeChanged(item: QueueBatchRecognitionPreviewItem) {
  return hasPreviewValueChanged(item.currentEpisode, item.effectiveEpisode)
    || hasPreviewValueChanged(item.currentEpisodeEnd, item.effectiveEpisodeEnd)
}

function hasPreviewRowChanged(item: QueueBatchRecognitionPreviewItem) {
  return hasPreviewValueChanged(item.currentMediaType, item.effectiveMediaType)
    || hasPreviewValueChanged(item.currentTitle, item.effectiveTitle)
    || hasPreviewValueChanged(item.currentYear, item.effectiveYear)
    || hasPreviewValueChanged(item.currentSeason, item.effectiveSeason)
    || hasPreviewEpisodeChanged(item)
}

function formatNullable(value: string | number | null | undefined) {
  return value == null || value === '' ? '-' : value
}

function sourceFileName(sourcePath: string) {
  const normalized = normalizeSourcePath(sourcePath)
  const index = normalized.lastIndexOf('/')
  return index >= 0 ? normalized.slice(index + 1) : normalized
}

function parentPath(sourcePath: string) {
  const normalized = normalizeSourcePath(sourcePath)
  const index = normalized.lastIndexOf('/')
  return index >= 0 ? normalized.slice(0, index) : ''
}

function normalizeSourcePath(sourcePath: string) {
  return sourcePath.replace(/\\/g, '/')
}

function compareQueueTaskByFileNameAsc(a: MediaTask, b: MediaTask) {
  const fileNameCompare = queueFileNameCollator.compare(sourceFileName(a.sourcePath), sourceFileName(b.sourcePath))
  if (fileNameCompare !== 0) return fileNameCompare

  const sourcePathCompare = queueFileNameCollator.compare(normalizeSourcePath(a.sourcePath), normalizeSourcePath(b.sourcePath))
  if (sourcePathCompare !== 0) return sourcePathCompare

  return a.id - b.id
}

function formatResolution(task: MediaTask) {
  return task.parsedResolution || t('queue.unknown')
}

function formatConfidence(confidence: number | null) {
  return confidence == null ? t('queue.unknown') : `${(confidence * 100).toFixed(0)}%`
}

function assetTypeTagType(assetType: MediaAssetType | null | undefined) {
  const map: Record<MediaAssetType, 'primary' | 'warning' | 'info'> = {
    VIDEO_FILE: 'info',
    ISO_IMAGE: 'warning',
    BLURAY_DIRECTORY: 'primary',
  }
  return map[assetType || 'VIDEO_FILE']
}

</script>

<style scoped>
.queue-view {
  padding: 24px;
}

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 24px;
}

h2 {
  margin: 0;
  font-size: 22px;
  color: #303133;
}

.page-desc {
  margin: 8px 0 0;
  color: #909399;
  font-size: 14px;
}

.queue-list {
  display: grid;
  grid-template-columns: 1fr;
  gap: 18px;
  min-height: 160px;
}

.global-search-panel {
  padding: 16px;
  border: 1px solid #d9ecff;
  border-radius: 14px;
  background: #f8fbff;
}

.panel-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.panel-header h3 {
  margin: 0 0 6px;
  color: #303133;
  font-size: 16px;
}

.panel-header p {
  margin: 0;
  color: #606266;
  font-size: 13px;
}

.global-search-body {
  margin-top: 14px;
}

.global-search-row {
  display: grid;
  grid-template-columns: 160px minmax(0, 1fr) auto;
  gap: 10px;
  margin-bottom: 14px;
}

.media-type-select {
  width: 160px;
}

.global-result-list {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.global-result-card {
  display: flex;
  gap: 12px;
  min-width: 0;
  padding: 12px;
  border: 1px solid #e4e7ed;
  border-radius: 12px;
  background: #fff;
  cursor: pointer;
  text-align: left;
}

.global-result-card.is-selected {
  border-color: #409eff;
  box-shadow: 0 0 0 2px rgba(64, 158, 255, 0.14);
}

.batch-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 14px 16px;
  border: 1px solid #ebeef5;
  border-radius: 12px;
  background: #fafbfc;
}

.batch-actions,
.candidate-groups {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.batch-actions :deep(.el-button + .el-button),
.candidate-groups :deep(.el-button + .el-button) {
  margin-left: 0;
}

.batch-divider {
  height: 24px;
  margin: 0 4px;
}

.button-help-icon {
  margin-left: 6px;
  font-size: 14px;
}

.candidate-groups {
  flex-direction: column;
}

.candidate-groups :deep(.el-alert__title span) {
  margin-right: 8px;
}

.directory-advanced > summary { cursor: pointer; color: #909399; font-size: 13px; }
.directory-advanced[open] > summary { margin-bottom: 14px; }
.directory-advanced .batch-toolbar { margin-top: 12px; }
.directory-card {
  border-radius: 14px;
  border-color: #dce5f0;
}
.directory-header, .directory-heading, .directory-actions, .directory-season-row, .directory-review-footer {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.directory-header, .directory-review-footer { justify-content: space-between; }
.directory-heading { min-width: 0; flex: 1; }
.directory-heading > div { min-width: 0; }
.directory-heading h3, .directory-identity h3 { margin: 0 0 6px; font-size: 17px; }
.directory-path { color: #909399; font-size: 12px; overflow-wrap: anywhere; }
.directory-identity { display: flex; align-items: center; gap: 16px; margin-bottom: 16px; }
.directory-identity p { color: #909399; font-size: 13px; margin: 8px 0; }
.directory-poster { width: 60px; height: 90px; border-radius: 6px; flex-shrink: 0; }
.directory-evidence { color: #909399; font-size: 12px; margin-top: 14px; overflow-wrap: anywhere; }
.directory-evidence summary { cursor: pointer; }
.directory-season-row { margin-bottom: 16px; }
.directory-coordinate { width: 112px; }
.directory-review-footer { gap: 16px; }

.queue-card {
  border: 1px solid #e4e7ed;
  border-radius: 14px;
  transition:
    box-shadow 0.18s ease,
    transform 0.18s ease,
    border-color 0.18s ease;
}

.queue-card:hover {
  border-color: #c6e2ff;
  box-shadow: 0 10px 26px rgba(64, 158, 255, 0.1);
  transform: translateY(-2px);
}

.card-header {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
}

.file-path {
  flex: 1 1 240px;
  min-width: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: #f5f7fa;
  color: #606266;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.header-tags {
  display: flex;
  flex-wrap: wrap;
  flex-shrink: 1;
  gap: 8px;
}

.task-meta {
  margin-bottom: 18px;
}

.search-row {
  display: flex;
  gap: 10px;
  margin-bottom: 18px;
}

.candidate-section {
  padding: 16px;
  border: 1px solid #ebeef5;
  border-radius: 12px;
  background: #fbfcff;
}

.section-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  color: #303133;
  font-weight: 600;
}

.candidate-list {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 16px;
  width: 100%;
}

.candidate-option {
  height: auto;
  margin: 0;
  padding: 0;
  border-radius: 12px;
  background: #fff;
  overflow: hidden;
}

.candidate-option :deep(.el-radio__input) {
  align-self: flex-start;
  padding: 16px 0 0 14px;
}

.candidate-option :deep(.el-radio__label) {
  width: 100%;
  padding: 0;
}

.candidate-content {
  display: flex;
  gap: 14px;
  min-width: 0;
  padding: 14px;
}

.poster {
  width: 78px;
  height: 116px;
  flex-shrink: 0;
  border-radius: 8px;
  background: #eef0f4;
}

.poster--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 8px;
  color: #a8abb2;
  font-size: 12px;
  text-align: center;
}

.candidate-info {
  min-width: 0;
  flex: 1;
  overflow: hidden;
}

.candidate-title-row {
  display: flex;
  align-items: center;
  margin-bottom: 6px;
  min-width: 0;
}

.candidate-title {
  display: block;
  width: 100%;
  overflow: hidden;
  color: #303133;
  font-size: 15px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.candidate-tag-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 8px;
  min-width: 0;
}

.candidate-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 8px;
  color: #909399;
  font-size: 12px;
}

.overview {
  display: -webkit-box;
  margin: 0;
  overflow: hidden;
  color: #606266;
  font-size: 13px;
  line-height: 1.55;
  white-space: normal;
  overflow-wrap: anywhere;
  word-break: break-word;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
}

.actions {
  margin-top: 16px;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
}

.actions :deep(.el-button + .el-button) {
  margin-left: 0;
}

.pagination-row {
  display: flex;
  justify-content: flex-end;
  margin-top: 4px;
}

.recognition-form {
  display: grid;
  gap: 2px;
}

.recognition-field {
  width: 100%;
}

.drawer-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

:global(.el-dialog.batch-recognition-dialog),
:global(.batch-recognition-dialog .el-dialog) {
  display: flex;
  flex-direction: column;
  max-height: min(86vh, 760px);
  height: min(86vh, 760px);
  overflow: hidden;
}

:global(.el-dialog.batch-recognition-dialog .el-dialog__body),
:global(.batch-recognition-dialog .el-dialog .el-dialog__body) {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding-bottom: 12px;
}

:global(.el-dialog.batch-recognition-dialog .el-dialog__footer),
:global(.batch-recognition-dialog .el-dialog .el-dialog__footer) {
  flex: 0 0 auto;
}

.batch-recognition-layout {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 14px;
  height: 100%;
  min-height: 0;
}

.batch-recognition-main {
  display: grid;
  grid-template-columns: minmax(300px, 0.75fr) minmax(0, 1.25fr);
  gap: 14px;
  align-items: stretch;
  min-height: 0;
}

.batch-recognition-section {
  min-width: 0;
  min-height: 0;
  padding: 16px;
  border: 1px solid #e4e7ed;
  border-radius: 8px;
  background: #fff;
  box-shadow: 0 8px 22px rgba(31, 45, 61, 0.06);
}

.batch-recognition-summary {
  background: #f8fbff;
}

.batch-recognition-main > .batch-recognition-section:first-child {
  overflow: auto;
}

.batch-preview-section {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.batch-section-header {
  display: flex;
  flex: 0 0 auto;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 14px;
}

.batch-section-header h3 {
  margin: 0 0 4px;
  color: #303133;
  font-size: 16px;
}

.batch-section-header p,
.sequence-switch-row p {
  margin: 0;
  color: #909399;
  font-size: 13px;
  line-height: 1.5;
}

.batch-field-grid {
  display: grid;
  gap: 12px;
}

.batch-field {
  display: grid;
  grid-template-columns: 120px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  padding: 10px;
  border: 1px solid #ebeef5;
  border-radius: 8px;
  background: #fbfcff;
}

.batch-field.is-disabled {
  background: #f5f7fa;
  color: #909399;
}

.batch-field-control {
  width: 100%;
}

.sequence-panel {
  margin-top: 14px;
  padding: 12px;
  border-radius: 8px;
  background: #f7fbf6;
  box-shadow: inset 0 0 0 1px #e1f3d8;
}

.sequence-switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.sequence-controls {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 12px;
  margin-top: 12px;
}

.sequence-controls :deep(.el-form-item) {
  margin-bottom: 0;
}

.preview-tags,
.preview-message-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.batch-alert {
  flex: 0 0 auto;
  margin-bottom: 8px;
}

.batch-preview-table {
  flex: 1;
  min-height: 0;
  width: 100%;
}

.mono-text {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
}

.change-arrow {
  margin: 0 6px;
  color: #a8abb2;
}

.dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

@media (max-width: 760px) {
  .page-header,
  .card-header,
  .global-search-row,
  .batch-toolbar {
    flex-direction: column;
    align-items: stretch;
  }

  .global-search-row {
    display: flex;
  }

  .batch-recognition-main,
  .sequence-controls {
    grid-template-columns: 1fr;
  }

  .batch-field {
    grid-template-columns: 1fr;
  }

  .media-type-select {
    width: 100%;
  }

  .header-tags {
    flex-wrap: wrap;
  }
}

@media (max-width: 1100px) {
  .global-result-list,
  .candidate-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 760px) {
  .global-result-list,
  .candidate-list {
    grid-template-columns: 1fr;
  }
}
</style>
