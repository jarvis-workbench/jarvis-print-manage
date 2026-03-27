<script setup>
import { computed, onMounted, ref } from 'vue'
import { RefreshOne, Download, Upload, Delete } from '@icon-park/vue-next'
import { ElMessage, ElMessageBox } from 'element-plus'

const loading = ref(false)
const savingAction = ref('')
const error = ref('')
const message = ref('')

const installedPrinters = ref([])
const indexEntries = ref([])
const backupDir = ref('')

const rows = computed(() => {
  const map = new Map()

  for (const item of installedPrinters.value) {
      map.set(item.name, {
        printerName: item.name,
        installed: true,
        indexed: false,
        portName: item.portName || '',
        driverName: item.driverName || '',
        manufacturer: item.driver?.manufacturer || '',
        driverVersion: item.driver?.driverVersion || '',
        systemInfPath: item.driver?.infPath || '',
        infRelativePath: '',
      })
  }

  for (const entry of indexEntries.value) {
    const existing = map.get(entry.printerName)
    if (existing) {
      map.set(entry.printerName, {
        ...existing,
        indexed: true,
        driverName: existing.driverName || entry.driverName || '',
        manufacturer: existing.manufacturer || entry.manufacturer || '',
        driverVersion: existing.driverVersion || entry.driverVersion || '',
        systemInfPath: existing.systemInfPath || '',
        infRelativePath: entry.infRelativePath || '',
      })
    } else {
      map.set(entry.printerName, {
        printerName: entry.printerName,
        installed: false,
        indexed: true,
        portName: entry.portName || '',
        driverName: entry.driverName || '',
        manufacturer: entry.manufacturer || '',
        driverVersion: entry.driverVersion || '',
        systemInfPath: '',
        infRelativePath: entry.infRelativePath || '',
      })
    }
  }

  return [...map.values()].sort((a, b) => a.printerName.localeCompare(b.printerName))
})

const totalPrinters = computed(() => rows.value.length)

function canBackup(row) {
  return row.installed && !row.indexed
}

function canInstall(row) {
  return !row.installed && row.indexed
}

function canUninstall(row) {
  return row.installed
}

function backupTagType(row) {
  return row.indexed ? 'success' : 'info'
}

function backupTagText(row) {
  return row.indexed ? '已备份' : '未备份'
}

function infDisplayText(row) {
  if (row.installed) return row.systemInfPath || '(路径不可用)'
  return '驱动未安装'
}

async function loadPrinters() {
  if (!window.eleDrive?.listInstalledPrinters || !window.eleDrive?.getDriverIndex) return
  loading.value = true
  error.value = ''
  try {
    const [installed, indexPayload] = await Promise.all([
      window.eleDrive.listInstalledPrinters(),
      window.eleDrive.getDriverIndex(),
    ])

    installedPrinters.value = installed
    indexEntries.value = indexPayload?.index?.entries || []
    backupDir.value = indexPayload?.backupDir || ''
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function backupDriver(row) {
  if (!window.eleDrive?.backupPrinterDriver) return
  savingAction.value = `backup:${row.printerName}`
  error.value = ''
  try {
    await window.eleDrive.backupPrinterDriver({ printerName: row.printerName })
    ElMessage.success('备份成功')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    ElMessage.error('备份失败')
  } finally {
    savingAction.value = ''
    await loadPrinters()
  }
}

async function installDriver(row) {
  if (!window.eleDrive?.installPrinter) return
  savingAction.value = `install:${row.printerName}`
  error.value = ''
  try {
    await window.eleDrive.installPrinter({ printerName: row.printerName })
    ElMessage.success('安装成功')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    error.value = detail
    ElMessage.error(`安装失败：${detail}`)
  } finally {
    savingAction.value = ''
    await loadPrinters()
  }
}

async function uninstallDriver(row) {
  if (!window.eleDrive?.uninstallPrinter) return

  try {
    await ElMessageBox.confirm(`确认卸载打印机“${row.printerName}”？`, '确认卸载', {
      confirmButtonText: '确认卸载',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }

  savingAction.value = `uninstall:${row.printerName}`
  error.value = ''
  try {
    const result = await window.eleDrive.uninstallPrinter({ printerName: row.printerName })
    const repoResidues = result.fileRepoResidues?.length || 0
    const spoolResidues = result.spoolResidues?.length || 0
    if (result.driverRemoved === false) {
      const reason = result.driverRemoveError ? `：${result.driverRemoveError}` : ''
      ElMessage.warning(`打印机已卸载，但驱动未删除${reason}`)
    } else if (result.portRemoved === false && result.portName) {
      const reason = result.portRemoveError ? `：${result.portRemoveError}` : ''
      ElMessage.warning(`打印机和驱动已卸载，但端口未删除${reason}`)
    } else if (repoResidues > 0 || spoolResidues > 0) {
      const reason = result.spoolCleanupError ? `；清理详情：${result.spoolCleanupError}` : ''
      ElMessage.warning(`打印机/驱动已卸载，但仍检测到残留文件（FileRepository:${repoResidues}，Spool:${spoolResidues}）${reason}`)
    } else {
      ElMessage.success('卸载成功')
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    ElMessage.error('卸载失败')
  } finally {
    savingAction.value = ''
    await loadPrinters()
  }
}

onMounted(loadPrinters)
</script>

<template>
  <el-card class="panel-card" shadow="never">
    <template #header>
      <div class="panel-head">
        <div class="panel-title-wrap">
          <h1>打印机管理</h1>
          <el-tag>共 {{ totalPrinters }} 台</el-tag>
        </div>
        <el-button :loading="loading" @click="loadPrinters">
          <refresh-one theme="outline" size="14" />
          <span>刷新列表</span>
        </el-button>
      </div>
    </template>

    <p class="hint">当前驱动备份目录：{{ backupDir || '-' }}</p>

    <el-alert v-if="message" :title="message" type="success" show-icon :closable="false" class="status-alert" />
    <el-alert v-if="error" :title="error" type="error" show-icon :closable="false" class="status-alert" />

    <el-table
      :data="rows"
      v-loading="loading"
      row-key="printerName"
      class="printer-table"
      empty-text="未读取到打印机或备份索引"
      table-layout="fixed"
      :fit="true"
    >
      <el-table-column type="expand" width="46">
        <template #default="{ row }">
          <el-descriptions :column="1" border size="small" class="expand-desc">
            <el-descriptions-item label="厂商">{{ row.manufacturer || '-' }}</el-descriptions-item>
            <el-descriptions-item label="索引INF">
              <span class="mono">{{ infDisplayText(row) }}</span>
            </el-descriptions-item>
          </el-descriptions>
        </template>
      </el-table-column>

      <el-table-column label="打印机" width="240" show-overflow-tooltip>
        <template #default="{ row }">
          <el-tag size="small" :type="backupTagType(row)" effect="plain">{{ backupTagText(row) }}</el-tag>
          <div class="cell-title" :title="row.printerName">{{ row.printerName }}</div>
          <div class="cell-sub" :title="row.portName || '-'">端口：{{ row.portName || '-' }}</div>
        </template>
      </el-table-column>

      <el-table-column label="驱动" min-width="250" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="cell-title" :title="row.driverName || '-'">{{ row.driverName || '-' }}</div>
          <div class="cell-sub" :title="row.driverVersion || '-'">版本：{{ row.driverVersion || '-' }}</div>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="230" align="center">
        <template #default="{ row }">
          <div class="action-row">
            <el-button
              v-if="canBackup(row)"
              type="primary"
              :loading="savingAction === `backup:${row.printerName}`"
              @click="backupDriver(row)"
            >
              <download theme="outline" size="14" />
              <span>备份</span>
            </el-button>

            <el-button
              v-if="canInstall(row)"
              type="success"
              :loading="savingAction === `install:${row.printerName}`"
              @click="installDriver(row)"
            >
              <upload theme="outline" size="14" />
              <span>安装</span>
            </el-button>

            <el-button
              v-if="canUninstall(row)"
              type="danger"
              :loading="savingAction === `uninstall:${row.printerName}`"
              @click="uninstallDriver(row)"
            >
              <delete theme="outline" size="14" />
              <span>卸载</span>
            </el-button>
          </div>
        </template>
      </el-table-column>
    </el-table>
  </el-card>
</template>
