<template>
  <transition name="floating-action-fade">
    <div v-show="visible" class="floating-action-group">
      <el-tooltip :content="label" placement="left">
        <el-button
          class="floating-action-button"
          type="primary"
          circle
          :icon="Top"
          :aria-label="label"
          @click="scrollToTop"
        />
      </el-tooltip>
    </div>
  </transition>
</template>

<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { Top } from '@element-plus/icons-vue'

const props = withDefaults(defineProps<{
  label: string
  target?: string
  visibilityHeight?: number
}>(), {
  target: '.layout-main',
  visibilityHeight: 200,
})

const visible = ref(false)
let scrollContainer: HTMLElement | null = null

function updateVisibility() {
  visible.value = (scrollContainer?.scrollTop ?? 0) >= props.visibilityHeight
}

function scrollToTop() {
  scrollContainer?.scrollTo({
    top: 0,
    behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
  })
}

onMounted(() => {
  scrollContainer = document.querySelector<HTMLElement>(props.target)
  scrollContainer?.addEventListener('scroll', updateVisibility, { passive: true })
  updateVisibility()
})

onBeforeUnmount(() => {
  scrollContainer?.removeEventListener('scroll', updateVisibility)
})
</script>

<style scoped>
.floating-action-group {
  position: fixed;
  right: 32px;
  bottom: 32px;
  z-index: 10;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.floating-action-button {
  width: 44px;
  height: 44px;
  box-shadow: 0 6px 18px rgba(64, 158, 255, 0.35);
}

.floating-action-fade-enter-active,
.floating-action-fade-leave-active {
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.floating-action-fade-enter-from,
.floating-action-fade-leave-to {
  opacity: 0;
  transform: translateY(8px);
}

@media (max-width: 760px) {
  .floating-action-group {
    right: 20px;
    bottom: 20px;
  }
}
</style>
