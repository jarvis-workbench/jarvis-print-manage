<script setup>
import { onMounted, ref } from 'vue'
import { Theme, FolderOpen } from '@icon-park/vue-next'
import { ElMessage } from 'element-plus'
import { applyThemeMode, bindSystemTheme } from '../theme'
import { useRuntimeStore } from '../stores/runtime'

const loading = ref(false)
const saving = ref(false)
const backupDir = ref('')
const themeMode = ref('system')
const error = ref('')
const runtimeStore = useRuntimeStore()

async function loadSettings() {
  if (!window.eleDrive?.getSettings) return
  loading.value = true
  error.value = ''
  try {
    const settings = await window.eleDrive.getSettings()
    backupDir.value = settings.backupDir || ''
    themeMode.value = settings.themeMode || 'system'
    runtimeStore.setSettings(settings || {})
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
    runtimeStore.setSettings(saved || {})
    applyThemeMode(themeMode.value)
    bindSystemTheme(themeMode.value)
    ElMessage.success('配置保存成功')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}

async function chooseBackupDirByInput() {
  if (!window.eleDrive?.chooseBackupDir || !window.eleDrive?.setBackupDir) return
  error.value = ''
  try {
    const selected = await window.eleDrive.chooseBackupDir()
    if (!selected) return
    saving.value = true
    const saved = await window.eleDrive.setBackupDir(selected)
    backupDir.value = saved.backupDir
    runtimeStore.setSettings(saved || {})
    ElMessage.success('配置保存成功')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    saving.value = false
  }
}

onMounted(loadSettings)
</script>

<template>
  <el-card class="panel-card" shadow="never">
    <template #header>
      <div class="panel-title-wrap">
        <h1>系统设置</h1>
        <el-tag type="warning">自动保存</el-tag>
      </div>
    </template>

    <div class="settings-hint settings-hint-top">
      <theme theme="outline" size="16" />
      <span>所有配置项更改后会立即保存。</span>
    </div>

    <el-skeleton v-if="loading" :rows="4" animated />

    <el-form v-else label-position="top" class="settings-form">
      <el-form-item label="主题模式">
        <el-select v-model="themeMode" :disabled="saving" @change="saveThemeMode">
          <el-option label="亮" value="light" />
          <el-option label="暗" value="dark" />
          <el-option label="跟随系统" value="system" />
        </el-select>
      </el-form-item>

      <el-form-item label="打印机驱动备份目录">
        <el-input
          v-model="backupDir"
          readonly
          :disabled="saving"
          placeholder="点击输入框选择目录"
          @click="chooseBackupDirByInput"
        >
          <template #prefix>
            <folder-open theme="outline" size="15" />
          </template>
        </el-input>
      </el-form-item>
    </el-form>

    <el-alert
      v-if="saving"
      title="正在保存配置..."
      type="info"
      :closable="false"
      show-icon
      class="status-alert"
    />
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="status-alert" />
  </el-card>
</template>
