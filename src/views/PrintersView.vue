<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { storeToRefs } from 'pinia'
import { RefreshOne, Download, Upload, Delete } from '@icon-park/vue-next'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRuntimeStore } from '../stores/runtime'

const loading = ref(false)
const savingAction = ref('')
const uninstalling = ref(false)
const installWizardVisible = ref(false)
const installWizardSubmitting = ref(false)
const installWizardStep = ref(0)
const installWizardAdvancing = ref(false)
const installWizardRow = ref(null)
const installWizardPrinterName = ref('')
const installWizardIp = ref('')
const installWizardIpChecking = ref(false)
const installWizardIpStatus = ref('')
const installWizardIpMessage = ref('')
const openingSystemWizard = ref(false)
const addPrinterDialogVisible = ref(false)
const error = ref('')
const message = ref('')

const runtimeStore = useRuntimeStore()
const { settings, PrinterServerManage } = storeToRefs(runtimeStore)
const waitingUsbReconnectNames = ref(new Set())
let removePrinterStateUpdatedListener = null

const rows = computed(() => (Array.isArray(PrinterServerManage.value?.printers) ? PrinterServerManage.value.printers : []))

const totalPrinters = computed(() => rows.value.length)
const installWizardNeedsIpStep = computed(() => isIpPortProfile(installWizardRow.value))
const installWizardBusy = computed(() => installWizardSubmitting.value || installWizardIpChecking.value || installWizardAdvancing.value)
const installFlowActive = computed(() => installWizardVisible.value || installWizardBusy.value || savingAction.value.startsWith('install:'))
const installWizardPrimaryText = computed(() => {
  if (installWizardNeedsIpStep.value && installWizardStep.value === 0) return '下一步'
  return '开始安装'
})

function normalizePrinterKey(value) {
  return String(value || '').trim().toLowerCase()
}

function parseIpCandidate(rawValue) {
  const raw = String(rawValue || '').trim()
  if (!raw) return ''
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw)) return raw
  const m = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3})[_-]\d+$/)
  return m ? m[1] : ''
}

function isValidIpv4(ip) {
  const text = String(ip || '').trim()
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) return false
  return text.split('.').every((part) => {
    const n = Number(part)
    return Number.isInteger(n) && n >= 0 && n <= 255
  })
}

function isIpPortProfile(row) {
  const host = parseIpCandidate(row?.portHostAddress || row?.portName || '')
  return Boolean(host)
}

function getDefaultWizardIp(row) {
  return parseIpCandidate(row?.portHostAddress || row?.portName || '')
}

function hasWaitingUsbReconnect(row) {
  const key = normalizePrinterKey(row?.printerName)
  return waitingUsbReconnectNames.value.has(key)
}

function markWaitingUsbReconnect(printerName, waiting) {
  const key = normalizePrinterKey(printerName)
  if (!key) return
  const next = new Set(waitingUsbReconnectNames.value)
  if (waiting) {
    next.add(key)
  } else {
    next.delete(key)
  }
  waitingUsbReconnectNames.value = next
}

function reconcileWaitingUsbReconnectState(printers) {
  if (!waitingUsbReconnectNames.value.size) return
  const printerList = Array.isArray(printers) ? printers : []
  const installedList = printerList.filter((item) => item?.installed)
  const backupList = printerList.filter((item) => item?.backup)
  const installedSet = new Set(installedList.map((item) => normalizePrinterKey(item?.printerName)))
  const installedDriverSet = new Set(
    installedList
      .map((item) => String(item?.driverName || '').trim().toLowerCase())
      .filter(Boolean),
  )
  const backupMap = new Map(
    backupList
      .map((item) => [normalizePrinterKey(item?.printerName), item])
      .filter(([key]) => Boolean(key)),
  )
  const next = new Set()
  for (const key of waitingUsbReconnectNames.value) {
    const backupItem = backupMap.get(key)
    if (!backupItem) continue
    if (installedSet.has(key)) continue
    const backupDriverName = String(backupItem?.driverName || '').trim().toLowerCase()
    if (backupDriverName && installedDriverSet.has(backupDriverName)) continue
    next.add(key)
  }
  waitingUsbReconnectNames.value = next
}

function canBackup(row) {
  return row.installed && !row.backup
}

function canInstall(row) {
  return !row.installed && row.backup && !hasWaitingUsbReconnect(row)
}

function canUninstall(row) {
  return row.installed
}

function driverStatusType(row) {
  if (!row?.installed) return 'info'
  return row?.backup ? 'success' : 'warning'
}

function driverStatusText(row) {
  if (!row?.installed) return '未安装'
  return row?.backup ? '已备份' : '未备份'
}

function infDisplayText(row) {
  if (row.installed) return row.systemInfPath || '(路径不可用)'
  return '驱动未安装'
}

function displayPortName(row) {
  if (!row?.installed && row?.backup && /^USB/i.test(String(row?.portName || ''))) {
    return 'USB'
  }
  return row?.portName || '-'
}

function displayPortLabel(row) {
  if (!row?.installed && row?.backup) {
    return '驱动备份端口'
  }
  return '端口'
}

function printerAvailabilityText(row) {
  if (!row?.installed) return '未安装'
  const availability = String(row?.availability || row?.runtimeAvailability || '').toLowerCase()
  const statusText = String(row?.printerStatus ?? '').toLowerCase()
  const statusNum = Number(row?.printerStatus)
  if (availability === 'offline') return '脱机'
  if (row?.workOffline) return '脱机'
  if (Number.isFinite(statusNum) && (statusNum === 7 || statusNum === 8)) return '脱机'
  if (
    statusText.includes('offline') ||
    statusText.includes('脱机') ||
    statusText.includes('离线') ||
    statusText.includes('離線')
  ) {
    return '脱机'
  }
  if (availability === 'ready') return '就绪'
  return '就绪'
}

function printerAvailabilityType(row) {
  const status = printerAvailabilityText(row)
  if (status === '就绪') return 'success'
  if (status === '脱机') return 'danger'
  return 'info'
}

async function loadPrinters(options = {}) {
  const silent = Boolean(options?.silent)
  if (!window.eleDrive?.listInstalledPrinters || !window.eleDrive?.getDriverIndex) return
  if (!silent) {
    loading.value = true
    error.value = ''
  }
  try {
    const [installed, indexPayload] = await Promise.all([
      window.eleDrive.listInstalledPrinters(),
      window.eleDrive.getDriverIndex(),
    ])
    runtimeStore.setPrinterSnapshot({
      installedPrinters: installed,
      driverIndexEntries: indexPayload?.index?.entries || [],
      backupDir: indexPayload?.backupDir || '',
    })
    reconcileWaitingUsbReconnectState(runtimeStore.PrinterServerManage?.printers)
  } catch (err) {
    if (!silent) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  } finally {
    if (!silent) {
      loading.value = false
    }
  }
}

async function handlePrinterStateUpdated(payload) {
  if (!payload || savingAction.value) return
  runtimeStore.setPrinterRuntimeState(payload)
  const changes = payload?.changes || {}
  const hasChanges = ['addedPrinters', 'removedPrinters', 'changedPrinters', 'addedPorts', 'removedPorts']
    .some((key) => Array.isArray(changes[key]) && changes[key].length > 0)
  if (!hasChanges) return
  await loadPrinters({ silent: true })
}

function subscribePrinterRuntimeState() {
  if (!window.eleDrive?.onPrinterStateUpdated) return
  if (typeof removePrinterStateUpdatedListener === 'function') {
    removePrinterStateUpdatedListener()
  }
  removePrinterStateUpdatedListener = window.eleDrive.onPrinterStateUpdated((payload) => {
    void handlePrinterStateUpdated(payload)
  })
}

function unsubscribePrinterRuntimeState() {
  if (typeof removePrinterStateUpdatedListener === 'function') {
    removePrinterStateUpdatedListener()
  }
  removePrinterStateUpdatedListener = null
}

function applyUninstallOptimistically(row) {
  const printerName = row?.printerName
  runtimeStore.applyOptimisticUninstall({
    printerName,
    keepBackup: Boolean(row?.backup),
  })
  markWaitingUsbReconnect(printerName, false)
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

function openInstallWizard(row) {
  if (uninstalling.value) {
    ElMessage.warning('正在卸载，请卸载完成后再安装')
    return
  }
  installWizardRow.value = row
  installWizardStep.value = 0
  installWizardVisible.value = true
  installWizardAdvancing.value = false
  installWizardSubmitting.value = false
  installWizardIpChecking.value = false
  installWizardIpStatus.value = ''
  installWizardIpMessage.value = ''
  installWizardPrinterName.value = String(row?.printerName || '').trim()
  installWizardIp.value = getDefaultWizardIp(row)
}

function closeInstallWizard(force = false) {
  if (!force && installWizardBusy.value) return
  installWizardVisible.value = false
}

function isDuplicatePrinterName(name) {
  const key = normalizePrinterKey(name)
  if (!key) return false
  return rows.value.some((item) => item?.installed && normalizePrinterKey(item?.printerName) === key)
}

async function runInstallTask(row, installPayload) {
  if (!window.eleDrive?.installPrinter) return false
  savingAction.value = `install:${row.printerName}`
  error.value = ''
  let refreshedInTry = false
  let success = false
  try {
    const result = await window.eleDrive.installPrinter(installPayload)
    if (result?.status === 'driver-installed') {
      await loadPrinters({ silent: true })
      refreshedInTry = true
      const targetDriverName = String(result.driverName || row.driverName || '').toLowerCase()
      const occupied = !!targetDriverName && rows.value.some(
        (printer) => printer?.installed && String(printer.driverName || '').toLowerCase() === targetDriverName,
      )
      if (occupied) {
        markWaitingUsbReconnect(row.printerName, false)
        ElMessage.success('驱动已安装')
      } else {
        markWaitingUsbReconnect(row.printerName, true)
        ElMessage.success('驱动已安装，请重新 拔/插 打印机USB')
      }
    } else {
      markWaitingUsbReconnect(row.printerName, false)
      ElMessage.success('安装成功')
    }
    success = true
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    error.value = detail
    ElMessage.error(`安装失败：${detail}`)
  } finally {
    savingAction.value = ''
    if (!refreshedInTry) {
      void loadPrinters({ silent: true })
    }
  }
  return success
}

async function submitInstallWizard() {
  if (uninstalling.value) return
  if (installWizardSubmitting.value) return
  const row = installWizardRow.value
  if (!row) return

  const targetPrinterName = installWizardPrinterName.value.trim()
  const installPayload = {
    printerName: row.printerName,
    targetPrinterName,
    portHostAddressOverride: installWizardNeedsIpStep.value ? installWizardIp.value.trim() : '',
  }

  installWizardSubmitting.value = true
  try {
    const ok = await runInstallTask(row, installPayload)
    if (ok) {
      closeInstallWizard(true)
    }
  } finally {
    installWizardSubmitting.value = false
  }
}

async function handleInstallWizardNext() {
  if (uninstalling.value) return
  if (installWizardBusy.value) return
  installWizardAdvancing.value = true
  try {
    const row = installWizardRow.value
    if (!row) return

    const targetPrinterName = installWizardPrinterName.value.trim()
    if (!targetPrinterName) {
      ElMessage.warning('请输入打印机显示名称')
      return
    }
    if (isDuplicatePrinterName(targetPrinterName)) {
      ElMessage.warning('打印机显示名称已存在，请更换名称')
      return
    }

    if (installWizardNeedsIpStep.value && installWizardStep.value === 0) {
      installWizardStep.value = 1
      return
    }

    if (installWizardNeedsIpStep.value) {
      const host = installWizardIp.value.trim()
      if (!isValidIpv4(host)) {
        ElMessage.warning('请输入有效的IP地址')
        return
      }
      if (!window.eleDrive?.pingHost) {
        ElMessage.error('缺少网络检测能力，请重启应用后重试')
        return
      }

      installWizardIpChecking.value = true
      installWizardIpStatus.value = ''
      installWizardIpMessage.value = ''
      try {
        const pingResult = await window.eleDrive.pingHost({ host })
        if (!pingResult?.reachable) {
          installWizardIpStatus.value = 'fail'
          installWizardIpMessage.value = '无法连接至此IP，请检查网络后重试'
          ElMessage.warning('无法连接至此IP，请检查网络后重试')
          return
        }
        installWizardIpStatus.value = 'ok'
        installWizardIpMessage.value = 'IP连通检测通过'
      } catch (err) {
        installWizardIpStatus.value = 'fail'
        installWizardIpMessage.value = err instanceof Error ? err.message : String(err)
        ElMessage.warning('IP连通检测失败，请检查网络后再试')
        return
      } finally {
        installWizardIpChecking.value = false
      }
    }

    await submitInstallWizard()
  } finally {
    installWizardAdvancing.value = false
  }
}

async function handleInstallWizardUseCurrentIp() {
  if (uninstalling.value) return
  if (installWizardBusy.value) return
  const host = installWizardIp.value.trim()
  if (!isValidIpv4(host)) {
    ElMessage.warning('请输入有效的IP地址')
    return
  }
  await submitInstallWizard()
}

function handleInstallWizardPrev() {
  if (installWizardStep.value > 0) {
    installWizardStep.value -= 1
  }
}

async function uninstallDriver(row) {
  if (!window.eleDrive?.uninstallPrinter) return
  if (installFlowActive.value) {
    ElMessage.warning('正在安装，请安装完成后再卸载')
    return
  }
  if (uninstalling.value) return

  uninstalling.value = true
  let shouldRefreshAfterUninstall = false
  try {
    try {
      await ElMessageBox.confirm(`确认卸载打印机“${row.printerName}”？`, '确认卸载', {
        confirmButtonText: '确认卸载',
        cancelButtonText: '取消',
        type: 'warning',
      })
    } catch {
      return
    }

    shouldRefreshAfterUninstall = true
    savingAction.value = `uninstall:${row.printerName}`
    error.value = ''
    const result = await window.eleDrive.uninstallPrinter({ printerName: row.printerName })
    const repoResidues = result.fileRepoResidues?.length || 0
    const spoolResidues = result.spoolResidues?.length || 0
    const cleanupDetail = String(result.spoolCleanupError || '')
    const hasFileLockResidue = (repoResidues > 0 || spoolResidues > 0) && /access denied|still in use/i.test(cleanupDetail)
    if (result.driverRemoved === false) {
      const reason = result.driverRemoveError ? `：${result.driverRemoveError}` : ''
      ElMessage.warning(`打印机已卸载，但驱动未删除${reason}`)
    } else if (result.portRemoved === false && result.portName && !/^USB/i.test(result.portName)) {
      const reason = result.portRemoveError ? `：${result.portRemoveError}` : ''
      ElMessage.warning(`打印机和驱动已卸载，但端口未删除${reason}`)
    } else if (hasFileLockResidue) {
      applyUninstallOptimistically(row)
      ElMessage.success('卸载成功（部分驱动文件被系统占用，稍后会自动释放）')
    } else if (repoResidues > 0 || spoolResidues > 0) {
      ElMessage.warning(`打印机/驱动已卸载，但仍检测到残留文件（FileRepository:${repoResidues}，Spool:${spoolResidues}）`)
    } else {
      applyUninstallOptimistically(row)
      ElMessage.success('卸载成功')
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    ElMessage.error('卸载失败')
  } finally {
    if (savingAction.value.startsWith('uninstall:')) {
      savingAction.value = ''
    }
    if (shouldRefreshAfterUninstall) {
      await loadPrinters({ silent: true })
    }
    uninstalling.value = false
  }
}

function openAddPrinterDialog() {
  if (uninstalling.value) return
  addPrinterDialogVisible.value = true
}

function handleVendorInstall() {
  ElMessage.info('供应商安装功能开发中')
}

async function openSystemDriverInstall() {
  if (!window.eleDrive?.openSystemAddPrinterWizard) return
  openingSystemWizard.value = true
  try {
    await window.eleDrive.openSystemAddPrinterWizard()
    addPrinterDialogVisible.value = false
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    error.value = detail
    ElMessage.error('打开添加向导失败')
  } finally {
    openingSystemWizard.value = false
  }
}

onMounted(async () => {
  await loadPrinters()
  subscribePrinterRuntimeState()
  if (window.eleDrive?.getPrinterRuntimeState) {
    try {
      const state = await window.eleDrive.getPrinterRuntimeState()
      await handlePrinterStateUpdated(state)
    } catch {
      // ignore bootstrap state errors
    }
  }
})

onUnmounted(() => {
  unsubscribePrinterRuntimeState()
})
</script>

<template>
  <el-card class="panel-card" shadow="never">
    <template #header>
      <div class="panel-head">
        <div class="panel-title-wrap">
          <h1>打印机管理</h1>
          <el-tag>共 {{ totalPrinters }} 台</el-tag>
        </div>
        <div class="header-actions">
          <el-button type="primary" :disabled="uninstalling" @click="openAddPrinterDialog">
            <span>添加新的打印机</span>
          </el-button>
          <el-button :loading="loading" :disabled="uninstalling" @click="loadPrinters">
            <refresh-one theme="outline" size="14" />
            <span>刷新列表</span>
          </el-button>
        </div>
      </div>
    </template>

    <p class="hint">当前打印机驱动备份目录：{{ settings.backupDir || '-' }}</p>

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
            <el-descriptions-item v-if="row.installed" label="索引INF">
              <span class="mono">{{ infDisplayText(row) }}</span>
            </el-descriptions-item>
            <el-descriptions-item label="驱动状态">
              <el-tag size="small" :type="driverStatusType(row)" effect="plain">{{ driverStatusText(row) }}</el-tag>
            </el-descriptions-item>
          </el-descriptions>
        </template>
      </el-table-column>

      <el-table-column label="打印机" width="220" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="printer-cell">
            <div class="printer-cell-main">
              <div class="cell-title" :title="row.printerName">{{ row.printerName }}</div>
              <div class="cell-sub" :title="`${displayPortLabel(row)}：${displayPortName(row)}`">
                {{ displayPortLabel(row) }}：{{ displayPortName(row) }}
              </div>
              <div class="cell-sub">
                <el-tag size="small" :type="printerAvailabilityType(row)" effect="plain">
                  {{ printerAvailabilityText(row) }}
                </el-tag>
              </div>
            </div>
          </div>
        </template>
      </el-table-column>

      <el-table-column label="驱动" min-width="220" show-overflow-tooltip>
        <template #default="{ row }">
          <div class="cell-title" :title="row.driverName || '-'">{{ row.driverName || '-' }}</div>
          <div class="cell-sub" :title="row.driverVersion || '-'">版本：{{ row.driverVersion || '-' }}</div>
        </template>
      </el-table-column>

      <el-table-column label="操作" width="190" align="center">
        <template #default="{ row }">
          <div class="action-row">
            <el-button
              v-if="canBackup(row)"
              type="primary"
              size="small"
              :loading="savingAction === `backup:${row.printerName}`"
              @click="backupDriver(row)"
            >
              <upload theme="outline" size="13" />
              <span>备份</span>
            </el-button>

            <el-tag v-if="hasWaitingUsbReconnect(row)" type="warning" effect="plain" size="small">
              等待打印机USB重新接入
            </el-tag>

            <el-button
              v-if="canInstall(row)"
              type="success"
              size="small"
              :loading="savingAction === `install:${row.printerName}`"
              :disabled="uninstalling"
              @click="openInstallWizard(row)"
            >
              <download theme="outline" size="13" />
              <span>安装</span>
            </el-button>

            <el-button
              v-if="canUninstall(row)"
              type="danger"
              size="small"
              :loading="savingAction === `uninstall:${row.printerName}`"
              :disabled="uninstalling || installFlowActive"
              @click="uninstallDriver(row)"
            >
              <delete theme="outline" size="13" />
              <span>卸载</span>
            </el-button>
          </div>
        </template>
      </el-table-column>
    </el-table>

    <teleport to="body">
      <transition name="wizard-fade">
        <div v-if="installWizardVisible" class="install-wizard-overlay">
          <div class="install-wizard-panel" role="dialog" aria-modal="true" aria-label="打印机安装向导">
            <div class="install-wizard-header">
              <div class="install-wizard-title-wrap">
                <h3>打印机安装向导</h3>
                <p>从备份索引恢复驱动并完成配置</p>
              </div>
              <button type="button" class="install-wizard-close" :disabled="installWizardBusy" @click="closeInstallWizard">
                ×
              </button>
            </div>

            <div class="install-wizard-steps">
              <div
                class="install-wizard-step"
                :class="{ active: installWizardStep === 0, done: installWizardStep > 0 }"
              >
                <span class="install-wizard-step-index">1</span>
                <span class="install-wizard-step-text">打印机显示名称</span>
              </div>
              <div
                v-if="installWizardNeedsIpStep"
                class="install-wizard-step"
                :class="{ active: installWizardStep === 1 }"
              >
                <span class="install-wizard-step-index">2</span>
                <span class="install-wizard-step-text">IP端口设置</span>
              </div>
            </div>

            <div class="install-wizard-body">
              <p class="install-wizard-lead">
                {{ installWizardStep === 0 ? '步骤1：设置打印机显示名称' : '步骤2：配置IP并检测连通性' }}
              </p>
              <template v-if="installWizardStep === 0">
                <el-form label-position="top">
                  <el-form-item label="打印机显示名称">
                    <el-input
                      v-model="installWizardPrinterName"
                      :disabled="installWizardBusy"
                      placeholder="请输入打印机显示名称"
                    />
                  </el-form-item>
                </el-form>
              </template>

              <template v-else>
                <el-form label-position="top">
                  <el-form-item label="IP地址" class="install-wizard-ip-form-item">
                    <el-input
                      v-model="installWizardIp"
                      :disabled="installWizardBusy"
                      placeholder="例如：192.168.1.120"
                    />
                  </el-form-item>
                </el-form>
                <div class="install-wizard-ip-hint-row">
                  <p
                    class="install-wizard-tip"
                    :class="{
                      'is-success': installWizardIpStatus === 'ok',
                      'is-error': installWizardIpStatus === 'fail',
                      'is-placeholder': !installWizardIpMessage,
                    }"
                  >
                    {{ installWizardIpMessage || ' ' }}
                  </p>
                  <a
                    v-if="installWizardIpStatus === 'fail'"
                    class="install-wizard-use-ip-link"
                    href="#"
                    @click.prevent="handleInstallWizardUseCurrentIp"
                  >
                    任然使用此IP
                  </a>
                </div>
              </template>
            </div>

            <div class="dialog-actions install-wizard-footer">
              <el-button :disabled="installWizardBusy" @click="closeInstallWizard">
                取消
              </el-button>
              <el-button
                v-if="installWizardStep > 0"
                :disabled="installWizardBusy"
                @click="handleInstallWizardPrev"
              >
                上一步
              </el-button>
              <el-button
                type="primary"
                :loading="installWizardBusy"
                @click="handleInstallWizardNext"
              >
                {{ installWizardPrimaryText }}
              </el-button>
            </div>
          </div>
        </div>
      </transition>
    </teleport>

    <el-dialog v-model="addPrinterDialogVisible" title="添加新的打印机" width="420px" destroy-on-close>
      <div class="add-printer-dialog-body">请选择安装方式：</div>
      <template #footer>
        <div class="dialog-actions">
          <el-button @click="addPrinterDialogVisible = false">取消</el-button>
          <el-button @click="handleVendorInstall">供应商安装</el-button>
          <el-button type="primary" :loading="openingSystemWizard" @click="openSystemDriverInstall">驱动安装</el-button>
        </div>
      </template>
    </el-dialog>
  </el-card>
</template>
