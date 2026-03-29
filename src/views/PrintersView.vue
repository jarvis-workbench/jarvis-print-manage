<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import { RefreshOne } from '@icon-park/vue-next'
import { ElMessage, ElMessageBox } from 'element-plus'
import { useRuntimeStore } from '../stores/runtime'

const loading = ref(false)
const savingAction = ref('')
const backingUpNames = ref(new Set())
const printingTestNames = ref(new Set())
const deletingBackupNames = ref(new Set())
const openingPropertiesNames = ref(new Set())
const openingPreferencesNames = ref(new Set())
const renamingNames = ref(new Set())
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
const openingBackupDir = ref(false)
const openingBackupDirPrinterKey = ref('')
const error = ref('')
const message = ref('')
const lanLoading = ref(false)
const requestingLanInstallKeys = ref(new Set())
const firstScreenLoading = ref(true)
const firstSnapshotReady = ref(false)
const firstRuntimeReady = ref(false)
const firstLoadStartedAt = ref(Date.now())
let firstLoadForceDoneTimer = null
let firstLoadMinDelayTimer = null

const FIRST_LOAD_MIN_MS = 450
const FIRST_LOAD_FORCE_DONE_MS = 15_000

const runtimeStore = useRuntimeStore()
const { settings, PrinterServerManage, lanState, lanNodes, lanOffers, lanTasks } = storeToRefs(runtimeStore)
const waitingUsbReconnectNames = ref(new Set())
let removePrinterStateUpdatedListener = null
let removePrinterSnapshotUpdatedListener = null
let removeLanStateUpdatedListener = null
let loadPrintersSeq = 0
let loadingOwnerSeq = 0
const installSuppressedUntil = ref(new Map())
const activePrinterTab = ref('installed')
const lanTaskStatusMap = ref(new Map())
const lanTaskTransitionReady = ref(false)
const pendingLanTaskIds = ref(new Set())

const allRows = computed(() => (Array.isArray(PrinterServerManage.value?.printers) ? PrinterServerManage.value.printers : []))
const installedRows = computed(() => allRows.value.filter((item) => item?.installed))
const localDriverRows = computed(() => allRows.value.filter((item) => item?.backup))
const lanEnabled = computed(() => Boolean(lanState.value?.enabled || settings.value?.lanEnabled))
const lanNodeMap = computed(() => {
  const map = new Map()
  const list = Array.isArray(lanNodes.value) ? lanNodes.value : []
  for (const item of list) {
    const nodeId = String(item?.nodeId || '').trim()
    if (!nodeId) continue
    map.set(nodeId, item)
  }
  return map
})
const lanTaskMap = computed(() => {
  const map = new Map()
  const list = Array.isArray(lanTasks.value) ? lanTasks.value : []
  for (const task of list) {
    const nodeId = String(task?.nodeId || '').trim()
    const offerId = String(task?.offerId || '').trim()
    if (!nodeId || !offerId) continue
    const key = `${nodeId}::${offerId}`
    const previous = map.get(key)
    const nextTime = new Date(task?.updatedAt || 0).getTime()
    const previousTime = new Date(previous?.updatedAt || 0).getTime()
    if (!previous || nextTime >= previousTime) {
      map.set(key, task)
    }
  }
  return map
})
const networkDriverRows = computed(() => {
  const offers = Array.isArray(lanOffers.value) ? lanOffers.value : []
  const installedList = installedRows.value
  return offers
    .map((offer) => {
      const nodeId = String(offer?.nodeId || '').trim()
      const offerId = String(offer?.offerId || '').trim()
      const key = `${nodeId}::${offerId}`
      const task = lanTaskMap.value.get(key) || null
      const node = lanNodeMap.value.get(nodeId) || null
      const installed = isLanOfferInstalledLocally(offer, installedList)
      return {
        ...offer,
        key,
        installed,
        nodeName: String(node?.machineName || nodeId || '-'),
        nodeHost: String(node?.host || offer?.host || ''),
        nodeArch: String(node?.arch || ''),
        task,
      }
    })
    .filter((row) => !row.installed)
    .sort((a, b) => String(a.printerName || '').localeCompare(String(b.printerName || '')))
})
const networkDriverEmptyText = computed(() => {
  if (!lanEnabled.value) return '请先在系统设置中开启局域网组网'
  if (lanLoading.value) return ''
  if (!Array.isArray(lanNodes.value) || lanNodes.value.length === 0) return '未发现局域网节点'
  return '暂无可安装的网络驱动'
})
const totalPrinters = computed(() => {
  const tab = String(activePrinterTab.value || 'installed')
  if (tab === 'installed') return installedRows.value.length
  if (tab === 'local-driver') return localDriverRows.value.length
  if (tab === 'network-driver') return networkDriverRows.value.length
  return 0
})
const installWizardNeedsIpStep = computed(() => isIpPortProfile(installWizardRow.value))
const installWizardBusy = computed(() => installWizardSubmitting.value || installWizardIpChecking.value || installWizardAdvancing.value)
const installFlowActive = computed(() => installWizardVisible.value || installWizardBusy.value || savingAction.value.startsWith('install:'))
const backupFlowActive = computed(() => backingUpNames.value.size > 0)
const installWizardPrimaryText = computed(() => {
  if (installWizardNeedsIpStep.value && installWizardStep.value === 0) return '下一步'
  return '开始安装'
})

function clearFirstLoadTimers() {
  if (firstLoadForceDoneTimer) {
    clearTimeout(firstLoadForceDoneTimer)
    firstLoadForceDoneTimer = null
  }
  if (firstLoadMinDelayTimer) {
    clearTimeout(firstLoadMinDelayTimer)
    firstLoadMinDelayTimer = null
  }
}

function tryFinishFirstScreenLoading(force = false) {
  if (!firstScreenLoading.value) return
  if (!force && (!firstSnapshotReady.value || !firstRuntimeReady.value)) return
  const elapsed = Date.now() - Number(firstLoadStartedAt.value || Date.now())
  const remain = FIRST_LOAD_MIN_MS - elapsed
  if (remain > 0) {
    if (firstLoadMinDelayTimer) clearTimeout(firstLoadMinDelayTimer)
    firstLoadMinDelayTimer = setTimeout(() => {
      firstScreenLoading.value = false
      clearFirstLoadTimers()
    }, remain)
    return
  }
  firstScreenLoading.value = false
  clearFirstLoadTimers()
}

function isRuntimeStateReadyPayload(payload) {
  if (!payload || typeof payload !== 'object') return false
  const seq = Number(payload?.seq || 0)
  if (Number.isFinite(seq) && seq > 0) return true
  const changedAt = String(payload?.changedAt || '').trim()
  if (changedAt) return true
  const spooler = String(payload?.spooler || '').trim().toLowerCase()
  if (spooler && spooler !== 'unknown') return true
  return false
}

function clearInstallWizardIpHint() {
  installWizardIpStatus.value = ''
  installWizardIpMessage.value = ''
}

function normalizePrinterKey(value) {
  return String(value || '').trim().toLowerCase()
}

function normalizeToken(value) {
  return String(value || '').trim().toLowerCase()
}

function normalizeIpOrPort(rawValue) {
  const ip = parseIpCandidate(rawValue)
  if (ip) return normalizeToken(ip)
  return normalizeToken(rawValue)
}

function normalizeUsbVidPid(item = {}) {
  const raw = String(item?.usbVidPid || '').trim()
  if (raw) return raw.toUpperCase()
  const usbVid = String(item?.usbVid || '').trim().toUpperCase()
  const usbPid = String(item?.usbPid || '').trim().toUpperCase()
  if (!usbVid || !usbPid) return ''
  return `${usbVid}:${usbPid}`
}

function isLanOfferInstalledLocally(offer = {}, installedList = []) {
  const offerDriver = normalizeToken(offer?.driverName)
  const offerPrinter = normalizeToken(offer?.printerName)
  const offerHost = normalizeIpOrPort(offer?.portHostAddress || offer?.portName)
  const offerPnp = normalizeToken(offer?.pnpDeviceId)
  const offerUsbVidPid = normalizeToken(normalizeUsbVidPid(offer))

  return installedList.some((installedItem) => {
    if (!installedItem?.installed) return false
    const localDriver = normalizeToken(installedItem?.driverName)
    const localPrinter = normalizeToken(installedItem?.printerName)
    const localHost = normalizeIpOrPort(installedItem?.portHostAddress || installedItem?.portName)
    const localPnp = normalizeToken(installedItem?.pnpDeviceId)
    const localUsbVidPid = normalizeToken(normalizeUsbVidPid(installedItem))

    if (offerPnp && localPnp && offerPnp === localPnp) return true
    if (offerUsbVidPid && localUsbVidPid && offerUsbVidPid === localUsbVidPid) return true
    if (offerDriver && offerPrinter && offerDriver === localDriver && offerPrinter === localPrinter) return true
    if (offerDriver && offerHost && offerDriver === localDriver && offerHost === localHost) return true
    return false
  })
}

function isLanTaskRunning(task = null) {
  const status = String(task?.status || '').toUpperCase()
  return ['QUEUED', 'DISCOVERING', 'OFFER_READY', 'TRANSFERRING', 'INSTALLING'].includes(status)
}

function getLanTaskText(task = null) {
  const status = String(task?.status || '').toUpperCase()
  const progress = Number(task?.progress || 0)
  if (status === 'QUEUED') return '排队中'
  if (status === 'DISCOVERING') return '发现节点中'
  if (status === 'OFFER_READY') return '驱动包就绪'
  if (status === 'TRANSFERRING') return `传输中 ${Math.max(0, Math.min(Math.round(progress), 99))}%`
  if (status === 'INSTALLING') return `安装中 ${Math.max(0, Math.min(Math.round(progress), 99))}%`
  if (status === 'DONE') return '安装完成'
  if (status === 'FAILED') return '安装失败'
  if (status === 'CANCELED') return '已取消'
  return '-'
}

function getLanTaskTagType(task = null) {
  const status = String(task?.status || '').toUpperCase()
  if (status === 'DONE') return 'success'
  if (status === 'FAILED') return 'danger'
  if (status === 'CANCELED') return 'warning'
  if (isLanTaskRunning(task)) return 'warning'
  return 'info'
}

function formatArchiveSize(size) {
  const bytes = Number(size) || 0
  if (bytes <= 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function markRequestingLanInstall(row, loading) {
  const key = String(row?.key || `${row?.nodeId || ''}::${row?.offerId || ''}`).trim()
  if (!key) return
  const next = new Set(requestingLanInstallKeys.value)
  if (loading) next.add(key)
  else next.delete(key)
  requestingLanInstallKeys.value = next
}

function isRequestingLanInstall(row) {
  const key = String(row?.key || `${row?.nodeId || ''}::${row?.offerId || ''}`).trim()
  if (!key) return false
  return requestingLanInstallKeys.value.has(key)
}

function markPendingLanTask(taskId, pending) {
  const key = String(taskId || '').trim()
  if (!key) return
  const next = new Set(pendingLanTaskIds.value)
  if (pending) next.add(key)
  else next.delete(key)
  pendingLanTaskIds.value = next
}

function markBackingUp(printerName, loading) {
  const key = normalizePrinterKey(printerName)
  if (!key) return
  const next = new Set(backingUpNames.value)
  if (loading) next.add(key)
  else next.delete(key)
  backingUpNames.value = next
}

function isBackingUp(row) {
  const key = normalizePrinterKey(row?.printerName)
  return key ? backingUpNames.value.has(key) : false
}

function markPrintingTest(printerName, loading) {
  const key = normalizePrinterKey(printerName)
  if (!key) return
  const next = new Set(printingTestNames.value)
  if (loading) next.add(key)
  else next.delete(key)
  printingTestNames.value = next
}

function isPrintingTest(row) {
  const key = normalizePrinterKey(row?.printerName)
  return key ? printingTestNames.value.has(key) : false
}

function markDeletingBackup(printerName, loading) {
  const key = normalizePrinterKey(printerName)
  if (!key) return
  const next = new Set(deletingBackupNames.value)
  if (loading) next.add(key)
  else next.delete(key)
  deletingBackupNames.value = next
}

function isDeletingBackup(row) {
  const key = normalizePrinterKey(row?.printerName)
  return key ? deletingBackupNames.value.has(key) : false
}

function markOpeningProperties(printerName, loading) {
  const key = normalizePrinterKey(printerName)
  if (!key) return
  const next = new Set(openingPropertiesNames.value)
  if (loading) next.add(key)
  else next.delete(key)
  openingPropertiesNames.value = next
}

function isOpeningProperties(row) {
  const key = normalizePrinterKey(row?.printerName)
  return key ? openingPropertiesNames.value.has(key) : false
}

function markOpeningPreferences(printerName, loading) {
  const key = normalizePrinterKey(printerName)
  if (!key) return
  const next = new Set(openingPreferencesNames.value)
  if (loading) next.add(key)
  else next.delete(key)
  openingPreferencesNames.value = next
}

function isOpeningPreferences(row) {
  const key = normalizePrinterKey(row?.printerName)
  return key ? openingPreferencesNames.value.has(key) : false
}

function markRenaming(printerName, loading) {
  const key = normalizePrinterKey(printerName)
  if (!key) return
  const next = new Set(renamingNames.value)
  if (loading) next.add(key)
  else next.delete(key)
  renamingNames.value = next
}

function isRenaming(row) {
  const key = normalizePrinterKey(row?.printerName)
  return key ? renamingNames.value.has(key) : false
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

function suppressInstallButton(printerName, durationMs = 15_000) {
  const key = normalizePrinterKey(printerName)
  if (!key) return
  const next = new Map(installSuppressedUntil.value)
  next.set(key, Date.now() + Math.max(Number(durationMs) || 0, 0))
  installSuppressedUntil.value = next
}

function clearInstallButtonSuppression(printerName) {
  const key = normalizePrinterKey(printerName)
  if (!key) return
  if (!installSuppressedUntil.value.has(key)) return
  const next = new Map(installSuppressedUntil.value)
  next.delete(key)
  installSuppressedUntil.value = next
}

function isInstallSuppressed(row) {
  const key = normalizePrinterKey(row?.printerName)
  if (!key) return false
  const until = Number(installSuppressedUntil.value.get(key) || 0)
  if (!until || until <= Date.now()) {
    if (installSuppressedUntil.value.has(key)) {
      const next = new Map(installSuppressedUntil.value)
      next.delete(key)
      installSuppressedUntil.value = next
    }
    return false
  }
  return true
}

function refreshInstallSuppressionFromRows(printers) {
  const list = Array.isArray(printers) ? printers : []
  for (const item of list) {
    if (!item?.installed) continue
    suppressInstallButton(item?.printerName, 8000)
  }
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

function showWaitingUsbHint(row) {
  return hasWaitingUsbReconnect(row)
}

function getBackupDisableReason(row) {
  if (isBackingUp(row)) return '当前打印机正在备份'
  if (uninstalling.value) return '正在卸载，请稍后'
  if (installFlowActive.value) return '正在安装，请稍后'
  if (showWaitingUsbHint(row)) return '等待打印机USB重新接入'
  if (!row?.installed) return '打印机未安装'
  if (row?.backup) return '当前驱动已备份'
  return ''
}

function getInstallDisableReason(row) {
  if (savingAction.value === `install:${row?.printerName || ''}`) return '当前打印机正在安装'
  if (uninstalling.value) return '正在卸载，请稍后'
  if (installFlowActive.value) return '正在安装，请稍后'
  if (showWaitingUsbHint(row)) return '等待打印机USB重新接入'
  if (row?.installed) return '打印机已安装'
  if (!row?.backup) return '当前无可用驱动备份'
  if (isInstallSuppressed(row)) return '状态同步中，请稍候'
  return ''
}

function getUninstallDisableReason(row) {
  if (savingAction.value === `uninstall:${row?.printerName || ''}`) return '当前打印机正在卸载'
  if (backupFlowActive.value) return '正在备份，请备份完成后再卸载'
  if (installFlowActive.value) return '正在安装，请稍后'
  if (uninstalling.value) return '正在卸载，请稍后'
  if (showWaitingUsbHint(row)) return '等待打印机USB重新接入'
  if (!row?.installed) return '打印机未安装'
  return ''
}

function getOpenBackupDirDisableReason() {
  if (openingBackupDir.value) return '正在打开备份目录，请稍候'
  const dir = String(settings.value?.backupDir || '').trim()
  if (!dir) return '未配置备份目录'
  return ''
}

function getPrintTestDisableReason(row) {
  if (isPrintingTest(row)) return '正在发送测试页'
  if (installFlowActive.value) return '正在安装，请稍后'
  if (uninstalling.value) return '正在卸载，请稍后'
  if (showWaitingUsbHint(row)) return '等待打印机USB重新接入'
  if (!row?.installed) return '打印机未安装'
  return ''
}

function getOpenInstalledPrinterDialogDisableReason(row) {
  if (isOpeningProperties(row) || isOpeningPreferences(row)) return '正在打开，请稍后'
  if (installFlowActive.value) return '正在安装，请稍后'
  if (uninstalling.value) return '正在卸载，请稍后'
  if (showWaitingUsbHint(row)) return '等待打印机USB重新接入'
  if (!row?.installed) return '打印机未安装'
  return ''
}

function getRenameDisableReason(row) {
  if (isRenaming(row)) return '当前打印机正在重命名'
  if (installFlowActive.value) return '正在安装，请稍后'
  if (backupFlowActive.value) return '正在备份，请稍后'
  if (uninstalling.value) return '正在卸载，请稍后'
  if (showWaitingUsbHint(row)) return '等待打印机USB重新接入'
  if (!row?.installed) return '打印机未安装'
  return ''
}

function getDeleteBackupDisableReason(row) {
  if (isDeletingBackup(row)) return '正在删除备份'
  if (isBackingUp(row)) return '当前打印机正在备份'
  if (backupFlowActive.value) return '正在备份，请稍后'
  if (installFlowActive.value) return '正在安装，请稍后'
  if (uninstalling.value) return '正在卸载，请稍后'
  if (!row?.backup) return '当前无备份可删除'
  return ''
}

function getLanInstallDisableReason(row) {
  if (!lanEnabled.value) return '请先在系统设置中开启局域网组网'
  if (uninstalling.value) return '正在卸载，请稍后'
  if (installFlowActive.value) return '正在安装，请稍后'
  if (backupFlowActive.value) return '正在备份，请稍后'
  if (!row?.nodeId || !row?.offerId) return '驱动标识缺失'
  if (row?.installed) return '本机已安装'
  if (isRequestingLanInstall(row)) return '正在提交安装任务'
  if (isLanTaskRunning(row?.task)) return '安装任务执行中'
  return ''
}

function networkInstallStateText(row) {
  if (row?.installed) return '已安装'
  const task = row?.task || null
  const status = String(task?.status || '').toUpperCase()
  if (!status) return '待安装'
  if (status === 'DONE') return '已完成'
  if (status === 'FAILED') return '失败'
  if (status === 'CANCELED') return '已取消'
  return getLanTaskText(task)
}

function networkInstallStateType(row) {
  if (row?.installed) return 'success'
  return getLanTaskTagType(row?.task || null)
}

function networkInstallErrorText(row) {
  return String(row?.task?.errorMessage || '').trim()
}

function isOpeningBackupDir(row) {
  const key = normalizePrinterKey(row?.printerName)
  return openingBackupDir.value && key && openingBackupDirPrinterKey.value === key
}

function getInlineActionItems(row, tabName = activePrinterTab.value) {
  const tab = String(tabName || 'installed')
  const actions = []

  if (tab === 'installed') {
    const printReason = getPrintTestDisableReason(row)
    const openDialogReason = getOpenInstalledPrinterDialogDisableReason(row)
    const uninstallReason = getUninstallDisableReason(row)
    actions.push({
      command: 'print-test-page',
      label: '打印测试页',
      disabled: Boolean(printReason),
      reason: printReason,
      loading: isPrintingTest(row),
      loadingLabel: '正在发送',
    })
    actions.push({
      command: 'open-printer-properties',
      label: '打印机属性',
      disabled: Boolean(openDialogReason),
      reason: openDialogReason,
      loading: isOpeningProperties(row),
      loadingLabel: '正在打开',
    })
    actions.push({
      command: 'open-printer-preferences',
      label: '打印机首选项',
      disabled: Boolean(openDialogReason),
      reason: openDialogReason,
      loading: isOpeningPreferences(row),
      loadingLabel: '正在打开',
    })
    const renameReason = getRenameDisableReason(row)
    actions.push({
      command: 'rename-printer',
      label: '打印机重命名',
      disabled: Boolean(renameReason),
      reason: renameReason,
      loading: isRenaming(row),
      loadingLabel: '正在重命名',
    })
    actions.push({
      command: 'uninstall',
      label: '卸载',
      disabled: Boolean(uninstallReason),
      reason: uninstallReason,
      loading: savingAction.value === `uninstall:${row?.printerName || ''}`,
      loadingLabel: '正在卸载',
    })
    if (row?.backup) {
      const openReason = getOpenBackupDirDisableReason()
      actions.push({
        command: 'open-backup-dir',
        label: '打开备份目录',
        disabled: Boolean(openReason),
        reason: openReason,
        loading: isOpeningBackupDir(row),
        loadingLabel: '正在打开',
      })
    } else {
      const backupReason = getBackupDisableReason(row)
      actions.push({
        command: 'backup',
        label: '备份',
        disabled: Boolean(backupReason),
        reason: backupReason,
        loading: isBackingUp(row),
        loadingLabel: '正在备份',
      })
    }
    return actions
  }

  if (tab === 'local-driver') {
    const deleteBackupReason = getDeleteBackupDisableReason(row)
    const openReason = row?.backup ? getOpenBackupDirDisableReason() : '当前无备份可打开'
    if (!row?.installed) {
      const installReason = getInstallDisableReason(row)
      actions.push({
        command: 'install',
        label: '安装',
        disabled: Boolean(installReason),
        reason: installReason,
        loading: savingAction.value === `install:${row?.printerName || ''}`,
        loadingLabel: '正在安装',
      })
    }
    actions.push({
      command: 'delete-backup',
      label: '删除备份',
      disabled: Boolean(deleteBackupReason),
      reason: deleteBackupReason,
      loading: isDeletingBackup(row),
      loadingLabel: '正在删除',
    })
    actions.push({
      command: 'open-backup-dir',
      label: '打开备份目录',
      disabled: Boolean(openReason),
      reason: openReason,
      loading: isOpeningBackupDir(row),
      loadingLabel: '正在打开',
    })
    return actions
  }

  if (tab === 'network-driver') {
    const installReason = getLanInstallDisableReason(row)
    actions.push({
      command: 'lan-install',
      label: '安装到本机',
      disabled: Boolean(installReason),
      reason: installReason,
      loading: isRequestingLanInstall(row) || isLanTaskRunning(row?.task),
      loadingLabel: isRequestingLanInstall(row) ? '正在提交' : getLanTaskText(row?.task),
    })
    return actions
  }

  return actions
}

function getActionTriggerState(row, tabName = activePrinterTab.value) {
  const tab = String(tabName || activePrinterTab.value || 'installed')
  if (tab === 'network-driver') {
    if (isRequestingLanInstall(row)) return { busy: true, label: '正在提交' }
    if (isLanTaskRunning(row?.task)) return { busy: true, label: getLanTaskText(row?.task) }
    return { busy: false, label: '操作' }
  }
  const name = String(row?.printerName || '')
  if (isOpeningProperties(row) || isOpeningPreferences(row)) return { busy: true, label: '正在打开' }
  if (isRenaming(row)) return { busy: true, label: '正在重命名' }
  if (isPrintingTest(row)) return { busy: true, label: '正在发送' }
  if (isBackingUp(row)) return { busy: true, label: '正在备份' }
  if (savingAction.value === `install:${name}`) return { busy: true, label: '正在安装' }
  if (savingAction.value === `uninstall:${name}`) return { busy: true, label: '正在卸载' }
  if (isDeletingBackup(row)) return { busy: true, label: '正在删除' }
  if (isOpeningBackupDir(row)) return { busy: true, label: '正在打开' }
  return { busy: false, label: '操作' }
}

async function openBackupDirectory(row) {
  if (!window.eleDrive?.openBackupDir) return
  if (openingBackupDir.value) return
  openingBackupDir.value = true
  openingBackupDirPrinterKey.value = normalizePrinterKey(row?.printerName)
  try {
    await window.eleDrive.openBackupDir()
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    error.value = detail
    ElMessage.error(`打开备份目录失败：${detail}`)
  } finally {
    openingBackupDir.value = false
    openingBackupDirPrinterKey.value = ''
  }
}

async function printTestPage(row) {
  if (!window.eleDrive?.printTestPage) return
  markPrintingTest(row?.printerName, true)
  try {
    await window.eleDrive.printTestPage({ printerName: row.printerName })
    ElMessage.success('测试页任务已发送')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    error.value = detail
    ElMessage.error(`发送测试页失败：${detail}`)
  } finally {
    markPrintingTest(row?.printerName, false)
  }
}

async function openInstalledPrinterProperties(row) {
  if (!window.eleDrive?.openPrinterProperties) return
  markOpeningProperties(row?.printerName, true)
  try {
    await window.eleDrive.openPrinterProperties({ printerName: row.printerName })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    error.value = detail
    ElMessage.error(`打开打印机属性失败：${detail}`)
  } finally {
    markOpeningProperties(row?.printerName, false)
  }
}

async function openInstalledPrinterPreferences(row) {
  if (!window.eleDrive?.openPrinterPreferences) return
  markOpeningPreferences(row?.printerName, true)
  try {
    await window.eleDrive.openPrinterPreferences({ printerName: row.printerName })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    error.value = detail
    ElMessage.error(`打开打印机首选项失败：${detail}`)
  } finally {
    markOpeningPreferences(row?.printerName, false)
  }
}

async function renameInstalledPrinter(row) {
  if (!window.eleDrive?.renamePrinter) return
  const disabledReason = getRenameDisableReason(row)
  if (disabledReason) {
    ElMessage.warning(disabledReason)
    return
  }

  let nextPrinterName = ''
  try {
    const result = await ElMessageBox.prompt('请输入新的打印机名称', '打印机重命名', {
      inputValue: String(row?.printerName || ''),
      confirmButtonText: '确认',
      cancelButtonText: '取消',
      inputPlaceholder: '新的打印机名称',
    })
    nextPrinterName = String(result?.value || '').trim()
  } catch {
    return
  }

  if (!nextPrinterName) {
    ElMessage.warning('请输入打印机名称')
    return
  }
  if (normalizePrinterKey(nextPrinterName) === normalizePrinterKey(row?.printerName)) {
    ElMessage.info('名称未发生变化')
    return
  }
  if (isDuplicatePrinterName(nextPrinterName)) {
    ElMessage.warning('打印机显示名称已存在，请更换名称')
    return
  }

  markRenaming(row?.printerName, true)
  error.value = ''
  try {
    await window.eleDrive.renamePrinter({
      printerName: row.printerName,
      newPrinterName: nextPrinterName,
    })
    ElMessage.success('打印机重命名成功')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    error.value = detail
    ElMessage.error(`打印机重命名失败：${detail}`)
  } finally {
    markRenaming(row?.printerName, false)
  }
}

async function deleteBackup(row) {
  if (!window.eleDrive?.deleteBackupDriver) return
  const targetName = String(row?.backupPrinterName || row?.printerName || '').trim()
  if (!targetName) return

  try {
    await ElMessageBox.confirm(`确认删除“${targetName}”的备份？`, '删除备份', {
      confirmButtonText: '确认删除',
      cancelButtonText: '取消',
      type: 'warning',
    })
  } catch {
    return
  }

  markDeletingBackup(targetName, true)
  try {
    await window.eleDrive.deleteBackupDriver({ printerName: targetName })
    ElMessage.success('备份已删除')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    error.value = detail
    ElMessage.error(`删除备份失败：${detail}`)
  } finally {
    markDeletingBackup(targetName, false)
  }
}

function applyLanState(payload) {
  runtimeStore.setLanState(payload || {})
}

async function refreshLanState(options = {}) {
  if (!window.eleDrive?.getLanState) return
  const silent = Boolean(options?.silent)
  if (!silent) {
    lanLoading.value = true
  }
  try {
    let state = await window.eleDrive.getLanState()
    if (window.eleDrive?.listLanOffers) {
      const offers = await window.eleDrive.listLanOffers()
      state = {
        ...(state || {}),
        offers: Array.isArray(offers) ? offers : [],
      }
    }
    applyLanState(state || {})
  } catch (err) {
    if (!silent) {
      const detail = err instanceof Error ? err.message : String(err)
      error.value = detail
    }
  } finally {
    if (!silent) {
      lanLoading.value = false
    }
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

function unsubscribeLanState() {
  if (typeof removeLanStateUpdatedListener === 'function') {
    removeLanStateUpdatedListener()
  }
  removeLanStateUpdatedListener = null
}

async function requestLanInstall(row) {
  if (!window.eleDrive?.requestLanInstall) return
  const disabledReason = getLanInstallDisableReason(row)
  if (disabledReason) return

  markRequestingLanInstall(row, true)
  error.value = ''
  try {
    const response = await window.eleDrive.requestLanInstall({
      nodeId: row.nodeId,
      offerId: row.offerId,
    })
    if (!response?.taskId) {
      throw new Error('安装任务创建失败：未返回任务ID')
    }
    markPendingLanTask(response.taskId, true)
    ElMessage.success('已创建网络安装任务')
    await refreshLanState({ silent: true })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    error.value = detail
    ElMessage.error(`创建安装任务失败：${detail}`)
  } finally {
    markRequestingLanInstall(row, false)
  }
}

function resolveLanTaskPrinterName(task) {
  const nodeId = String(task?.nodeId || '').trim()
  const offerId = String(task?.offerId || '').trim()
  if (!nodeId || !offerId) return ''
  const offer = (Array.isArray(lanOffers.value) ? lanOffers.value : []).find(
    (item) => String(item?.nodeId || '').trim() === nodeId && String(item?.offerId || '').trim() === offerId,
  )
  return String(offer?.printerName || '').trim()
}

function syncLanTaskTransitions(tasks) {
  const list = Array.isArray(tasks) ? tasks : []
  const nextMap = new Map()
  for (const item of list) {
    const taskId = String(item?.taskId || '').trim()
    if (!taskId) continue
    const status = String(item?.status || '').trim().toUpperCase()
    const previousStatus = String(lanTaskStatusMap.value.get(taskId) || '').toUpperCase()
    const taskType = String(item?.type || '').trim().toLowerCase()
    const isPendingTask = pendingLanTaskIds.value.has(taskId)

    if (
      lanTaskTransitionReady.value
      && isPendingTask
      && taskType === 'install'
      && status === 'DONE'
      && previousStatus !== 'DONE'
    ) {
      const printerName = resolveLanTaskPrinterName(item)
      if (printerName) {
        ElMessage.success(`网络驱动安装成功：${printerName}`)
      } else {
        ElMessage.success('网络驱动安装成功')
      }
    }
    if (isPendingTask && ['DONE', 'FAILED', 'CANCELED'].includes(status)) {
      markPendingLanTask(taskId, false)
    }

    nextMap.set(taskId, status)
  }
  lanTaskStatusMap.value = nextMap
  if (!lanTaskTransitionReady.value) {
    lanTaskTransitionReady.value = true
  }
}

function handleInlineAction(command, row, tabName = activePrinterTab.value) {
  if (!row) return
  const cmd = String(command || '')
  const actions = getInlineActionItems(row, tabName)
  const selected = actions.find((item) => item.command === cmd)
  if (!selected || selected.disabled) return

  if (cmd === 'print-test-page') {
    void printTestPage(row)
    return
  }
  if (cmd === 'open-printer-properties') {
    void openInstalledPrinterProperties(row)
    return
  }
  if (cmd === 'open-printer-preferences') {
    void openInstalledPrinterPreferences(row)
    return
  }
  if (cmd === 'rename-printer') {
    void renameInstalledPrinter(row)
    return
  }
  if (cmd === 'backup') {
    void backupDriver(row)
    return
  }
  if (cmd === 'install') {
    openInstallWizard(row)
    return
  }
  if (cmd === 'uninstall') {
    void uninstallDriver(row)
    return
  }
  if (cmd === 'open-backup-dir') {
    void openBackupDirectory(row)
    return
  }
  if (cmd === 'delete-backup') {
    void deleteBackup(row)
    return
  }
  if (cmd === 'lan-install') {
    void requestLanInstall(row)
  }
}

function driverStatusType(row) {
  return row?.backup ? 'success' : 'warning'
}

function driverStatusText(row) {
  return row?.backup ? '已备份' : '未备份'
}

function installStateType(row) {
  return row?.installed ? 'success' : 'info'
}

function installStateText(row) {
  return row?.installed ? '已安装' : '未安装'
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
  if (!row?.installed) {
    if (showWaitingUsbHint(row)) return '等待打印机USB重新接入'
    return '未安装'
  }
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
  if (status === '等待打印机USB重新接入') return 'warning'
  return 'info'
}

function applyPrinterSnapshot(payload) {
  if (!payload) return
  runtimeStore.setPrinterSnapshot({
    installedPrinters: Array.isArray(payload?.installedPrinters) ? payload.installedPrinters : [],
    driverIndexEntries: Array.isArray(payload?.driverIndexEntries) ? payload.driverIndexEntries : [],
    backupDir: String(payload?.backupDir || ''),
    printerManage: Array.isArray(payload?.printerManage) ? payload.printerManage : [],
    spooler: String(payload?.spooler || ''),
    ports: Array.isArray(payload?.ports) ? payload.ports : [],
    changes: payload?.changes || {},
    fromWorker: true,
  })
  refreshInstallSuppressionFromRows(runtimeStore.PrinterServerManage?.printers)
  reconcileWaitingUsbReconnectState(runtimeStore.PrinterServerManage?.printers)
  if (!firstSnapshotReady.value) {
    firstSnapshotReady.value = true
    tryFinishFirstScreenLoading()
  }
}

async function fetchLegacySnapshotPayload() {
  if (!window.eleDrive?.listInstalledPrinters || !window.eleDrive?.getDriverIndex) return null
  const [installedPrinters, driverIndex] = await Promise.all([
    window.eleDrive.listInstalledPrinters(),
    window.eleDrive.getDriverIndex(),
  ])
  return {
    updatedAt: String(driverIndex?.index?.updatedAt || ''),
    backupDir: String(driverIndex?.backupDir || settings.value?.backupDir || ''),
    installedPrinters: Array.isArray(installedPrinters) ? installedPrinters : [],
    driverIndexEntries: Array.isArray(driverIndex?.index?.entries) ? driverIndex.index.entries : [],
  }
}

async function loadPrinters(options = {}) {
  const silent = Boolean(options?.silent)
  if (!window.eleDrive?.getPrinterSnapshot && !window.eleDrive?.listInstalledPrinters) return
  const seq = ++loadPrintersSeq
  if (!silent) {
    loading.value = true
    error.value = ''
    loadingOwnerSeq = seq
  }

  try {
    let payload = null
    if (window.eleDrive?.getPrinterSnapshot) {
      try {
        payload = await window.eleDrive.getPrinterSnapshot()
      } catch (snapshotError) {
        const msg = String(snapshotError instanceof Error ? snapshotError.message : snapshotError || '')
        if (!msg.includes("No handler registered for 'printers:snapshot:get'")) {
          throw snapshotError
        }
      }
    }
    if (!payload) {
      payload = await fetchLegacySnapshotPayload()
    }
    if (!payload) {
      throw new Error('无法获取打印机快照数据')
    }
    if (seq !== loadPrintersSeq) return
    applyPrinterSnapshot(payload)
  } catch (err) {
    if (seq !== loadPrintersSeq) return
    if (!silent) {
      error.value = err instanceof Error ? err.message : String(err)
    }
  } finally {
    if (!firstSnapshotReady.value && !silent) {
      firstSnapshotReady.value = true
      tryFinishFirstScreenLoading()
    }
    if (seq !== loadPrintersSeq) return
    if (!silent && loadingOwnerSeq === seq) {
      loading.value = false
      loadingOwnerSeq = 0
    }
  }
}

async function handlePrinterStateUpdated(payload) {
  if (!payload) return
  if (!firstRuntimeReady.value && isRuntimeStateReadyPayload(payload)) {
    firstRuntimeReady.value = true
    tryFinishFirstScreenLoading()
  }
  if (savingAction.value) return
  runtimeStore.setPrinterRuntimeState({
    ...(payload || {}),
    fromWorker: true,
  })
  refreshInstallSuppressionFromRows(runtimeStore.PrinterServerManage?.printers)
}

function handlePrinterSnapshotUpdated(payload) {
  applyPrinterSnapshot(payload)
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

function subscribePrinterSnapshot() {
  if (!window.eleDrive?.onPrinterSnapshotUpdated) return
  if (typeof removePrinterSnapshotUpdatedListener === 'function') {
    removePrinterSnapshotUpdatedListener()
  }
  removePrinterSnapshotUpdatedListener = window.eleDrive.onPrinterSnapshotUpdated((payload) => {
    handlePrinterSnapshotUpdated(payload)
  })
}

function unsubscribePrinterRuntimeState() {
  if (typeof removePrinterStateUpdatedListener === 'function') {
    removePrinterStateUpdatedListener()
  }
  removePrinterStateUpdatedListener = null
}

function unsubscribePrinterSnapshot() {
  if (typeof removePrinterSnapshotUpdatedListener === 'function') {
    removePrinterSnapshotUpdatedListener()
  }
  removePrinterSnapshotUpdatedListener = null
}

async function backupDriver(row) {
  if (!window.eleDrive?.backupPrinterDriver) return
  markBackingUp(row?.printerName, true)
  error.value = ''
  try {
    await window.eleDrive.backupPrinterDriver({ printerName: row.printerName })
    ElMessage.success('备份成功')
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    ElMessage.error('备份失败')
  } finally {
    markBackingUp(row?.printerName, false)
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
  return allRows.value.some((item) => item?.installed && normalizePrinterKey(item?.printerName) === key)
}

async function runInstallTask(row, installPayload) {
  if (!window.eleDrive?.installPrinter) return false
  savingAction.value = `install:${row.printerName}`
  error.value = ''
  let success = false
  try {
    const result = await window.eleDrive.installPrinter(installPayload)
    if (result?.status === 'driver-installed') {
      const targetDriverName = String(result.driverName || row.driverName || '').toLowerCase()
      const occupied = !!targetDriverName && allRows.value.some(
        (printer) => printer?.installed && String(printer.driverName || '').toLowerCase() === targetDriverName,
      )
      if (occupied) {
        markWaitingUsbReconnect(row.printerName, false)
        suppressInstallButton(row.printerName)
        suppressInstallButton(installPayload?.targetPrinterName || '')
        ElMessage.success('驱动已安装')
      } else {
        markWaitingUsbReconnect(row.printerName, true)
        suppressInstallButton(row.printerName)
        ElMessage.success('驱动已安装，请重新 拔/插 打印机USB')
      }
    } else {
      markWaitingUsbReconnect(row.printerName, false)
      suppressInstallButton(row.printerName)
      suppressInstallButton(installPayload?.targetPrinterName || '')
      ElMessage.success('安装成功')
    }
    success = true
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    error.value = detail
    ElMessage.error(`安装失败：${detail}`)
  } finally {
    savingAction.value = ''
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
    printerName: row.backupPrinterName || row.printerName,
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
    clearInstallWizardIpHint()
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
      clearInstallWizardIpHint()
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
  installWizardAdvancing.value = true
  try {
    clearInstallWizardIpHint()
    const host = installWizardIp.value.trim()
    if (!isValidIpv4(host)) {
      ElMessage.warning('请输入有效的IP地址')
      return
    }
    await submitInstallWizard()
  } finally {
    installWizardAdvancing.value = false
  }
}

function handleInstallWizardPrev() {
  if (installWizardStep.value > 0) {
    installWizardStep.value -= 1
  }
}

async function uninstallDriver(row) {
  if (!window.eleDrive?.uninstallPrinter) return
  if (backupFlowActive.value) {
    ElMessage.warning('正在备份，请备份完成后再卸载')
    return
  }
  if (installFlowActive.value) {
    ElMessage.warning('正在安装，请安装完成后再卸载')
    return
  }
  if (uninstalling.value) return

  uninstalling.value = true
  savingAction.value = `uninstall:${row.printerName}`
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
      clearInstallButtonSuppression(row?.printerName)
      markWaitingUsbReconnect(row?.printerName, false)
      ElMessage.success('卸载成功（部分驱动文件被系统占用，稍后会自动释放）')
    } else if (repoResidues > 0 || spoolResidues > 0) {
      ElMessage.warning(`打印机/驱动已卸载，但仍检测到残留文件（FileRepository:${repoResidues}，Spool:${spoolResidues}）`)
    } else {
      clearInstallButtonSuppression(row?.printerName)
      markWaitingUsbReconnect(row?.printerName, false)
      ElMessage.success('卸载成功')
    }
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
    ElMessage.error('卸载失败')
  } finally {
    if (savingAction.value.startsWith('uninstall:')) {
      savingAction.value = ''
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

onMounted(() => {
  firstLoadStartedAt.value = Date.now()
  firstScreenLoading.value = true
  firstSnapshotReady.value = false
  firstRuntimeReady.value = false
  clearFirstLoadTimers()
  firstLoadForceDoneTimer = setTimeout(() => {
    tryFinishFirstScreenLoading(true)
  }, FIRST_LOAD_FORCE_DONE_MS)

  subscribePrinterRuntimeState()
  subscribePrinterSnapshot()
  subscribeLanState()

  if (window.eleDrive?.getPrinterRuntimeState) {
    void window.eleDrive.getPrinterRuntimeState()
      .then((state) => handlePrinterStateUpdated(state))
      .catch(() => {
        // ignore bootstrap state errors
      })
  } else {
    firstRuntimeReady.value = true
    tryFinishFirstScreenLoading()
  }

  void loadPrinters({ silent: false })
  void refreshLanState({ silent: true })
})

onUnmounted(() => {
  clearFirstLoadTimers()
  unsubscribeLanState()
  unsubscribePrinterSnapshot()
  unsubscribePrinterRuntimeState()
  lanTaskStatusMap.value = new Map()
  pendingLanTaskIds.value = new Set()
  lanTaskTransitionReady.value = false
})

watch(lanTasks, (tasks) => {
  syncLanTaskTransitions(tasks)
}, { deep: true, immediate: true })

watch(activePrinterTab, (tab) => {
  if (String(tab || '') !== 'network-driver') return
  void refreshLanState({ silent: false })
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

    <div
      class="printer-first-load-wrap"
      v-loading="firstScreenLoading"
      element-loading-text="正在加载打印机列表..."
      element-loading-background="rgba(255, 255, 255, 0.76)"
    >
      <el-tabs v-model="activePrinterTab" class="printer-tabs" type="card">
      <el-tab-pane label="已安装" name="installed">
        <el-table
          :data="installedRows"
          v-loading="loading && !firstScreenLoading"
          row-key="printerName"
          class="printer-table"
          :empty-text="firstScreenLoading ? '' : '未读取到已安装打印机'"
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

          <el-table-column label="状态" width="92" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="printerAvailabilityType(row)" effect="plain">
                {{ printerAvailabilityText(row) }}
              </el-tag>
            </template>
          </el-table-column>

          <el-table-column label="打印机" show-overflow-tooltip>
            <template #default="{ row }">
              <div class="printer-cell">
                <div class="printer-cell-main">
                  <div class="cell-title" :title="row.printerName">{{ row.printerName }}</div>
                  <div class="cell-sub" :title="`${displayPortLabel(row)}：${displayPortName(row)}`">
                    {{ displayPortLabel(row) }}：{{ displayPortName(row) }}
                  </div>
                </div>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="驱动" width="170" show-overflow-tooltip>
            <template #default="{ row }">
              <div class="cell-title" :title="row.driverName || '-'">{{ row.driverName || '-' }}</div>
              <div class="cell-sub" :title="row.driverVersion || '-'">版本：{{ row.driverVersion || '-' }}</div>
            </template>
          </el-table-column>

          <el-table-column label="驱动备份" width="92" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="driverStatusType(row)" effect="plain">{{ driverStatusText(row) }}</el-tag>
            </template>
          </el-table-column>

          <el-table-column label="操作" width="110" align="center" class-name="operation-col" label-class-name="operation-col">
            <template #default="{ row }">
              <div class="action-row">
                <el-dropdown
                  popper-class="printer-action-menu"
                  trigger="click"
                  :disabled="getActionTriggerState(row, 'installed').busy"
                  @command="(command) => handleInlineAction(command, row, 'installed')"
                >
                  <a
                    href="#"
                    class="action-link"
                    :class="{ 'is-busy': getActionTriggerState(row, 'installed').busy }"
                    @click.prevent
                  >
                    <span v-if="getActionTriggerState(row, 'installed').busy" class="action-link-spinner" />
                    {{ getActionTriggerState(row, 'installed').label }}
                    <span class="action-link-caret" aria-hidden="true" />
                  </a>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item
                        v-for="item in getInlineActionItems(row, 'installed')"
                        :key="`${row.printerName}-${item.command}`"
                        :command="item.command"
                        :disabled="item.disabled"
                      >
                        <el-tooltip
                          placement="left"
                          :content="item.reason"
                          :disabled="!(item.disabled && item.reason)"
                        >
                          <span class="action-menu-item-label" :class="{ 'is-disabled': item.disabled }">
                            <span v-if="item.loading" class="action-link-spinner" />
                            {{ item.loading ? item.loadingLabel : item.label }}
                          </span>
                        </el-tooltip>
                      </el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="本地驱动" name="local-driver">
        <el-table
          :data="localDriverRows"
          v-loading="loading && !firstScreenLoading"
          row-key="printerName"
          class="printer-table"
          :empty-text="firstScreenLoading ? '' : '暂无本地驱动'"
          table-layout="fixed"
          :fit="true"
        >
          <el-table-column type="expand" width="46">
            <template #default="{ row }">
              <el-descriptions :column="1" border size="small" class="expand-desc">
                <el-descriptions-item label="厂商">{{ row.manufacturer || '-' }}</el-descriptions-item>
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
                </div>
              </div>
            </template>
          </el-table-column>

          <el-table-column label="驱动" min-width="200" show-overflow-tooltip>
            <template #default="{ row }">
              <div class="cell-title" :title="row.driverName || '-'">{{ row.driverName || '-' }}</div>
              <div class="cell-sub" :title="row.driverVersion || '-'">版本：{{ row.driverVersion || '-' }}</div>
            </template>
          </el-table-column>

          <el-table-column label="安装状态" width="92" align="center">
            <template #default="{ row }">
              <el-tag size="small" :type="installStateType(row)" effect="plain">{{ installStateText(row) }}</el-tag>
            </template>
          </el-table-column>

          <el-table-column label="操作" width="110" align="center" class-name="operation-col" label-class-name="operation-col">
            <template #default="{ row }">
              <div class="action-row">
                <el-dropdown
                  popper-class="printer-action-menu"
                  trigger="click"
                  :disabled="getActionTriggerState(row, 'local-driver').busy"
                  @command="(command) => handleInlineAction(command, row, 'local-driver')"
                >
                  <a
                    href="#"
                    class="action-link"
                    :class="{ 'is-busy': getActionTriggerState(row, 'local-driver').busy }"
                    @click.prevent
                  >
                    <span v-if="getActionTriggerState(row, 'local-driver').busy" class="action-link-spinner" />
                    {{ getActionTriggerState(row, 'local-driver').label }}
                    <span class="action-link-caret" aria-hidden="true" />
                  </a>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item
                        v-for="item in getInlineActionItems(row, 'local-driver')"
                        :key="`${row.printerName}-${item.command}`"
                        :command="item.command"
                        :disabled="item.disabled"
                      >
                        <el-tooltip
                          placement="left"
                          :content="item.reason"
                          :disabled="!(item.disabled && item.reason)"
                        >
                          <span class="action-menu-item-label" :class="{ 'is-disabled': item.disabled }">
                            <span v-if="item.loading" class="action-link-spinner" />
                            {{ item.loading ? item.loadingLabel : item.label }}
                          </span>
                        </el-tooltip>
                      </el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>

      <el-tab-pane label="网络驱动" name="network-driver">
        <el-table
          :data="networkDriverRows"
          v-loading="lanLoading"
          row-key="key"
          class="printer-table"
          :empty-text="networkDriverEmptyText"
          table-layout="fixed"
          :fit="true"
        >
          <el-table-column label="状态" width="128" align="center">
            <template #default="{ row }">
              <el-tooltip
                placement="top"
                :content="networkInstallErrorText(row)"
                :disabled="!networkInstallErrorText(row)"
              >
                <el-tag size="small" :type="networkInstallStateType(row)" effect="plain">
                  {{ networkInstallStateText(row) }}
                </el-tag>
              </el-tooltip>
            </template>
          </el-table-column>

          <el-table-column label="来源节点" width="210" show-overflow-tooltip>
            <template #default="{ row }">
              <div class="cell-title" :title="row.nodeName">{{ row.nodeName || '-' }}</div>
              <div class="cell-sub" :title="row.nodeHost || '-'">
                {{ row.nodeHost || '-' }}
              </div>
            </template>
          </el-table-column>

          <el-table-column label="打印机" min-width="210" show-overflow-tooltip>
            <template #default="{ row }">
              <div class="cell-title" :title="row.printerName || '-'">{{ row.printerName || '-' }}</div>
              <div class="cell-sub" :title="`${row.portHostAddress || row.portName || '-'}`">
                端口：{{ row.portHostAddress || row.portName || '-' }}
              </div>
            </template>
          </el-table-column>

          <el-table-column label="驱动" min-width="210" show-overflow-tooltip>
            <template #default="{ row }">
              <div class="cell-title" :title="row.driverName || '-'">{{ row.driverName || '-' }}</div>
              <div class="cell-sub" :title="row.driverVersion || '-'">
                版本：{{ row.driverVersion || '-' }}
              </div>
            </template>
          </el-table-column>

          <el-table-column label="驱动包" width="138" align="center">
            <template #default="{ row }">
              <el-tag size="small" type="info" effect="plain">{{ formatArchiveSize(row.archiveSize) }}</el-tag>
            </template>
          </el-table-column>

          <el-table-column label="操作" width="120" align="center" class-name="operation-col" label-class-name="operation-col">
            <template #default="{ row }">
              <div class="action-row">
                <el-dropdown
                  popper-class="printer-action-menu"
                  trigger="click"
                  :disabled="getActionTriggerState(row, 'network-driver').busy"
                  @command="(command) => handleInlineAction(command, row, 'network-driver')"
                >
                  <a
                    href="#"
                    class="action-link"
                    :class="{ 'is-busy': getActionTriggerState(row, 'network-driver').busy }"
                    @click.prevent
                  >
                    <span v-if="getActionTriggerState(row, 'network-driver').busy" class="action-link-spinner" />
                    {{ getActionTriggerState(row, 'network-driver').label }}
                    <span class="action-link-caret" aria-hidden="true" />
                  </a>
                  <template #dropdown>
                    <el-dropdown-menu>
                      <el-dropdown-item
                        v-for="item in getInlineActionItems(row, 'network-driver')"
                        :key="`${row.key}-${item.command}`"
                        :command="item.command"
                        :disabled="item.disabled"
                      >
                        <el-tooltip
                          placement="left"
                          :content="item.reason"
                          :disabled="!(item.disabled && item.reason)"
                        >
                          <span class="action-menu-item-label" :class="{ 'is-disabled': item.disabled }">
                            <span v-if="item.loading" class="action-link-spinner" />
                            {{ item.loading ? item.loadingLabel : item.label }}
                          </span>
                        </el-tooltip>
                      </el-dropdown-item>
                    </el-dropdown-menu>
                  </template>
                </el-dropdown>
              </div>
            </template>
          </el-table-column>
        </el-table>
      </el-tab-pane>
      </el-tabs>
    </div>

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
                    :class="{ 'is-disabled': installWizardBusy }"
                    :aria-disabled="installWizardBusy ? 'true' : 'false'"
                    :tabindex="installWizardBusy ? -1 : 0"
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
