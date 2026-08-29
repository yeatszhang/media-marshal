<template>
  <div class="dashboard">
    <h2>{{ t('dashboard.title') }}</h2>

    <!-- 统计卡片 -->
    <div class="stat-cards">
      <el-card shadow="never">
        <el-statistic :title="t('dashboard.totalTasks')" :value="tasks.length" />
      </el-card>
      <el-card shadow="never">
        <el-statistic :title="t('dashboard.doneTasks')" :value="doneTasks.length">
          <template #suffix><span style="color: #67c23a">✓</span></template>
        </el-statistic>
      </el-card>
      <el-card shadow="never">
        <el-statistic :title="t('dashboard.awaitingTasks')" :value="queueTasks.length">
          <template #suffix><span style="color: #e6a23c">!</span></template>
        </el-statistic>
      </el-card>
      <el-card shadow="never">
        <el-statistic :title="t('dashboard.skippedTasks')" :value="skippedTasks.length">
          <template #suffix><span style="color: #909399">-</span></template>
        </el-statistic>
      </el-card>
      <el-card shadow="never">
        <el-statistic :title="t('dashboard.failedTasks')" :value="failedTasks.length">
          <template #suffix><span style="color: #f56c6c">✗</span></template>
        </el-statistic>
      </el-card>
    </div>

    <!-- 最近任务列表 -->
    <el-card shadow="never" class="task-table-card">
      <template #header>
        <div class="card-header">
          <span>{{ t('dashboard.recentTasks') }}</span>
          <div class="header-actions">
            <el-select v-model="assetTypeFilter" size="small" class="dashboard-filter">
              <el-option :label="t('dashboard.allAssetTypes')" value="ALL" />
              <el-option
                v-for="assetType in assetTypeOptions"
                :key="assetType"
                :label="t(`task.assetType.${assetType}`)"
                :value="assetType"
              />
            </el-select>
            <el-select v-model="mediaTypeFilter" size="small" class="dashboard-filter">
              <el-option :label="t('dashboard.allMediaTypes')" value="ALL" />
              <el-option
                v-for="mediaType in mediaTypeOptions"
                :key="mediaType"
                :label="t(`task.mediaType.${mediaType}`)"
                :value="mediaType"
              />
            </el-select>
            <el-select v-model="statusFilter" size="small" class="dashboard-filter">
              <el-option :label="t('dashboard.allStatuses')" value="ALL" />
              <el-option
                v-for="status in statusOptions"
                :key="status"
                :label="t(`task.status.${status}`)"
                :value="status"
              />
            </el-select>
            <el-button
              size="small"
              type="danger"
              :disabled="selectedTasks.length === 0"
              :loading="batchDeleting"
              @click="handleBatchDelete"
            >
              {{ t('dashboard.batchDelete') }}
            </el-button>
            <el-button size="small" @click="fetchTasks()">{{ t('common.refresh') }}</el-button>
          </div>
        </div>
      </template>
      <el-table
        :data="displayedTasks"
        v-loading="loading"
        stripe
        @selection-change="handleSelectionChange"
      >
        <el-table-column type="selection" width="42" />
        <el-table-column prop="sourcePath" :label="t('dashboard.file')" min-width="300" show-overflow-tooltip>
          <template #header>
            <div class="searchable-column-header">
              <el-input
                v-if="fileNameSearchActive"
                ref="fileNameSearchInputRef"
                v-model="fileNameKeyword"
                size="small"
                clearable
                class="table-header-search-input"
                :placeholder="t('dashboard.fileSearchPlaceholder')"
                @input="handleFileNameSearchInput"
                @clear="resetFileNameSearch"
              />
              <template v-else>
                <span>{{ t('dashboard.file') }}</span>
                <el-tooltip :content="t('dashboard.fileSearch')" placement="top">
                  <el-button
                    link
                    size="small"
                    class="table-header-search-button"
                    :icon="Search"
                    :aria-label="t('dashboard.fileSearch')"
                    @click.stop="activateFileNameSearch"
                  />
                </el-tooltip>
              </template>
            </div>
          </template>
        </el-table-column>
        <el-table-column prop="assetType" :label="t('dashboard.assetType')" width="110">
          <template #default="{ row }">
            <el-tag :type="assetTypeTagType(row.assetType)" size="small">
              {{ t(`task.assetType.${row.assetType || 'VIDEO_FILE'}`) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="mediaType" :label="t('dashboard.mediaType')" width="80">
          <template #default="{ row }">
            {{ row.mediaType ? t(`task.mediaType.${row.mediaType}`) : '-' }}
          </template>
        </el-table-column>
        <el-table-column prop="status" :label="t('dashboard.status')" width="120">
          <template #default="{ row }">
            <el-tooltip
              v-if="row.status === 'DONE' && row.targetPath"
              :content="row.targetPath"
              placement="top"
            >
              <el-tag :type="statusTagType(row.status)" size="small">
                {{ t(`task.status.${row.status}`) }}
              </el-tag>
            </el-tooltip>
            <el-tag v-else :type="statusTagType(row.status)" size="small">
              {{ t(`task.status.${row.status}`) }}
            </el-tag>
          </template>
        </el-table-column>
        <el-table-column prop="confirmedTitle" :label="t('dashboard.matchedTitle')" width="200" show-overflow-tooltip>
          <template #header>
            <div class="searchable-column-header">
              <el-input
                v-if="matchedTitleSearchActive"
                ref="matchedTitleSearchInputRef"
                v-model="matchedTitleKeyword"
                size="small"
                clearable
                class="table-header-search-input"
                :placeholder="t('dashboard.matchedTitleSearchPlaceholder')"
                @input="handleMatchedTitleSearchInput"
                @clear="resetMatchedTitleSearch"
              />
              <template v-else>
                <span>{{ t('dashboard.matchedTitle') }}</span>
                <el-tooltip :content="t('dashboard.matchedTitleSearch')" placement="top">
                  <el-button
                    link
                    size="small"
                    class="table-header-search-button"
                    :icon="Search"
                    :aria-label="t('dashboard.matchedTitleSearch')"
                    @click.stop="activateMatchedTitleSearch"
                  />
                </el-tooltip>
              </template>
            </div>
          </template>
        </el-table-column>
        <el-table-column :label="t('dashboard.details')" width="280" show-overflow-tooltip>
          <template #default="{ row }">
            <div v-if="row.status === 'FAILED'" class="failure-detail">
              <el-tag type="danger" size="small" effect="plain">
                {{ t('dashboard.failureCount', { count: normalizedFailureCount(row) }) }}
              </el-tag>
              <span class="detail-message">{{ taskDetails(row) }}</span>
            </div>
            <span v-else>{{ taskDetails(row) }}</span>
          </template>
        </el-table-column>
        <el-table-column prop="matchConfidence" :label="t('dashboard.confidence')" width="90">
          <template #default="{ row }">
            {{ row.matchConfidence != null ? (row.matchConfidence * 100).toFixed(0) + '%' : '-' }}
          </template>
        </el-table-column>
        <el-table-column prop="createdAt" :label="t('dashboard.createdAt')" width="130">
          <template #default="{ row }">
            <div class="created-time">
              <span>{{ formatCreatedAt(row.createdAt).date }}</span>
              <span>{{ formatCreatedAt(row.createdAt).time }}</span>
            </div>
          </template>
        </el-table-column>
        <el-table-column :label="t('common.actions')" width="150" fixed="right">
          <template #default="{ row }">
            <el-tooltip
              v-if="row.status === 'DONE' && row.assetType === 'ISO_IMAGE'"
              :content="t('dashboard.correction.isoUnsupported')"
              placement="top"
            >
              <span>
                <el-button link type="warning" size="small" :icon="EditPen" disabled>
                  {{ t('dashboard.correction.action') }}
                </el-button>
              </span>
            </el-tooltip>
            <el-button
              v-else-if="row.status === 'DONE'"
              link
              type="warning"
              size="small"
              :icon="EditPen"
              @click="openCorrectionDialog(row)"
            >
              {{ t('dashboard.correction.action') }}
            </el-button>
            <el-button
              link
              type="danger"
              size="small"
              :loading="deletingId === row.id"
              @click="handleDeleteTask(row)"
            >
              {{ t('common.delete') }}
            </el-button>
          </template>
        </el-table-column>
      </el-table>
      <div class="pagination-row">
        <el-pagination
          v-model:current-page="currentPage"
          v-model:page-size="pageSize"
          :page-sizes="[10, 20, 50, 100]"
          :total="filteredTasks.length"
          layout="total, sizes, prev, pager, next"
        />
      </div>
    </el-card>

    <el-dialog
      v-model="correctionDialogVisible"
      :title="t('dashboard.correction.title')"
      width="min(1180px, calc(100vw - 64px))"
      align-center
      destroy-on-close
      class="correction-dialog"
    >
      <div v-if="correctionTask" class="correction-layout">
        <section v-if="correctionBatch" class="correction-section batch-progress-section">
          <div class="batch-progress-header">
            <div>
              <h3>{{ t('dashboard.correction.batchProgressTitle', { id: correctionBatch.id }) }}</h3>
              <span class="batch-progress-subtitle">
                {{ t(`dashboard.correction.scope.${correctionBatch.scope}`) }} · {{ correctionBatch.parsedTitle }}
              </span>
            </div>
            <el-tag :type="batchStatusTagType(correctionBatch.status)" effect="dark">
              {{ t(`dashboard.correction.batchStatus.${correctionBatch.status}`) }}
            </el-tag>
          </div>
          <el-progress
            :percentage="batchProgressPercentage"
            :status="batchProgressStatus"
            :stroke-width="14"
          />
          <div class="batch-summary-grid">
            <div class="batch-summary-card">
              <strong>{{ batchProcessedCount }} / {{ correctionBatch.totalCount }}</strong>
              <span>{{ t('dashboard.correction.processedCount') }}</span>
            </div>
            <div class="batch-summary-card success">
              <strong>{{ correctionBatch.successCount }}</strong>
              <span>{{ t('dashboard.correction.successCount') }}</span>
            </div>
            <div class="batch-summary-card danger">
              <strong>{{ correctionBatch.failedCount }}</strong>
              <span>{{ t('dashboard.correction.failedCount') }}</span>
            </div>
            <div class="batch-summary-card muted">
              <strong>{{ correctionBatch.excludedCount }}</strong>
              <span>{{ t('dashboard.correction.excludedCount') }}</span>
            </div>
          </div>
          <el-alert
            v-if="correctionBatch.currentItem"
            type="info"
            :title="t('dashboard.correction.currentProcessing', { episode: formatEpisode(correctionBatch.currentItem) })"
            :description="correctionBatch.currentItem.currentTargetPath"
            show-icon
            :closable="false"
          />
          <el-alert
            v-if="correctionBatch.errorMessage"
            type="error"
            :title="correctionBatch.errorMessage"
            show-icon
            :closable="false"
          />
          <el-table :data="correctionBatch.items" size="small" border row-key="id" max-height="430">
            <el-table-column :label="t('dashboard.correction.episode')" width="120">
              <template #default="{ row }">{{ formatEpisode(row) }}</template>
            </el-table-column>
            <el-table-column :label="t('dashboard.correction.itemStatus')" width="120">
              <template #default="{ row }">
                <el-tag :type="batchItemStatusTagType(row.status)" size="small">
                  {{ t(`dashboard.correction.batchItemStatus.${row.status}`) }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column prop="currentTargetPath" :label="t('dashboard.correction.currentTargetPath')" min-width="230" show-overflow-tooltip />
            <el-table-column prop="correctedTargetPath" :label="t('dashboard.correction.correctedTargetPath')" min-width="230" show-overflow-tooltip />
            <el-table-column :label="t('dashboard.correction.retryCount')" width="86" align="center">
              <template #default="{ row }">{{ row.retryCount }}</template>
            </el-table-column>
            <el-table-column type="expand" width="48">
              <template #default="{ row }">
                <div class="batch-item-detail">
                  <el-alert v-if="row.errorMessage" type="error" :title="row.errorMessage" :closable="false" show-icon />
                  <el-alert v-if="row.recoveryDetails" type="warning" :title="row.recoveryDetails" :closable="false" show-icon />
                </div>
              </template>
            </el-table-column>
          </el-table>
        </section>

        <template v-else>
          <section class="correction-section current-info-section">
            <h3>{{ t('dashboard.correction.currentInfo') }}</h3>
            <el-descriptions :column="2" border size="small">
              <el-descriptions-item :label="t('dashboard.correction.sourcePath')" :span="2">
                <span class="muted-path">{{ correctionTask.sourcePath }}</span>
              </el-descriptions-item>
              <el-descriptions-item :label="t('dashboard.correction.currentTargetPath')" :span="2">
                <span class="muted-path">{{ correctionTask.targetPath || '-' }}</span>
              </el-descriptions-item>
              <el-descriptions-item :label="t('dashboard.assetType')">
                {{ t(`task.assetType.${correctionTask.assetType || 'VIDEO_FILE'}`) }}
              </el-descriptions-item>
              <el-descriptions-item :label="t('dashboard.mediaType')">
                {{ correctionTask.mediaType ? t(`task.mediaType.${correctionTask.mediaType}`) : '-' }}
              </el-descriptions-item>
              <el-descriptions-item :label="t('dashboard.correction.currentTmdbId')">
                {{ correctionTask.tmdbId || '-' }}
              </el-descriptions-item>
              <el-descriptions-item :label="t('dashboard.correction.confirmationSource')">
                {{ correctionTask.confirmationSource ? t(`task.confirmationSource.${correctionTask.confirmationSource}`) : '-' }}
              </el-descriptions-item>
            </el-descriptions>
          </section>

          <section v-if="correctionCanOfferBatch" class="correction-section correction-scope-section" v-loading="correctionScopesLoading">
            <h3>{{ t('dashboard.correction.scopeTitle') }}</h3>
            <el-radio-group v-model="correctionScope" class="correction-scope-options" @change="handleCorrectionScopeChange">
              <el-radio-button value="SINGLE">
                <span>{{ t('dashboard.correction.scope.SINGLE') }}</span>
                <small>{{ t('dashboard.correction.singleScopeDetail', { episode: formatEpisode(correctionTask), count: 1 }) }}</small>
              </el-radio-button>
              <el-radio-button value="SAME_SEASON" :disabled="sameSeasonScopeDisabled">
                <span>{{ t('dashboard.correction.scope.SAME_SEASON') }}</span>
                <small>{{ sameSeasonScopeDetail }}</small>
              </el-radio-button>
              <el-radio-button value="SAME_SERIES" :disabled="sameSeriesScopeDisabled">
                <span>{{ t('dashboard.correction.scope.SAME_SERIES') }}</span>
                <small>{{ sameSeriesScopeDetail }}</small>
              </el-radio-button>
            </el-radio-group>
            <el-alert
              v-if="correctionScopesLoadFailed"
              type="warning"
              :title="t('dashboard.correction.scopeLoadFailed')"
              :closable="false"
              show-icon
            />
            <div v-if="correctionScopes?.warnings.length" class="message-stack">
              <el-alert
                v-for="warning in correctionScopes.warnings"
                :key="warning"
                type="warning"
                :title="warning"
                :closable="false"
                show-icon
              />
            </div>
          </section>

          <div class="correction-main-grid">
            <div class="correction-left-column">
              <section class="correction-section">
                <h3>{{ t('dashboard.correction.editRecognition') }}</h3>
                <el-form label-position="top" class="correction-form">
                  <el-row :gutter="12">
                    <el-col :span="8">
                      <el-form-item :label="t('queue.mediaType')">
                        <el-select v-model="correctionForm.mediaType" :disabled="isBatchCorrection" @change="invalidateCorrectionPreview">
                          <el-option :label="t('task.mediaType.MOVIE')" value="MOVIE" />
                          <el-option
                            :label="t('task.mediaType.TV_SHOW')"
                            value="TV_SHOW"
                            :disabled="correctionTask.assetType === 'BLURAY_DIRECTORY'"
                          />
                        </el-select>
                      </el-form-item>
                    </el-col>
                    <el-col :span="10">
                      <el-form-item :label="t('queue.parsedTitle')">
                        <el-input v-model="correctionForm.parsedTitle" @input="invalidateCorrectionPreview" />
                      </el-form-item>
                    </el-col>
                    <el-col :span="6">
                      <el-form-item :label="t('queue.parsedYear')">
                        <el-input-number
                          v-model="correctionForm.parsedYear"
                          :min="1888"
                          :max="2100"
                          controls-position="right"
                          @change="invalidateCorrectionPreview"
                        />
                      </el-form-item>
                    </el-col>
                  </el-row>
                  <el-row v-if="correctionForm.mediaType === 'TV_SHOW'" :gutter="12">
                    <el-col :span="8">
                      <el-form-item :label="t('queue.parsedSeason')">
                        <el-input-number v-model="correctionForm.parsedSeason" :disabled="isBatchCorrection" :min="0" controls-position="right" @change="invalidateCorrectionPreview" />
                      </el-form-item>
                    </el-col>
                    <el-col :span="8">
                      <el-form-item :label="t('queue.parsedEpisode')">
                        <el-input-number v-model="correctionForm.parsedEpisode" :disabled="isBatchCorrection" :min="0" controls-position="right" @change="invalidateCorrectionPreview" />
                      </el-form-item>
                    </el-col>
                    <el-col :span="8">
                      <el-form-item :label="t('dashboard.correction.parsedEpisodeEnd')">
                        <el-input-number v-model="correctionForm.parsedEpisodeEnd" :disabled="isBatchCorrection" :min="0" controls-position="right" @change="invalidateCorrectionPreview" />
                      </el-form-item>
                    </el-col>
                  </el-row>
                  <el-alert
                    v-if="isBatchCorrection"
                    type="info"
                    :title="t('dashboard.correction.preserveEpisodes')"
                    :closable="false"
                    show-icon
                  />
                  <div class="correction-form-actions">
                    <el-button native-type="button" size="small" :icon="Refresh" :loading="correctionRematching" @click="rematchCorrection">
                      {{ t('dashboard.correction.rematch') }}
                    </el-button>
                    <el-checkbox v-model="correctionForm.regenerateNfo" @change="handleRegenerateNfoChange">
                      {{ t('dashboard.correction.regenerateNfo') }}
                    </el-checkbox>
                  </div>
                </el-form>
              </section>

              <section class="correction-section candidate-section">
                <div class="section-title-row">
                  <h3>{{ t('dashboard.correction.candidates') }}</h3>
                </div>
                <el-empty v-if="correctionCandidates.length === 0" :description="t('dashboard.correction.noCandidates')" :image-size="56" />
                <div v-else class="candidate-list">
                  <button
                    v-for="candidate in correctionCandidates"
                    :key="candidateKey(candidate)"
                    class="candidate-row"
                    :class="{
                      selected: isCorrectionCandidateSelected(candidate),
                      disabled: isBatchCorrection && candidate.mediaType !== 'TV_SHOW',
                    }"
                    type="button"
                    :disabled="isBatchCorrection && candidate.mediaType !== 'TV_SHOW'"
                    @click="selectCorrectionCandidate(candidate)"
                  >
                    <img v-if="candidate.posterUrl" class="candidate-poster" :src="candidate.posterUrl" alt="" loading="lazy" />
                    <span v-else class="candidate-poster candidate-poster-placeholder">{{ candidate.mediaType === 'TV_SHOW' ? 'TV' : 'M' }}</span>
                    <span class="candidate-copy">
                      <span class="candidate-title">{{ candidateTitle(candidate) }}</span>
                      <span v-if="candidate.originalTitle && candidate.originalTitle !== candidate.title" class="candidate-original-title">
                        {{ candidate.originalTitle }}
                      </span>
                      <span class="candidate-meta">
                        {{ candidate.year || '-' }} · {{ t(`task.mediaType.${candidate.mediaType}`) }} · TMDB {{ candidate.sourceId }} · {{ formatConfidence(candidate.confidence) }}
                      </span>
                    </span>
                  </button>
                </div>
              </section>
            </div>

            <section class="correction-section preview-section" v-loading="correctionPreviewing">
              <div class="section-title-row">
                <h3>{{ t('dashboard.correction.preview') }}</h3>
              </div>
              <template v-if="isBatchCorrection">
                <div v-if="correctionBatchPreview" class="preview-panel batch-preview-panel">
                  <div class="batch-preview-summary">
                    <el-tag>{{ t('dashboard.correction.totalCountValue', { count: correctionBatchPreview.totalCount }) }}</el-tag>
                    <el-tag type="success">{{ t('dashboard.correction.selectedCountValue', { count: correctionBatchPreview.selectedCount }) }}</el-tag>
                    <el-tag type="success">{{ t('dashboard.correction.applicableCountValue', { count: correctionBatchPreview.applicableCount }) }}</el-tag>
                    <el-tag type="danger">{{ t('dashboard.correction.blockerCountValue', { count: correctionBatchPreview.blockerCount }) }}</el-tag>
                    <el-tag type="warning">{{ t('dashboard.correction.warningCountValue', { count: correctionBatchPreview.warningCount }) }}</el-tag>
                    <el-tag :type="correctionBatchPreview.canApply ? 'success' : 'danger'" effect="dark">
                      {{ correctionBatchPreview.canApply ? t('dashboard.correction.applyReady') : t('dashboard.correction.applyBlocked') }}
                    </el-tag>
                    <el-tooltip :content="correctionBatchPreview.groupFingerprint" placement="top">
                      <span class="batch-fingerprint">
                        {{ t('dashboard.correction.groupFingerprint') }} {{ correctionBatchPreview.groupFingerprint.slice(0, 10) }}…
                      </span>
                    </el-tooltip>
                  </div>
                  <div v-if="correctionBatchPreview.blockers.length" class="message-stack">
                    <el-alert v-for="blocker in correctionBatchPreview.blockers" :key="blocker" type="error" :title="blocker" show-icon :closable="false" />
                  </div>
                  <div v-if="correctionBatchPreview.warnings.length" class="message-stack">
                    <el-alert v-for="warning in correctionBatchPreview.warnings" :key="warning" type="warning" :title="warning" show-icon :closable="false" />
                  </div>
                  <el-table :data="correctionBatchPreview.items" size="small" border row-key="taskId" max-height="440">
                    <el-table-column :label="t('dashboard.correction.include')" width="74" align="center">
                      <template #default="{ row }">
                        <el-checkbox
                          :model-value="row.selected"
                          :disabled="correctionPreviewing"
                          @change="handleBatchItemSelection(row.taskId, $event)"
                        />
                      </template>
                    </el-table-column>
                    <el-table-column :label="t('dashboard.correction.episode')" width="110">
                      <template #default="{ row }">{{ formatEpisode(row) }}</template>
                    </el-table-column>
                    <el-table-column prop="currentTargetPath" :label="t('dashboard.correction.currentTargetPath')" min-width="210" show-overflow-tooltip />
                    <el-table-column :label="t('dashboard.correction.correctedTargetPath')" min-width="210" show-overflow-tooltip>
                      <template #default="{ row }">
                        <span>{{ row.correctedTargetPath || '-' }}</span>
                        <el-tag v-if="row.sameTargetPath" class="same-path-tag" size="small" type="info">
                          {{ t('dashboard.correction.sameTargetPath') }}
                        </el-tag>
                      </template>
                    </el-table-column>
                    <el-table-column :label="t('dashboard.correction.associatedFileCount')" width="92" align="center">
                      <template #default="{ row }">{{ row.associatedFileCount }}</template>
                    </el-table-column>
                    <el-table-column type="expand" width="48">
                      <template #default="{ row }">
                        <div class="batch-item-detail">
                          <div v-if="row.blockers.length" class="message-stack">
                            <el-alert v-for="blocker in row.blockers" :key="blocker" type="error" :title="blocker" :closable="false" show-icon />
                          </div>
                          <div v-if="row.warnings.length" class="message-stack">
                            <el-alert v-for="warning in row.warnings" :key="warning" type="warning" :title="warning" :closable="false" show-icon />
                          </div>
                          <el-table :data="row.operations" size="small" border>
                            <el-table-column :label="t('dashboard.correction.operationType')" width="136">
                              <template #default="{ row }">{{ correctionOperationLabel(row) }}</template>
                            </el-table-column>
                            <el-table-column prop="sourcePath" :label="t('dashboard.correction.operationSource')" min-width="180" show-overflow-tooltip />
                            <el-table-column prop="targetPath" :label="t('dashboard.correction.operationTarget')" min-width="180" show-overflow-tooltip />
                          </el-table>
                        </div>
                      </template>
                    </el-table-column>
                  </el-table>
                </div>
                <el-empty v-else :description="t('dashboard.correction.batchPreviewEmpty')" :image-size="72" />
              </template>
              <template v-else>
                <div v-if="correctionPreview" class="preview-panel">
                  <el-descriptions :column="1" border size="small" class="preview-path-descriptions">
                    <el-descriptions-item :label="t('dashboard.correction.currentTargetPath')">
                      <span class="muted-path">{{ correctionPreview.currentTargetPath || '-' }}</span>
                    </el-descriptions-item>
                    <el-descriptions-item :label="t('dashboard.correction.correctedTargetPath')">
                      <span class="muted-path">{{ correctionPreview.correctedTargetPath || '-' }}</span>
                    </el-descriptions-item>
                  </el-descriptions>
                  <div v-if="correctionPreview.blockers.length" class="message-stack">
                    <el-alert v-for="blocker in correctionPreview.blockers" :key="blocker" type="error" :title="blocker" show-icon :closable="false" />
                  </div>
                  <div v-if="correctionPreview.warnings.length" class="message-stack">
                    <el-alert v-for="warning in correctionPreview.warnings" :key="warning" type="warning" :title="warning" show-icon :closable="false" />
                  </div>
                  <el-table :data="correctionPreview.operations" size="small" border class="operation-table">
                    <el-table-column :label="t('dashboard.correction.operationType')" width="136">
                      <template #default="{ row }">{{ correctionOperationLabel(row) }}</template>
                    </el-table-column>
                    <el-table-column prop="sourcePath" :label="t('dashboard.correction.operationSource')" min-width="180" show-overflow-tooltip />
                    <el-table-column prop="targetPath" :label="t('dashboard.correction.operationTarget')" min-width="180" show-overflow-tooltip />
                  </el-table>
                </div>
                <el-empty v-else :description="t('dashboard.correction.previewEmpty')" :image-size="72" />
              </template>
            </section>
          </div>
        </template>
      </div>
      <template #footer>
        <template v-if="correctionBatch">
          <el-button @click="correctionDialogVisible = false">{{ t('common.close') }}</el-button>
          <el-button v-if="isBatchTerminal" @click="returnToCorrectionEditor">
            {{ t('dashboard.correction.returnToEditor') }}
          </el-button>
          <el-button
            v-if="canRetryCorrectionBatch"
            type="warning"
            :icon="Refresh"
            :loading="correctionBatchRetrying"
            @click="retryCorrectionBatch"
          >
            {{ t('dashboard.correction.retryFailed') }}
          </el-button>
        </template>
        <template v-else>
          <el-button @click="correctionDialogVisible = false">{{ t('common.cancel') }}</el-button>
          <el-button
            type="primary"
            :icon="Check"
            :loading="correctionApplying"
            :disabled="!correctionCanApply"
            @click="applyCorrection"
          >
            {{ isBatchCorrection ? t('dashboard.correction.applyBatch') : t('dashboard.correction.apply') }}
          </el-button>
        </template>
      </template>
    </el-dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useMediaStore } from '@/stores/mediaStore'
import { mediaApi } from '@/api/media'
import { storeToRefs } from 'pinia'
import { ElMessage, ElMessageBox } from 'element-plus'
import { Check, EditPen, Refresh, Search } from '@element-plus/icons-vue'
import type {
  MatchResult,
  MediaAssetType,
  MediaTask,
  MediaType,
  TaskCorrectionBatchItemStatus,
  TaskCorrectionBatchPreview,
  TaskCorrectionBatchRequest,
  TaskCorrectionBatchResponse,
  TaskCorrectionBatchStatus,
  TaskCorrectionPreview,
  TaskCorrectionRequest,
  TaskCorrectionScope,
  TaskCorrectionScopesResponse,
  TaskStatus,
} from '@/types'

const { t, te } = useI18n()
const mediaStore = useMediaStore()
const { tasks, loading, queueTasks, doneTasks, skippedTasks, failedTasks } = storeToRefs(mediaStore)
const { fetchTasks, deleteTask } = mediaStore
const deletingId = ref<number | null>(null)
const selectedTasks = ref<MediaTask[]>([])
const batchDeleting = ref(false)
const statusOptions: TaskStatus[] = ['PENDING', 'PROCESSING', 'AWAITING_CONFIRMATION', 'DONE', 'FAILED', 'SKIPPED', 'CORRECTED']
const assetTypeOptions: MediaAssetType[] = ['VIDEO_FILE', 'ISO_IMAGE', 'BLURAY_DIRECTORY']
const mediaTypeOptions: MediaType[] = ['MOVIE', 'TV_SHOW']
const statusFilter = ref<TaskStatus | 'ALL'>('ALL')
const assetTypeFilter = ref<MediaAssetType | 'ALL'>('ALL')
const mediaTypeFilter = ref<MediaType | 'ALL'>('ALL')
const fileNameSearchActive = ref(false)
const fileNameKeyword = ref('')
const fileNameSearchInputRef = ref<{ focus: () => void } | null>(null)
const matchedTitleSearchActive = ref(false)
const matchedTitleKeyword = ref('')
const matchedTitleSearchInputRef = ref<{ focus: () => void } | null>(null)
const currentPage = ref(1)
const pageSize = ref(20)
type TagType = 'primary' | 'success' | 'warning' | 'danger' | 'info'
const correctionDialogVisible = ref(false)
const correctionTask = ref<MediaTask | null>(null)
const correctionForm = reactive({
  mediaType: 'MOVIE' as MediaType,
  parsedTitle: '',
  parsedYear: null as number | null,
  parsedSeason: null as number | null,
  parsedEpisode: null as number | null,
  parsedEpisodeEnd: null as number | null,
  regenerateNfo: false,
})
const correctionCandidates = ref<MatchResult[]>([])
const selectedCorrectionCandidate = ref<MatchResult | null>(null)
const correctionPreview = ref<TaskCorrectionPreview | null>(null)
const correctionScope = ref<TaskCorrectionScope>('SINGLE')
const correctionScopes = ref<TaskCorrectionScopesResponse | null>(null)
const correctionScopesLoading = ref(false)
const correctionScopesLoadFailed = ref(false)
const correctionBatchPreview = ref<TaskCorrectionBatchPreview | null>(null)
const correctionBatch = ref<TaskCorrectionBatchResponse | null>(null)
const correctionBatchRetrying = ref(false)
const excludedCorrectionTaskIds = ref<number[]>([])
const correctionBatchIdempotencyKey = ref<string | null>(null)
const correctionRematching = ref(false)
const correctionPreviewing = ref(false)
const correctionApplying = ref(false)
let correctionPreviewRequestSeq = 0
let correctionBatchPollTimer: ReturnType<typeof setTimeout> | null = null

const CORRECTION_BATCH_POLL_INTERVAL_MS = 1000
const CORRECTION_BATCH_REFERENCE_KEY = 'media-marshal.task-correction-batches'
const CORRECTION_BATCH_REFERENCE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

interface StoredCorrectionBatchReference {
  batchId: number
  savedAt: number
}

const normalizedFileNameKeyword = computed(() => fileNameKeyword.value.trim().toLocaleLowerCase())
const normalizedMatchedTitleKeyword = computed(() => matchedTitleKeyword.value.trim().toLocaleLowerCase())
const isBatchCorrection = computed(() => correctionScope.value !== 'SINGLE')
const correctionCanOfferBatch = computed(() => {
  const task = correctionTask.value
  return Boolean(
    task &&
      task.status === 'DONE' &&
      task.mediaType === 'TV_SHOW' &&
      task.assetType === 'VIDEO_FILE' &&
      task.tmdbId != null &&
      task.ruleId != null &&
      task.targetPath,
  )
})
const sameSeasonScopeDisabled = computed(() => {
  const scopes = correctionScopes.value
  return !scopes?.batchSupported || scopes.currentSeason == null || scopes.sameSeasonCount <= 1
})
const sameSeriesScopeDisabled = computed(() => {
  const scopes = correctionScopes.value
  return !scopes?.batchSupported || scopes.sameSeriesCount <= 1
})
const sameSeasonScopeDetail = computed(() => {
  const scopes = correctionScopes.value
  if (!scopes) return t('dashboard.correction.scopeUnavailable')
  if (scopes.currentSeason == null) return t('dashboard.correction.seasonMissing')
  return t('dashboard.correction.seasonScopeDetail', {
    season: formatSeason(scopes.currentSeason),
    count: scopes.sameSeasonCount,
  })
})
const sameSeriesScopeDetail = computed(() => {
  const scopes = correctionScopes.value
  if (!scopes) return t('dashboard.correction.scopeUnavailable')
  const range = scopes.minSeason == null
    ? t('dashboard.correction.seasonUnknown')
    : scopes.minSeason === scopes.maxSeason
      ? formatSeason(scopes.minSeason)
      : `${formatSeason(scopes.minSeason)}–${formatSeason(scopes.maxSeason ?? scopes.minSeason)}`
  return t('dashboard.correction.seriesScopeDetail', { range, count: scopes.sameSeriesCount })
})
const correctionCanApply = computed(() =>
  isBatchCorrection.value
    ? Boolean(correctionBatchPreview.value?.canApply)
    : Boolean(correctionPreview.value?.canApply),
)
const batchProcessedCount = computed(() => {
  const batch = correctionBatch.value
  return batch ? batch.successCount + batch.failedCount + batch.excludedCount : 0
})
const batchProgressPercentage = computed(() => {
  const batch = correctionBatch.value
  if (!batch || batch.totalCount === 0) return 0
  return Math.min(100, Math.round((batchProcessedCount.value / batch.totalCount) * 100))
})
const batchProgressStatus = computed<'success' | 'exception' | undefined>(() => {
  const status = correctionBatch.value?.status
  if (status === 'SUCCEEDED') return 'success'
  if (status === 'FAILED' || status === 'INTERRUPTED') return 'exception'
  return undefined
})
const isBatchTerminal = computed(() => isTerminalBatchStatus(correctionBatch.value?.status))
const canRetryCorrectionBatch = computed(() => {
  const batch = correctionBatch.value
  return Boolean(
    batch &&
      batch.failedCount > 0 &&
      (batch.status === 'PARTIAL_FAILED' || batch.status === 'FAILED' || batch.status === 'INTERRUPTED'),
  )
})

const filteredTasks = computed(() => {
  return tasks.value.filter((task) => {
    const taskAssetType = task.assetType || 'VIDEO_FILE'
    const matchesStatus = statusFilter.value === 'ALL' || task.status === statusFilter.value
    const matchesAssetType = assetTypeFilter.value === 'ALL' || taskAssetType === assetTypeFilter.value
    const matchesMediaType = mediaTypeFilter.value === 'ALL' || task.mediaType === mediaTypeFilter.value
    const matchesFileName =
      !normalizedFileNameKeyword.value ||
      sourceFileName(task.sourcePath).toLocaleLowerCase().includes(normalizedFileNameKeyword.value)
    const matchesMatchedTitle =
      !normalizedMatchedTitleKeyword.value ||
      (task.confirmedTitle || '').toLocaleLowerCase().includes(normalizedMatchedTitleKeyword.value)
    return matchesStatus && matchesAssetType && matchesMediaType && matchesFileName && matchesMatchedTitle
  })
})

const sortedTasks = computed(() => {
  return [...filteredTasks.value].sort((a, b) => taskTime(b) - taskTime(a))
})

const displayedTasks = computed(() => {
  const start = (currentPage.value - 1) * pageSize.value
  return sortedTasks.value.slice(start, start + pageSize.value)
})

onMounted(() => fetchTasks())
onBeforeUnmount(stopCorrectionBatchPolling)

watch(correctionDialogVisible, (visible) => {
  if (!visible) stopCorrectionBatchPolling()
})

watch([statusFilter, assetTypeFilter, mediaTypeFilter, normalizedFileNameKeyword, normalizedMatchedTitleKeyword, pageSize], () => {
  selectedTasks.value = []
  currentPage.value = 1
})

watch(currentPage, () => {
  selectedTasks.value = []
})

watch(filteredTasks, () => {
  const maxPage = Math.max(1, Math.ceil(filteredTasks.value.length / pageSize.value))
  if (currentPage.value > maxPage) {
    currentPage.value = maxPage
  }
})

function taskTime(task: MediaTask) {
  const value = task.updatedAt || task.createdAt
  const timestamp = new Date(value).getTime()
  return Number.isNaN(timestamp) ? 0 : timestamp
}

async function activateFileNameSearch() {
  fileNameSearchActive.value = true
  await nextTick()
  fileNameSearchInputRef.value?.focus()
}

function handleFileNameSearchInput(value: string) {
  if (isBlankSearch(value)) {
    resetFileNameSearch()
  }
}

function resetFileNameSearch() {
  fileNameKeyword.value = ''
  fileNameSearchActive.value = false
}

function sourceFileName(sourcePath: string) {
  return sourcePath.split(/[\\/]/).pop() || sourcePath
}

async function activateMatchedTitleSearch() {
  matchedTitleSearchActive.value = true
  await nextTick()
  matchedTitleSearchInputRef.value?.focus()
}

function handleMatchedTitleSearchInput(value: string) {
  if (isBlankSearch(value)) {
    resetMatchedTitleSearch()
  }
}

function resetMatchedTitleSearch() {
  matchedTitleKeyword.value = ''
  matchedTitleSearchActive.value = false
}

function isBlankSearch(value: string) {
  return value.length > 0 && value.trim() === ''
}

function statusTagType(status: TaskStatus): TagType | undefined {
  const map: Record<TaskStatus, TagType | undefined> = {
    PENDING: 'info',
    PROCESSING: undefined,
    AWAITING_CONFIRMATION: 'warning',
    DONE: 'success',
    FAILED: 'danger',
    SKIPPED: 'info',
    CORRECTED: 'info',
  }
  return map[status] ?? 'info'
}

function assetTypeTagType(assetType: MediaAssetType | null | undefined): TagType | undefined {
  const map: Record<MediaAssetType, TagType | undefined> = {
    VIDEO_FILE: 'info',
    ISO_IMAGE: 'warning',
    BLURAY_DIRECTORY: 'primary',
  }
  return map[assetType || 'VIDEO_FILE'] ?? 'info'
}

function formatCreatedAt(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) {
    return { date: '-', time: '-' }
  }

  const pad = (num: number) => num.toString().padStart(2, '0')
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
  }
}

function taskDetails(task: MediaTask) {
  if (task.status === 'FAILED') {
    return localizedTaskDetail(task.errorMessage)
  }
  if (task.status === 'SKIPPED') {
    return localizedTaskDetail(task.skipReason)
  }
  if (task.status === 'CORRECTED') {
    return task.correctedToTaskId
      ? t('dashboard.correction.correctedTo', { id: task.correctedToTaskId })
      : t('dashboard.correction.correctedHistory')
  }
  return '-'
}

function normalizedFailureCount(task: MediaTask) {
  return task.failureCount && task.failureCount > 0 ? task.failureCount : 1
}

function localizedTaskDetail(detail: string | null) {
  if (!detail) return '-'

  const key = detail.trim()
  if (te(`task.details.${key}`)) {
    return t(`task.details.${key}`)
  }

  return detail
}

async function handleDeleteTask(task: MediaTask) {
  await ElMessageBox.confirm(
    t('dashboard.deleteTaskConfirm'),
    t('common.delete'),
    {
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
      type: 'warning',
    },
  )

  deletingId.value = task.id
  try {
    await deleteTask(task.id)
    const maxPage = Math.max(1, Math.ceil(filteredTasks.value.length / pageSize.value))
    currentPage.value = Math.min(currentPage.value, maxPage)
    ElMessage.success(t('dashboard.deleteTaskSuccess'))
  } finally {
    deletingId.value = null
  }
}

function openCorrectionDialog(task: MediaTask) {
  if (task.assetType === 'ISO_IMAGE') {
    ElMessage.warning(t('dashboard.correction.isoUnsupported'))
    return
  }
  stopCorrectionBatchPolling()
  correctionTask.value = task
  correctionBatch.value = null
  correctionScope.value = 'SINGLE'
  correctionScopes.value = null
  correctionScopesLoadFailed.value = false
  correctionScopesLoading.value = false
  excludedCorrectionTaskIds.value = []
  correctionForm.mediaType = task.mediaType || 'MOVIE'
  correctionForm.parsedTitle = task.parsedTitle || task.confirmedTitle || sourceFileName(task.sourcePath)
  correctionForm.parsedYear = task.parsedYear || task.confirmedYear
  correctionForm.parsedSeason = task.parsedSeason
  correctionForm.parsedEpisode = task.parsedEpisode
  correctionForm.parsedEpisodeEnd = task.parsedEpisodeEnd
  correctionForm.regenerateNfo = false
  invalidateCorrectionPreview()
  selectedCorrectionCandidate.value = task.tmdbId ? taskToMatchResult(task) : null
  correctionCandidates.value = selectedCorrectionCandidate.value ? [selectedCorrectionCandidate.value] : []
  correctionDialogVisible.value = true
  void initializeCorrectionDialog(task.id)
}

async function initializeCorrectionDialog(taskId: number) {
  await nextTick()
  if (correctionTask.value?.id !== taskId) return

  const restored = await restoreCorrectionBatch(taskId)
  if (correctionTask.value?.id !== taskId || restored) return

  void loadCorrectionScopes(taskId)
  if (selectedCorrectionCandidate.value) {
    await refreshCorrectionPreview()
  }
}

async function loadCorrectionScopes(taskId: number) {
  if (!correctionCanOfferBatch.value) return
  correctionScopesLoading.value = true
  correctionScopesLoadFailed.value = false
  try {
    const response = await mediaApi.getTaskCorrectionScopes(taskId)
    if (correctionTask.value?.id !== taskId) return
    correctionScopes.value = response.data.data
    if (!response.data.data.batchSupported) {
      correctionScope.value = 'SINGLE'
    }
  } catch {
    if (correctionTask.value?.id === taskId) {
      correctionScopes.value = null
      correctionScopesLoadFailed.value = true
      correctionScope.value = 'SINGLE'
    }
  } finally {
    if (correctionTask.value?.id === taskId) {
      correctionScopesLoading.value = false
    }
  }
}

function taskToMatchResult(task: MediaTask): MatchResult {
  return {
    source: 'tmdb',
    sourceId: String(task.tmdbId || ''),
    title: task.confirmedTitle,
    originalTitle: task.confirmedOriginalTitle,
    year: task.confirmedYear,
    mediaType: task.mediaType || 'MOVIE',
    overview: null,
    posterUrl: null,
    genres: [task.confirmedGenre1, task.confirmedGenre2, task.confirmedGenre3, task.confirmedGenre4].filter((value): value is string => Boolean(value)),
    country: task.confirmedCountry,
    episodeTitle: task.confirmedEpisodeTitle,
    confidence: task.matchConfidence,
  }
}

function buildCorrectionRequest(): TaskCorrectionRequest | null {
  if (!correctionTask.value) return null
  return {
    mediaType: correctionForm.mediaType,
    parsedTitle: correctionForm.parsedTitle.trim(),
    parsedYear: correctionForm.parsedYear,
    parsedSeason: correctionForm.mediaType === 'TV_SHOW' ? correctionForm.parsedSeason : null,
    parsedEpisode: correctionForm.mediaType === 'TV_SHOW' ? correctionForm.parsedEpisode : null,
    parsedEpisodeEnd: correctionForm.mediaType === 'TV_SHOW' ? correctionForm.parsedEpisodeEnd : null,
    tmdbId: selectedCorrectionCandidate.value ? Number(selectedCorrectionCandidate.value.sourceId) : null,
    regenerateNfo: correctionForm.regenerateNfo,
  }
}

function buildCorrectionBatchRequest(): TaskCorrectionBatchRequest | null {
  const candidate = selectedCorrectionCandidate.value
  if (!isBatchCorrection.value || !candidate || candidate.mediaType !== 'TV_SHOW') return null
  return {
    scope: correctionScope.value,
    parsedTitle: correctionForm.parsedTitle.trim(),
    parsedYear: correctionForm.parsedYear,
    tmdbId: Number(candidate.sourceId),
    regenerateNfo: correctionForm.regenerateNfo,
    excludedTaskIds: [...excludedCorrectionTaskIds.value].sort((a, b) => a - b),
  }
}

function validateCorrectionForm() {
  if (!correctionForm.parsedTitle.trim()) {
    ElMessage.warning(t('queue.validation.titleRequired'))
    return false
  }
  if (!isBatchCorrection.value && correctionForm.mediaType === 'TV_SHOW' && (correctionForm.parsedSeason == null || correctionForm.parsedEpisode == null)) {
    ElMessage.warning(t('queue.validation.seasonEpisodeRequired'))
    return false
  }
  return true
}

function invalidateCorrectionPreview() {
  correctionPreviewRequestSeq += 1
  correctionPreview.value = null
  correctionBatchPreview.value = null
  correctionBatchIdempotencyKey.value = null
  correctionPreviewing.value = false
}

async function handleCorrectionScopeChange(value: string | number | boolean | undefined) {
  correctionScope.value = String(value) as TaskCorrectionScope
  excludedCorrectionTaskIds.value = []
  if (isBatchCorrection.value) {
    correctionForm.mediaType = 'TV_SHOW'
    if (selectedCorrectionCandidate.value?.mediaType !== 'TV_SHOW') {
      selectedCorrectionCandidate.value = null
    }
  }
  invalidateCorrectionPreview()
  if (selectedCorrectionCandidate.value) {
    await refreshCorrectionPreview()
  }
}

function handleRegenerateNfoChange() {
  invalidateCorrectionPreview()
  if (selectedCorrectionCandidate.value) {
    void refreshCorrectionPreview()
  }
}

async function rematchCorrection() {
  if (!correctionTask.value || !validateCorrectionForm()) return
  const request = buildCorrectionRequest()
  if (!request) return
  correctionRematching.value = true
  try {
    const res = await mediaApi.rematchTaskCorrection(correctionTask.value.id, request)
    correctionCandidates.value = isBatchCorrection.value
      ? res.data.data.candidates.filter((candidate) => candidate.mediaType === 'TV_SHOW')
      : res.data.data.candidates
    selectedCorrectionCandidate.value = correctionCandidates.value[0] || null
    invalidateCorrectionPreview()
    if (correctionCandidates.value.length === 0) {
      ElMessage.info(t('dashboard.correction.noCandidates'))
    } else {
      await refreshCorrectionPreview()
    }
  } finally {
    correctionRematching.value = false
  }
}

async function selectCorrectionCandidate(candidate: MatchResult) {
  if (isBatchCorrection.value && candidate.mediaType !== 'TV_SHOW') {
    ElMessage.warning(t('dashboard.correction.batchTvOnly'))
    return
  }
  selectedCorrectionCandidate.value = candidate
  invalidateCorrectionPreview()
  await refreshCorrectionPreview()
}

function isCorrectionCandidateSelected(candidate: MatchResult) {
  return selectedCorrectionCandidate.value
    ? candidateKey(selectedCorrectionCandidate.value) === candidateKey(candidate)
    : false
}

function candidateKey(candidate: MatchResult) {
  return `${candidate.mediaType}:${candidate.sourceId}`
}

function candidateTitle(candidate: MatchResult) {
  return candidate.title || candidate.originalTitle || candidate.sourceId
}

function formatConfidence(confidence: number | null) {
  return confidence != null ? `${Math.round(confidence * 100)}%` : '-'
}

function correctionOperationLabel(operation: { type?: string } | null | undefined) {
  return operation?.type ? t(`dashboard.correction.operation.${operation.type}`) : '-'
}

async function refreshCorrectionPreview() {
  if (!correctionTask.value || !selectedCorrectionCandidate.value || !validateCorrectionForm()) return
  const requestSeq = ++correctionPreviewRequestSeq
  correctionPreviewing.value = true
  try {
    if (isBatchCorrection.value) {
      const request = buildCorrectionBatchRequest()
      if (!request) return
      const res = await mediaApi.previewTaskCorrectionBatch(correctionTask.value.id, request)
      if (requestSeq === correctionPreviewRequestSeq) {
        correctionBatchPreview.value = res.data.data
        excludedCorrectionTaskIds.value = res.data.data.items
          .filter((item) => !item.selected)
          .map((item) => item.taskId)
      }
      return
    }
    const request = buildCorrectionRequest()
    if (!request) return
    const res = await mediaApi.previewTaskCorrection(correctionTask.value.id, request)
    if (requestSeq === correctionPreviewRequestSeq) {
      correctionPreview.value = res.data.data
    }
  } finally {
    if (requestSeq === correctionPreviewRequestSeq) {
      correctionPreviewing.value = false
    }
  }
}

async function handleBatchItemSelection(taskId: number, selected: string | number | boolean) {
  const excluded = new Set(excludedCorrectionTaskIds.value)
  if (Boolean(selected)) {
    excluded.delete(taskId)
  } else {
    excluded.add(taskId)
  }
  excludedCorrectionTaskIds.value = [...excluded]
  invalidateCorrectionPreview()
  await refreshCorrectionPreview()
}

async function applyCorrection() {
  if (isBatchCorrection.value) {
    await applyCorrectionBatch()
    return
  }
  if (!correctionTask.value || !correctionPreview.value?.canApply || !selectedCorrectionCandidate.value) return
  const request = buildCorrectionRequest()
  if (!request) return

  await ElMessageBox.confirm(
    t('dashboard.correction.applyConfirmMessage'),
    t('dashboard.correction.applyConfirmTitle'),
    {
      confirmButtonText: t('dashboard.correction.apply'),
      cancelButtonText: t('common.cancel'),
      type: 'warning',
    },
  )

  correctionApplying.value = true
  try {
    await mediaApi.applyTaskCorrection(correctionTask.value.id, request)
    ElMessage.success(t('dashboard.correction.applySuccess'))
    correctionDialogVisible.value = false
    await fetchTasks()
  } finally {
    correctionApplying.value = false
  }
}

async function applyCorrectionBatch() {
  const task = correctionTask.value
  const preview = correctionBatchPreview.value
  if (!task || !preview?.canApply || !selectedCorrectionCandidate.value) return
  const request = buildCorrectionBatchRequest()
  if (!request) return

  await ElMessageBox.confirm(
    t('dashboard.correction.applyBatchConfirmMessage', { count: preview.selectedCount }),
    t('dashboard.correction.applyBatchConfirmTitle'),
    {
      confirmButtonText: t('dashboard.correction.applyBatch'),
      cancelButtonText: t('common.cancel'),
      type: 'warning',
    },
  )

  correctionApplying.value = true
  try {
    correctionBatchIdempotencyKey.value ||= createCorrectionBatchIdempotencyKey()
    const response = await mediaApi.applyTaskCorrectionBatch(task.id, {
      ...request,
      groupFingerprint: preview.groupFingerprint,
      idempotencyKey: correctionBatchIdempotencyKey.value,
    })
    const batchId = response.data.data.batchId
    rememberCorrectionBatch(batchId, [task.id, ...preview.items.map((item) => item.taskId)])
    ElMessage.success(t('dashboard.correction.batchQueued'))
    await refreshCorrectionBatch(batchId, true)
  } finally {
    correctionApplying.value = false
  }
}

async function retryCorrectionBatch() {
  const batch = correctionBatch.value
  if (!batch || !canRetryCorrectionBatch.value) return

  await ElMessageBox.confirm(
    t('dashboard.correction.retryFailedConfirm', { count: batch.failedCount }),
    t('dashboard.correction.retryFailed'),
    {
      confirmButtonText: t('dashboard.correction.retryFailed'),
      cancelButtonText: t('common.cancel'),
      type: 'warning',
    },
  )

  correctionBatchRetrying.value = true
  try {
    await mediaApi.retryTaskCorrectionBatch(batch.id)
    ElMessage.success(t('dashboard.correction.retryQueued'))
    await refreshCorrectionBatch(batch.id, false)
  } finally {
    correctionBatchRetrying.value = false
  }
}

async function refreshCorrectionBatch(batchId: number, notifyTerminal: boolean) {
  stopCorrectionBatchPolling()
  const previousStatus = correctionBatch.value?.status
  try {
    const response = await mediaApi.getTaskCorrectionBatch(batchId)
    const batch = response.data.data
    correctionBatch.value = batch
    rememberCorrectionBatchFromResponse(batch)

    if (isTerminalBatchStatus(batch.status)) {
      if (notifyTerminal || (previousStatus && previousStatus !== batch.status)) {
        notifyCorrectionBatchTerminal(batch)
      }
      await fetchTasks()
      return
    }
    if (correctionDialogVisible.value) {
      correctionBatchPollTimer = setTimeout(() => {
        void refreshCorrectionBatch(batchId, true)
      }, CORRECTION_BATCH_POLL_INTERVAL_MS)
    }
  } catch {
    stopCorrectionBatchPolling()
  }
}

function stopCorrectionBatchPolling() {
  if (correctionBatchPollTimer) {
    clearTimeout(correctionBatchPollTimer)
    correctionBatchPollTimer = null
  }
}

async function restoreCorrectionBatch(taskId: number) {
  const reference = readCorrectionBatchReferences()[String(taskId)]
  if (!reference) return false
  try {
    const response = await mediaApi.getTaskCorrectionBatch(reference.batchId)
    correctionBatch.value = response.data.data
    rememberCorrectionBatchFromResponse(response.data.data)
    if (!isTerminalBatchStatus(response.data.data.status)) {
      correctionBatchPollTimer = setTimeout(() => {
        void refreshCorrectionBatch(response.data.data.id, true)
      }, CORRECTION_BATCH_POLL_INTERVAL_MS)
    }
    return true
  } catch {
    forgetCorrectionBatchReference(taskId)
    return false
  }
}

async function returnToCorrectionEditor() {
  const task = correctionTask.value
  if (!task) return
  stopCorrectionBatchPolling()
  forgetCorrectionBatchReference(task.id)
  try {
    const response = await mediaApi.getTask(task.id)
    const currentTask = response.data.data
    if (currentTask.status !== 'DONE') {
      ElMessage.info(t('dashboard.correction.taskNoLongerEditable'))
      correctionDialogVisible.value = false
      await fetchTasks()
      return
    }
    correctionTask.value = currentTask
    correctionBatch.value = null
    correctionScope.value = 'SINGLE'
    initializeCorrectionForm(currentTask)
    void loadCorrectionScopes(currentTask.id)
    if (selectedCorrectionCandidate.value) {
      await refreshCorrectionPreview()
    }
  } catch {
    correctionDialogVisible.value = false
  }
}

function initializeCorrectionForm(task: MediaTask) {
  correctionForm.mediaType = task.mediaType || 'MOVIE'
  correctionForm.parsedTitle = task.parsedTitle || task.confirmedTitle || sourceFileName(task.sourcePath)
  correctionForm.parsedYear = task.parsedYear || task.confirmedYear
  correctionForm.parsedSeason = task.parsedSeason
  correctionForm.parsedEpisode = task.parsedEpisode
  correctionForm.parsedEpisodeEnd = task.parsedEpisodeEnd
  correctionForm.regenerateNfo = false
  excludedCorrectionTaskIds.value = []
  selectedCorrectionCandidate.value = task.tmdbId ? taskToMatchResult(task) : null
  correctionCandidates.value = selectedCorrectionCandidate.value ? [selectedCorrectionCandidate.value] : []
  invalidateCorrectionPreview()
}

function notifyCorrectionBatchTerminal(batch: TaskCorrectionBatchResponse) {
  if (batch.status === 'SUCCEEDED') {
    ElMessage.success(t('dashboard.correction.batchSucceeded', { count: batch.successCount }))
  } else if (batch.status === 'PARTIAL_FAILED') {
    ElMessage.warning(t('dashboard.correction.batchPartialFailed', {
      success: batch.successCount,
      failed: batch.failedCount,
    }))
  } else {
    ElMessage.error(t('dashboard.correction.batchFailed', { count: batch.failedCount }))
  }
}

function formatSeason(season: number) {
  return `S${String(season).padStart(2, '0')}`
}

function formatEpisode(item: {
  season?: number | null
  episode?: number | null
  episodeEnd?: number | null
  parsedSeason?: number | null
  parsedEpisode?: number | null
  parsedEpisodeEnd?: number | null
}) {
  const seasonNumber = item.season ?? item.parsedSeason ?? null
  const episodeNumber = item.episode ?? item.parsedEpisode ?? null
  const episodeEnd = item.episodeEnd ?? item.parsedEpisodeEnd ?? null
  const season = seasonNumber == null ? 'S--' : formatSeason(seasonNumber)
  if (episodeNumber == null) return `${season}E--`
  const start = `E${String(episodeNumber).padStart(2, '0')}`
  const end = episodeEnd != null ? `–E${String(episodeEnd).padStart(2, '0')}` : ''
  return `${season}${start}${end}`
}

function batchStatusTagType(status: TaskCorrectionBatchStatus): TagType {
  if (status === 'SUCCEEDED') return 'success'
  if (status === 'PARTIAL_FAILED') return 'warning'
  if (status === 'FAILED' || status === 'INTERRUPTED') return 'danger'
  return 'primary'
}

function batchItemStatusTagType(status: TaskCorrectionBatchItemStatus): TagType {
  if (status === 'SUCCEEDED') return 'success'
  if (status === 'FAILED') return 'danger'
  if (status === 'EXCLUDED') return 'info'
  if (status === 'RUNNING') return 'primary'
  return 'warning'
}

function isTerminalBatchStatus(status: TaskCorrectionBatchStatus | undefined) {
  return status === 'SUCCEEDED' || status === 'PARTIAL_FAILED' || status === 'FAILED' || status === 'INTERRUPTED'
}

function createCorrectionBatchIdempotencyKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `correction-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function readCorrectionBatchReferences(): Record<string, StoredCorrectionBatchReference> {
  try {
    const raw = localStorage.getItem(CORRECTION_BATCH_REFERENCE_KEY)
    const parsed = raw ? JSON.parse(raw) as Record<string, StoredCorrectionBatchReference> : {}
    const cutoff = Date.now() - CORRECTION_BATCH_REFERENCE_MAX_AGE_MS
    return Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => value && value.savedAt >= cutoff && Number.isFinite(value.batchId)),
    )
  } catch {
    return {}
  }
}

function rememberCorrectionBatch(batchId: number, taskIds: number[]) {
  try {
    const references = readCorrectionBatchReferences()
    const reference = { batchId, savedAt: Date.now() }
    for (const taskId of new Set(taskIds)) {
      references[String(taskId)] = reference
    }
    localStorage.setItem(CORRECTION_BATCH_REFERENCE_KEY, JSON.stringify(references))
  } catch {
    // Local storage is only a reconnect convenience; the persisted backend job remains authoritative.
  }
}

function rememberCorrectionBatchFromResponse(batch: TaskCorrectionBatchResponse) {
  const taskIds = [batch.anchorTaskId]
  for (const item of batch.items) {
    taskIds.push(item.originalTaskId)
    if (item.correctedTaskId != null) taskIds.push(item.correctedTaskId)
  }
  rememberCorrectionBatch(batch.id, taskIds)
}

function forgetCorrectionBatchReference(taskId: number) {
  try {
    const references = readCorrectionBatchReferences()
    delete references[String(taskId)]
    localStorage.setItem(CORRECTION_BATCH_REFERENCE_KEY, JSON.stringify(references))
  } catch {
    // Ignore unavailable local storage.
  }
}

function handleSelectionChange(selection: MediaTask[]) {
  selectedTasks.value = selection
}

async function handleBatchDelete() {
  const count = selectedTasks.value.length
  if (count === 0) return

  await ElMessageBox.confirm(
    t('dashboard.batchDeleteConfirm', { count }),
    t('dashboard.batchDelete'),
    {
      confirmButtonText: t('common.confirm'),
      cancelButtonText: t('common.cancel'),
      type: 'warning',
    },
  )

  batchDeleting.value = true
  try {
    for (const task of selectedTasks.value) {
      await deleteTask(task.id)
    }
    selectedTasks.value = []
    const maxPage = Math.max(1, Math.ceil(filteredTasks.value.length / pageSize.value))
    currentPage.value = Math.min(currentPage.value, maxPage)
    ElMessage.success(t('dashboard.batchDeleteSuccess'))
  } finally {
    batchDeleting.value = false
  }
}
</script>

<style scoped>
.dashboard {
  padding: 24px;
}

h2 {
  margin: 0 0 24px;
  font-size: 22px;
  color: #303133;
}

.stat-cards {
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}

.task-table-card {
  margin-top: 8px;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.dashboard-filter {
  width: 138px;
}

.searchable-column-header {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  width: 100%;
}

.table-header-search-input {
  width: 100%;
  max-width: 240px;
}

.table-header-search-button {
  min-height: 24px;
  min-width: 24px;
  padding: 0;
}

.failure-detail {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.detail-message {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pagination-row {
  display: flex;
  justify-content: flex-end;
  margin-top: 16px;
}

.created-time {
  display: flex;
  flex-direction: column;
  gap: 2px;
  line-height: 1.35;
}

.created-time span:last-child {
  color: #909399;
  font-size: 12px;
}

:global(.correction-dialog .el-dialog__body) {
  min-height: 0;
  padding-top: 10px;
  padding-bottom: 10px;
  overflow-y: auto;
}

:global(.correction-dialog .el-dialog__footer) {
  padding-top: 10px;
}

:global(.correction-dialog) {
  display: flex;
  max-height: calc(100vh - 32px);
  flex-direction: column;
  overflow: hidden;
}

.correction-layout {
  display: grid;
  gap: 14px;
}

.correction-main-grid {
  --correction-panel-height: 560px;
  display: grid;
  grid-template-columns: minmax(0, 0.92fr) minmax(0, 1.08fr);
  gap: 16px;
  align-items: stretch;
}

.correction-left-column {
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 12px;
  box-sizing: border-box;
  height: var(--correction-panel-height);
  min-height: 0;
  padding: 14px;
  border-radius: 6px;
  background: #fcfdff;
  box-shadow: 0 0 0 1px rgba(148, 163, 184, 0.16), 0 8px 18px rgba(31, 45, 61, 0.05);
  overflow: hidden;
}

.correction-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.correction-section h3 {
  margin: 0;
  font-size: 14px;
  color: #303133;
}

.current-info-section {
  padding: 14px;
  border-radius: 6px;
  background: #f7fbff;
  box-shadow: 0 0 0 1px rgba(64, 158, 255, 0.14), 0 8px 18px rgba(31, 45, 61, 0.06);
}

.current-info-section :deep(.el-descriptions__label) {
  width: 132px;
}

.current-info-section :deep(.el-descriptions__content) {
  max-width: 0;
}

.correction-scope-section {
  padding: 14px;
  border-radius: 6px;
  background: #fffaf2;
  box-shadow: 0 0 0 1px rgba(230, 162, 60, 0.18), 0 8px 18px rgba(31, 45, 61, 0.05);
}

.correction-scope-options {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  width: 100%;
}

.correction-scope-options :deep(.el-radio-button) {
  width: 100%;
}

.correction-scope-options :deep(.el-radio-button__inner) {
  display: flex;
  flex-direction: column;
  gap: 4px;
  width: 100%;
  min-height: 54px;
  align-items: flex-start;
  justify-content: center;
  padding: 8px 14px;
  text-align: left;
}

.correction-scope-options small {
  overflow: hidden;
  width: 100%;
  color: #909399;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.correction-scope-options :deep(.el-radio-button.is-active small) {
  color: rgba(255, 255, 255, 0.86);
}

.preview-path-descriptions :deep(.el-descriptions__label) {
  width: 154px;
  white-space: nowrap;
}

.preview-path-descriptions :deep(.el-descriptions__content) {
  max-width: 0;
}

.section-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.section-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.correction-form :deep(.el-input-number) {
  width: 100%;
}

.correction-form :deep(.el-form-item) {
  margin-bottom: 10px;
}

.correction-form-actions {
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 32px;
}

.muted-path {
  color: #606266;
  word-break: break-all;
  line-height: 1.35;
}

.candidate-list {
  display: grid;
  flex: 1;
  gap: 6px;
  align-content: start;
  min-height: 0;
  padding-right: 4px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.candidate-section {
  min-height: 0;
  overflow: hidden;
}

.candidate-row {
  display: grid;
  grid-template-columns: 42px minmax(0, 1fr);
  gap: 10px;
  align-items: center;
  width: 100%;
  min-height: 34px;
  padding: 6px 10px;
  border: 1px solid #dcdfe6;
  border-radius: 6px;
  background: #fff;
  color: #303133;
  cursor: pointer;
  text-align: left;
}

.candidate-row:hover,
.candidate-row.selected {
  border-color: #409eff;
  background: #ecf5ff;
}

.candidate-row.disabled {
  border-color: #ebeef5;
  background: #f5f7fa;
  color: #a8abb2;
  cursor: not-allowed;
}

.candidate-title,
.candidate-original-title,
.candidate-meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.candidate-copy {
  display: grid;
  gap: 2px;
  min-width: 0;
}

.candidate-original-title {
  color: #606266;
  font-size: 12px;
}

.candidate-poster {
  width: 36px;
  height: 50px;
  border-radius: 4px;
  object-fit: cover;
}

.candidate-poster-placeholder {
  display: grid;
  place-items: center;
  background: #ebeef5;
  color: #909399;
  font-size: 11px;
}

.candidate-meta {
  color: #909399;
  font-size: 12px;
}

.preview-panel {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  padding-right: 4px;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.batch-preview-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.batch-fingerprint {
  align-self: center;
  color: #909399;
  cursor: help;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
}

.same-path-tag {
  margin-left: 6px;
}

.batch-item-detail {
  display: grid;
  gap: 8px;
  padding: 8px 14px 12px;
}

.batch-progress-section {
  gap: 16px;
  padding: 18px;
  border-radius: 8px;
  background: #fcfdff;
  box-shadow: 0 0 0 1px rgba(64, 158, 255, 0.14), 0 10px 24px rgba(31, 45, 61, 0.07);
}

.batch-progress-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.batch-progress-header h3 {
  margin-bottom: 5px;
  font-size: 16px;
}

.batch-progress-subtitle {
  color: #606266;
  font-size: 13px;
}

.batch-summary-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.batch-summary-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  border-radius: 6px;
  background: #ecf5ff;
  color: #409eff;
}

.batch-summary-card strong {
  font-size: 18px;
}

.batch-summary-card span {
  color: #606266;
  font-size: 12px;
}

.batch-summary-card.success {
  background: #f0f9eb;
  color: #67c23a;
}

.batch-summary-card.danger {
  background: #fef0f0;
  color: #f56c6c;
}

.batch-summary-card.muted {
  background: #f4f4f5;
  color: #909399;
}

.message-stack {
  display: grid;
  gap: 6px;
}

.operation-table {
  width: 100%;
}

.preview-section {
  box-sizing: border-box;
  height: var(--correction-panel-height);
  min-height: 0;
  min-width: 0;
  padding: 14px;
  border-radius: 6px;
  background: #fff;
  box-shadow: 0 0 0 1px rgba(64, 158, 255, 0.12), 0 8px 20px rgba(31, 45, 61, 0.07);
  overflow: hidden;
}

@media (max-width: 1200px) {
  .stat-cards {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .correction-main-grid {
    grid-template-columns: 1fr;
  }

  .correction-left-column {
    padding: 12px;
  }

  .batch-summary-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 720px) {
  .stat-cards {
    grid-template-columns: 1fr;
  }

  .card-header,
  .header-actions,
  .section-title-row {
    align-items: stretch;
    flex-direction: column;
  }

  .dashboard-filter {
    width: 100%;
  }

  .correction-scope-options,
  .batch-summary-grid {
    grid-template-columns: 1fr;
  }

  .batch-progress-header {
    align-items: stretch;
    flex-direction: column;
  }

  .candidate-row {
    grid-template-columns: 42px minmax(0, 1fr);
  }
}
</style>
