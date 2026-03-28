<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { Theme, FolderOpen } from '@icon-park/vue-next'
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
const error = ref('')
const runtimeStore = useRuntimeStore()
let removeLanStateUpdatedListener = null

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

      <el-form-item label="局域网组网">
        <el-switch
          v-model="lanEnabled"
          :disabled="saving || lanSaving"
          :loading="lanSaving"
          inline-prompt
          active-text="开启"
          inactive-text="关闭"
          @change="handleLanToggle"
        />
        <div class="settings-hint">
          <span>开启后可发现同网段节点，为后续驱动共享提供通讯底座。</span>
        </div>
      </el-form-item>
    </el-form>

    <el-card v-if="!loading" class="status-alert" shadow="never">
      <template #header>
        <div class="panel-title-wrap">
          <span>局域网节点状态</span>
          <el-tag :type="lanEnabled ? 'success' : 'info'">{{ lanEnabled ? '已开启' : '未开启' }}</el-tag>
        </div>
      </template>

      <el-skeleton v-if="lanLoading" :rows="3" animated />
      <template v-else>
        <div class="cell-sub">本机节点：{{ lanState?.nodeId || '-' }}</div>
        <div class="cell-sub">协议版本：{{ lanState?.protocolVersion || '-' }}</div>
        <div class="cell-sub">在线节点数：{{ lanNodes.length }}</div>
        <el-table :data="lanNodes" size="small" style="margin-top: 8px" empty-text="未发现其他在线节点">
          <el-table-column label="节点" min-width="140" show-overflow-tooltip>
            <template #default="{ row }">{{ row.machineName || row.nodeId }}</template>
          </el-table-column>
          <el-table-column prop="host" label="地址" width="132" />
          <el-table-column prop="appVersion" label="版本" width="90" />
          <el-table-column prop="arch" label="架构" width="70" />
        </el-table>
      </template>
    </el-card>

    <el-alert
      v-if="saving || lanSaving"
      title="正在保存配置..."
      type="info"
      :closable="false"
      show-icon
      class="status-alert"
    />
    <el-alert v-if="error" :title="error" type="error" :closable="false" show-icon class="status-alert" />
  </el-card>
</template>
