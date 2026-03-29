<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { FolderOpen } from '@icon-park/vue-next'
import { ElMessage } from 'element-plus'
import { applyThemeMode, bindSystemTheme } from '../theme'
import { useRuntimeStore } from '../stores/runtime'

const loading = ref(false)
const saving = ref(false)
const lanSaving = ref(false)
const lanLoading = ref(false)
const backupDir = ref('')
const themeMode = ref('system')
const lanEnabled = ref(false)
const lanState = ref(null)
const lanNodes = ref([])
const activeSettingsTab = ref('general')
const error = ref('')
const runtimeStore = useRuntimeStore()
let removeLanStateUpdatedListener = null

const protocolVersionLabel = computed(() => {
  const raw = String(lanState.value?.protocolVersion || '').trim()
  if (!raw) return '-'
  const normalized = raw.replace(/^v/i, '')
  if (/^\d+$/.test(normalized)) return `V${normalized}.0.0`
  if (/^\d+\.\d+$/.test(normalized)) return `V${normalized}.0`
  if (/^\d+\.\d+\.\d+$/.test(normalized)) return `V${normalized}`
  return `V${normalized}`
})

async function loadSettings() {
  if (!window.eleDrive?.getSettings) return
  loading.value = true
  error.value = ''
  try {
    const settings = await window.eleDrive.getSettings()
    backupDir.value = settings.backupDir || ''
    themeMode.value = settings.themeMode || 'system'
    lanEnabled.value = Boolean(settings.lanEnabled)
    runtimeStore.setSettings(settings || {})
    applyThemeMode(themeMode.value)
    bindSystemTheme(themeMode.value)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

function applyLanState(state) {
  const payload = state || {}
  lanState.value = payload
  lanNodes.value = Array.isArray(payload?.nodes) ? payload.nodes : []
  lanEnabled.value = Boolean(payload?.enabled)
  runtimeStore.setLanState(payload)
}

async function loadLanState() {
  if (!window.eleDrive?.getLanState) return
  lanLoading.value = true
  try {
    const state = await window.eleDrive.getLanState()
    applyLanState(state)
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    lanLoading.value = false
  }
}

function subscribeLanState() {
  if (!window.eleDrive?.onLanStateUpdated) return
  if (typeof removeLanStateUpdatedListener === 'function') {
    removeLanStateUpdatedListener()
  }
  removeLanStateUpdatedListener = window.eleDrive.onLanStateUpdated((payload) => {
    applyLanState(payload || {})
  })
}

async function handleLanToggle(value) {
  if (!window.eleDrive?.setLanEnabled) return
  const nextValue = Boolean(value)
  lanSaving.value = true
  error.value = ''
  try {
    const result = await window.eleDrive.setLanEnabled({ enabled: nextValue })
    lanEnabled.value = Boolean(result?.enabled)
    runtimeStore.setLanEnabled(lanEnabled.value)
    await loadLanState()
    ElMessage.success(lanEnabled.value ? '局域网组网已开启' : '局域网组网已关闭')
  } catch (err) {
    lanEnabled.value = !nextValue
    error.value = err instanceof Error ? err.message : String(err)
    ElMessage.error('局域网组网配置更新失败')
  } finally {
    lanSaving.value = false
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

onMounted(async () => {
  subscribeLanState()
  await loadSettings()
  await loadLanState()
})

onUnmounted(() => {
  if (typeof removeLanStateUpdatedListener === 'function') {
    removeLanStateUpdatedListener()
  }
  removeLanStateUpdatedListener = null
})
</script>

<template>
  <el-card class="panel-card" shadow="never">
    <template #header>
      <div class="panel-title-wrap">
        <h1>系统设置</h1>
        <el-tag type="warning">自动保存</el-tag>
      </div>
    </template>

    <el-skeleton v-if="loading" :rows="4" animated />

    <el-tabs v-else v-model="activeSettingsTab" type="card" class="settings-tabs">
      <el-tab-pane label="常规" name="general">
        <el-form label-position="top" class="settings-form">
          <el-form-item label="主题模式">
            <el-select v-model="themeMode" :disabled="saving" @change="saveThemeMode">
              <el-option label="亮色" value="light" />
              <el-option label="暗色" value="dark" />
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
      </el-tab-pane>

      <el-tab-pane label="局域网" name="lan">
        <div class="panel-title-wrap settings-lan-toggle-row">
          <span class="settings-lan-toggle-title">
            <span class="settings-lan-toggle-name">局域网组网</span>
            <el-tag class="settings-lan-protocol-tag" size="small" type="info" effect="plain">
              {{ protocolVersionLabel }}
            </el-tag>
          </span>
          <el-switch
            class="settings-lan-switch"
            v-model="lanEnabled"
            size="large"
            :disabled="saving || lanSaving"
            :loading="lanSaving"
            inline-prompt
            active-text="开启"
            inactive-text="关闭"
            @change="handleLanToggle"
          />
        </div>

        <el-card v-if="lanEnabled" class="status-alert" shadow="never">
          <template #header>
            <div class="settings-lan-header-row">
              <div class="settings-lan-header-left">
                <span>节点列表</span>
                <span class="settings-lan-node-id">[{{ lanState?.nodeId || '-' }}]</span>
              </div>
              <div class="settings-lan-header-right">
                <span class="settings-lan-online-count">在线节点数：</span>
                <el-tag type="success" size="small">{{ lanNodes.length }}</el-tag>
              </div>
            </div>
          </template>

          <div
            class="settings-lan-panel"
            v-loading="lanLoading"
            element-loading-text="同步节点中..."
            element-loading-background="rgba(255, 255, 255, 0.72)"
          >
            <el-table :data="lanNodes" class="settings-lan-table" style="margin-top: 8px" empty-text="未发现其他在线节点">
              <el-table-column label="节点" min-width="140" show-overflow-tooltip>
                <template #default="{ row }">{{ row.machineName || row.nodeId }}</template>
              </el-table-column>
              <el-table-column prop="host" label="地址" width="132" />
              <el-table-column prop="appVersion" label="版本" width="90" />
              <el-table-column prop="arch" label="架构" width="70" />
            </el-table>
          </div>
        </el-card>
      </el-tab-pane>
    </el-tabs>

    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="status-alert" />
  </el-card>
</template>
