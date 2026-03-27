<script setup>
import { onMounted, ref } from 'vue'
import { applyThemeMode, bindSystemTheme } from '../theme'

const loading = ref(false)
const saving = ref(false)
const backupDir = ref('')
const themeMode = ref('system')
const error = ref('')

async function loadSettings() {
  if (!window.eleDrive?.getSettings) return
  loading.value = true
  error.value = ''
  try {
    const settings = await window.eleDrive.getSettings()
    backupDir.value = settings.backupDir || ''
    themeMode.value = settings.themeMode || 'system'
    applyThemeMode(themeMode.value)
    bindSystemTheme(themeMode.value)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function saveThemeMode() {
  if (!window.eleDrive?.setThemeMode) return
  saving.value = true
  error.value = ''
  try {
    const saved = await window.eleDrive.setThemeMode(themeMode.value)
    themeMode.value = saved.themeMode
    applyThemeMode(themeMode.value)
    bindSystemTheme(themeMode.value)
    window.alert('配置保存成功')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}

async function chooseBackupDirByInput() {
  if (!window.eleDrive?.chooseBackupDir || !window.eleDrive?.setBackupDir) return
  saving.value = true
  error.value = ''
  try {
    const selected = await window.eleDrive.chooseBackupDir()
    if (!selected) return
    const saved = await window.eleDrive.setBackupDir(selected)
    backupDir.value = saved.backupDir
    window.alert('配置保存成功')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}

onMounted(loadSettings)
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <h1>系统设置</h1>
      <span class="badge badge-soft">自动保存</span>
    </div>
    <p class="hint">所有配置项更改后将自动保存，无需手动点击保存按钮。</p>

    <div v-if="loading" class="state-text">正在加载设置...</div>

    <div v-else class="form-grid">
      <label class="field-label" for="themeMode">主题模式</label>
      <select id="themeMode" v-model="themeMode" class="text-input" :disabled="saving" @change="saveThemeMode">
        <option value="light">亮</option>
        <option value="dark">暗</option>
        <option value="system">跟随系统</option>
      </select>

      <label class="field-label" for="backupDir">备份驱动目录</label>
      <input
        id="backupDir"
        v-model="backupDir"
        class="text-input readonly-picker"
        type="text"
        placeholder="点击选择目录"
        readonly
        :disabled="saving"
        @click="chooseBackupDirByInput"
      />
    </div>

    <p v-if="saving" class="state-text">正在保存配置...</p>
    <p v-if="error" class="error-text">{{ error }}</p>
  </section>
</template>
