import { app, BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { AppShell } from './app-shell.mjs'
import {
  DEFAULT_VIRTUAL_PRINTER_CONFIG,
  ensureStartupBackupDirSetting,
  ensureWritableBackupDir,
  normalizeVirtualPrinterConfig,
  readSettings,
  readVirtualPrinterConfig,
  toBool,
  writeSettings,
  writeVirtualPrinterConfig,
} from './config-store.mjs'
import {
  ARCHIVE_EXTRACT_POLICY_DEFAULT,
  computeFileSha256,
  createArchiveError,
  createBackupArchive,
  ensureBackupIndex,
  extractBackupArchive,
  findInfRelativePath,
  isFileExists,
  normalizeArchiveFields,
  normalizeDriverVersionDisplay,
  normalizeIndexDriverVersions,
  normalizeInstalledDriverVersion,
  normalizeStringArray,
  readDriverVerFromInfFile,
  resolveEntryArchivePath,
  resolvePathInsideRoot,
  safeCleanupExtractDir,
  safeRemoveDirectory,
  toPsSingleQuote,
  upsertIndexEntry,
  writeIndexFile,
} from './driver-archive-store.mjs'
import { AppIpcRouter } from './ipc-router.mjs'
import { LanTransferManager } from './lan-transfer-manager.mjs'
import { loadPsScript } from './config/script/ps/index.mjs'
import { createLanRuntime } from './lan/runtime.mjs'
import { createPrintSocketService } from './print-socket-service.mjs'
import { runPowerShellJson } from './powershell.mjs'
import { UpdateManager } from './update-manager.mjs'
import { runRenderTask } from './worker/print-render-task.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)
const APP_TITLE = '打印机助手'
const THEME_MODES = new Set(['light', 'dark', 'system'])
const TRAY_ICON_NAME = 'tray.png'
const PRINTER_STATE_POLL_INTERVAL_MS = 2000
const POWERSHELL_TIMEOUT_MS = 30_000
const LAN_SERVICE_ARCHIVE_PATH_PREFIX = '/lan/v1/archive/'
const LAN_DOWNLOAD_TIMEOUT_MS = 120_000
const CUSTOM_PROTOCOL_SCHEME = 'hstools'
const KNOWN_ROUTE_PATHS = new Set(['/', '/printers', '/settings', '/driver-install'])
let appIsQuitting = false
if (isDev) {
  const devUserDataPath = path.join(app.getPath('appData'), `${app.getName()}-dev`)
  app.setPath('userData', devUserDataPath)
}
const gotSingleInstanceLock = app.requestSingleInstanceLock()
let printerStateWorker = null
let printerRuntimeState = {
  seq: 0,
  changedAt: '',
  spooler: 'unknown',
  printers: [],
  ports: [],
  changes: {
    addedPrinters: [],
    removedPrinters: [],
    changedPrinters: [],
    addedPorts: [],
    removedPorts: [],
  },
}
let printerSnapshotState = {
  updatedAt: '',
  backupDir: '',
  installedPrinters: [],
  driverIndexEntries: [],
  printerManage: [],
  spooler: 'unknown',
  ports: [],
  changes: {
    addedPrinters: [],
    removedPrinters: [],
    changedPrinters: [],
    addedPorts: [],
    removedPorts: [],
  },
}
let printerSnapshotRefreshTimer = null
let printerSnapshotRefreshRunning = false
let printerSnapshotRefreshPending = false
let lanTransferManager = null
let lanRuntime = null
let printSocketService = null
let updateManager = null
let printerStateWorkerStarting = false
let virtualPrinterConfigCache = normalizeVirtualPrinterConfig(DEFAULT_VIRTUAL_PRINTER_CONFIG)
let appShell = null

function isBrokenPipeError(error) {
  if (!error) return false
  if (String(error?.code || '').toUpperCase() === 'EPIPE') return true
  const message = String(error?.message || '').toLowerCase()
  return message.includes('broken pipe')
}

function safeConsole(method, ...args) {
  try {
    const fn = console?.[method]
    if (typeof fn === 'function') {
      fn(...args)
    }
  } catch (error) {
    if (!isBrokenPipeError(error)) {
      // Ignore logging failures in packaged apps where stdio may be detached.
    }
  }
}

function logWarn(...args) {
  safeConsole('warn', ...args)
}

function logError(...args) {
  safeConsole('error', ...args)
}

appShell = new AppShell({
  appTitle: APP_TITLE,
  customProtocolScheme: CUSTOM_PROTOCOL_SCHEME,
  dirname: __dirname,
  isDev,
  isQuitting: () => appIsQuitting,
  knownRoutePaths: KNOWN_ROUTE_PATHS,
  logError,
  logWarn,
  setQuitting: (value) => {
    appIsQuitting = Boolean(value)
  },
  trayIconName: TRAY_ICON_NAME,
})

function broadcastPrinterState() {
  const payload = {
    ...printerRuntimeState,
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue
    win.webContents.send('printers:state-updated', payload)
  }
}

function broadcastPrinterSnapshot() {
  const payload = {
    ...printerSnapshotState,
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue
    win.webContents.send('printers:snapshot-updated', payload)
  }
}

function broadcastLanState(payload = null) {
  const sourceState = payload || (lanRuntime ? lanRuntime.getState() : null)
  if (!sourceState) return
  const state = filterVirtualOffersFromLanState(sourceState, virtualPrinterConfigCache)
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue
    win.webContents.send('lan:state-updated', state)
  }
}

function broadcastPrintServiceState(payload = null) {
  const state = payload || (printSocketService ? printSocketService.getState() : null)
  if (!state) return
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue
    win.webContents.send('print:service:state-updated', state)
  }
}

function broadcastPrintJob(payload = null) {
  if (!payload) return
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue
    win.webContents.send('print:job-updated', payload)
  }
}

function requestPrinterStateRefresh() {
  if (!printerStateWorker) return
  try {
    printerStateWorker.postMessage({ type: 'refresh' })
  } catch {}
}

function updatePrinterStateWorkerConfig(payload = {}) {
  if (!printerStateWorker) return
  const virtualPrinterConfig = normalizeVirtualPrinterConfig(
    payload?.virtualPrinterConfig || virtualPrinterConfigCache,
  )
  try {
    printerStateWorker.postMessage({
      type: 'config',
      payload: {
        backupDir: String(payload?.backupDir || '').trim(),
        virtualPrinterConfig,
      },
    })
  } catch {}
}

function ensureUpdateManager() {
  if (updateManager) return updateManager
  const win = appShell?.mainWindow
  if (!win || win.isDestroyed()) {
    throw new Error('主窗口尚未就绪')
  }
  updateManager = new UpdateManager(win)
  return updateManager
}

function registerIpcHandlers() {
  const router = new AppIpcRouter({
    appShell,
    applyLanSettings,
    applyPrintServiceSettings,
    backupPrinterDriver,
    broadcastLanState,
    deleteBackupDriver,
    ensureBackupIndex,
    ensureLanRuntime,
    ensurePrintSocketService,
    ensureUpdateManager,
    ensureWritableBackupDir,
    filterVirtualOffersFromLanState,
    filterVirtualPrinterRows,
    getInstalledPrinters,
    getPrinterRuntimeState: () => ({ ...printerRuntimeState }),
    getPrinterSnapshotState: () => ({ ...printerSnapshotState }),
    getVirtualPrinterConfigCache: () => ({ ...virtualPrinterConfigCache }),
    installPrinterFromBackup,
    listUsbPrinterPorts,
    openPrinterPreferencesDialog,
    openPrinterPropertiesDialog,
    openSystemAddPrinterWizard,
    pingHost,
    printPrinterTestPage,
    readSettings,
    refreshPrinterSnapshot,
    renameInstalledPrinter,
    requestPrinterStateRefresh,
    setVirtualPrinterConfigCache: updateVirtualPrinterConfigCache,
    themeModes: THEME_MODES,
    toBool,
    uninstallPrinter,
    updatePrinterStateWorkerConfig,
    writeSettings,
    writeVirtualPrinterConfig,
  })
  router.register()
}

function stopPrinterStateWorker() {
  printerStateWorkerStarting = false
  if (printerSnapshotRefreshTimer) {
    clearTimeout(printerSnapshotRefreshTimer)
    printerSnapshotRefreshTimer = null
  }
  if (!printerStateWorker) return
  try {
    printerStateWorker.postMessage({ type: 'stop' })
  } catch {}
  try {
    printerStateWorker.terminate()
  } catch {}
  printerStateWorker = null
}

function createPrinterStateWorker({
  backupDir = '',
  virtualPrinterConfig = virtualPrinterConfigCache,
} = {}) {
  if (printerStateWorker || appIsQuitting) return
  const workerPath = path.join(__dirname, 'worker', 'printer-state.mjs')
  printerStateWorker = new Worker(workerPath, {
    workerData: {
      pollIntervalMs: PRINTER_STATE_POLL_INTERVAL_MS,
      backupDir: String(backupDir || '').trim(),
      virtualPrinterConfig: normalizeVirtualPrinterConfig(virtualPrinterConfig),
    },
  })

  printerStateWorker.on('message', (message) => {
    const type = String(message?.type || '')
    if (type === 'snapshot') {
      const payload = message.payload || {}
      printerRuntimeState = {
        ...printerRuntimeState,
        ...payload,
      }
      printerSnapshotState = {
        ...printerSnapshotState,
        updatedAt: String(payload?.changedAt || new Date().toISOString()),
        backupDir: String(payload?.backupDir || printerSnapshotState.backupDir || ''),
        installedPrinters: Array.isArray(payload?.installedPrinters) ? payload.installedPrinters : printerSnapshotState.installedPrinters,
        driverIndexEntries: Array.isArray(payload?.driverIndexEntries) ? payload.driverIndexEntries : printerSnapshotState.driverIndexEntries,
        printerManage: Array.isArray(payload?.printerManage) ? payload.printerManage : printerSnapshotState.printerManage,
        spooler: String(payload?.spooler || printerSnapshotState.spooler || 'unknown'),
        ports: Array.isArray(payload?.ports) ? payload.ports : printerSnapshotState.ports,
        changes: payload?.changes || printerSnapshotState.changes,
      }
      broadcastPrinterState()
      broadcastPrinterSnapshot()
      return
    }
    if (type === 'error') {
      const msg = message?.payload?.message || 'unknown error'
      logWarn(`[printer-state] ${msg}`)
    }
  })

  printerStateWorker.on('error', (error) => {
    logWarn(`[printer-state] crash: ${error?.message || error}`)
  })

  printerStateWorker.on('exit', (code) => {
    printerStateWorkerStarting = false
    printerStateWorker = null
    if (!appIsQuitting && code !== 0) {
      setTimeout(() => {
        createPrinterStateWorker({
          backupDir: printerSnapshotState.backupDir,
          virtualPrinterConfig: virtualPrinterConfigCache,
        })
      }, 1200)
    }
  })
}

function startPrinterStateWorker({
  backupDir = '',
  virtualPrinterConfig = virtualPrinterConfigCache,
} = {}) {
  if (printerStateWorker || printerStateWorkerStarting || appIsQuitting) return
  printerStateWorkerStarting = true
  setTimeout(() => {
    if (printerStateWorker || appIsQuitting) {
      printerStateWorkerStarting = false
      return
    }
    try {
      createPrinterStateWorker({ backupDir, virtualPrinterConfig })
    } catch (error) {
      printerStateWorkerStarting = false
      logWarn(`[printer-state] start failed: ${error?.message || error}`)
    }
  }, 0)
}

async function openSystemAddPrinterWizard() {
  const script = await loadPsScript('printer-open-system-add-wizard')
  return runPowerShellJson(script, { timeoutMs: POWERSHELL_TIMEOUT_MS })
}

async function openPrinterPropertiesDialog({ printerName }) {
  const normalizedPrinterName = String(printerName || '').trim()
  if (!normalizedPrinterName) {
    throw new Error('Printer name is required.')
  }
  const script = await loadPsScript('printer-open-properties', {
    PRINTER_NAME: toPsSingleQuote(normalizedPrinterName),
  })
  return runPowerShellJson(script, { timeoutMs: POWERSHELL_TIMEOUT_MS })
}

async function openPrinterPreferencesDialog({ printerName }) {
  const normalizedPrinterName = String(printerName || '').trim()
  if (!normalizedPrinterName) {
    throw new Error('Printer name is required.')
  }
  const script = await loadPsScript('printer-open-preferences', {
    PRINTER_NAME: toPsSingleQuote(normalizedPrinterName),
  })
  return runPowerShellJson(script, { timeoutMs: POWERSHELL_TIMEOUT_MS })
}

async function renameInstalledPrinter({ printerName, newPrinterName }) {
  const sourcePrinterName = String(printerName || '').trim()
  const targetPrinterName = String(newPrinterName || '').trim()
  if (!sourcePrinterName) {
    throw new Error('Printer name is required.')
  }
  if (!targetPrinterName) {
    throw new Error('New printer name is required.')
  }
  if (sourcePrinterName === targetPrinterName) {
    return {
      status: 'unchanged',
      printerName: sourcePrinterName,
      newPrinterName: targetPrinterName,
    }
  }
  const script = await loadPsScript('printer-rename', {
    PRINTER_NAME: toPsSingleQuote(sourcePrinterName),
    NEW_PRINTER_NAME: toPsSingleQuote(targetPrinterName),
  })
  return runPowerShellJson(script, { timeoutMs: POWERSHELL_TIMEOUT_MS })
}

function updateVirtualPrinterConfigCache(nextConfig = null) {
  const normalized = normalizeVirtualPrinterConfig(nextConfig || DEFAULT_VIRTUAL_PRINTER_CONFIG)
  virtualPrinterConfigCache = normalized
  return normalized
}

function isVirtualPrinter(printer, virtualConfig = DEFAULT_VIRTUAL_PRINTER_CONFIG) {
  const name = String(printer?.name || printer?.printerName || '').toLowerCase()
  const driverName = String(printer?.driverName || '').toLowerCase()
  const portName = String(printer?.portName || '').toLowerCase()

  if (virtualConfig.keywords.some((keyword) => name.includes(keyword) || driverName.includes(keyword))) {
    return true
  }

  if (virtualConfig.exactPorts.includes(portName)) {
    return true
  }

  if (virtualConfig.prefixPorts.some((prefix) => portName.startsWith(prefix))) {
    return true
  }

  if (virtualConfig.containsPorts.some((keyword) => portName.includes(keyword))) {
    return true
  }

  return false
}

function filterVirtualPrinterRows(rows = [], virtualConfig = virtualPrinterConfigCache) {
  const list = Array.isArray(rows) ? rows : []
  return list.filter((item) => !isVirtualPrinter(item, virtualConfig))
}

function filterVirtualOffersFromLanState(state = {}, virtualConfig = virtualPrinterConfigCache) {
  const offers = filterVirtualPrinterRows(state?.offers, virtualConfig)
  return {
    ...(state || {}),
    offers,
  }
}

function ensureLanTransferManager() {
  if (lanTransferManager) return lanTransferManager
  lanTransferManager = new LanTransferManager({
    downloadTimeoutMs: LAN_DOWNLOAD_TIMEOUT_MS,
    ensureWritableBackupDir,
    getVirtualPrinterConfig: () => virtualPrinterConfigCache,
    installPrinterFromArchive,
    isVirtualPrinter,
    logWarn,
    readSettings,
    refreshPrinterSnapshot,
    requestPrinterStateRefresh,
    serviceArchivePathPrefix: LAN_SERVICE_ARCHIVE_PATH_PREFIX,
  })
  return lanTransferManager
}

function listLanTransferOffers(payload = {}) {
  return ensureLanTransferManager().listTransferOffers(payload)
}

function resolveLanOfferArchive(payload = {}) {
  return ensureLanTransferManager().resolveOfferArchive(payload)
}

function installLanOfferFromRemote(payload = {}) {
  return ensureLanTransferManager().installOfferFromRemote(payload)
}

function getLanConfigDirPath() {
  // LAN runtime identity and task logs must be machine-local and writable.
  return path.join(app.getPath('userData'), 'lan')
}

function ensureLanRuntime() {
  if (lanRuntime) return lanRuntime
  lanRuntime = createLanRuntime({
    configDir: getLanConfigDirPath(),
    appVersion: app.getVersion(),
    onListLocalOffers: async ({ nodeId } = {}) => listLanTransferOffers({ nodeId }),
    onResolveOfferArchive: async ({ offerId, nodeId } = {}) => resolveLanOfferArchive({ offerId, nodeId }),
    onRequestInstall: async ({ node, offer, targetPrinterName, onProgress } = {}) =>
      installLanOfferFromRemote({
        node,
        offer,
        targetPrinterName,
        onProgress,
      }),
    onStateChanged: (state) => {
      broadcastLanState(state)
    },
    onError: (error) => {
      logWarn(`[lan-runtime] ${error?.message || error}`)
    },
  })
  void lanRuntime.bootstrap().catch((error) => {
    logWarn(`[lan-runtime] bootstrap failed: ${error?.message || error}`)
  })
  return lanRuntime
}

async function applyLanSettings(settings = {}) {
  const runtime = ensureLanRuntime()
  runtime.setFeature(settings.feature || {})
  if (toBool(settings.lanEnabled, false)) {
    await runtime.start()
  } else {
    await runtime.stop()
  }
  return filterVirtualOffersFromLanState(runtime.getState(), virtualPrinterConfigCache)
}

function ensurePrintSocketService() {
  if (printSocketService) return printSocketService
  printSocketService = createPrintSocketService({
    appVersion: app.getVersion(),
    onListPrinters: async () => getInstalledPrinters(),
    onExecuteJob: async (job, payload) => executePrintSocketJob(job, payload),
    onStateChanged: (state) => {
      broadcastPrintServiceState(state)
    },
    onJobUpdated: (job) => {
      broadcastPrintJob(job)
    },
    onError: (error) => {
      logWarn(`[print-service] ${error?.message || error}`)
    },
  })
  return printSocketService
}

async function executePrintSocketJob(job = {}, payload = {}) {
  const type = String(job?.type || payload?.type || '').trim()
  if (type === 'html') {
    return printHtmlSocketJob(job, payload)
  }

  const result = await runRenderTask({
    ...payload,
    taskId: String(job?.taskId || ''),
    templateId: String(job?.templateId || payload?.templateId || ''),
    type,
    printer: String(job?.printer || payload?.printer || ''),
  })
  if (result?.ok === false) {
    const error = new Error(String(result?.message || 'Print execution failed.'))
    error.code = String(result?.code || 'PRINT_EXEC_FAILED')
    error.result = result
    throw error
  }
  return result ?? null
}

async function printHtmlSocketJob(job = {}, payload = {}) {
  const html = String(payload?.html || '').trim()
  if (!html) {
    const error = new Error('HTML print payload is empty.')
    error.code = 'PAYLOAD_INVALID'
    throw error
  }

  const printWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  try {
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
    await printWindow.loadURL(dataUrl)
    const printResult = await new Promise((resolve, reject) => {
      const options = {
        silent: payload?.silent === true,
        printBackground: true,
        deviceName: String(job?.printer || payload?.printer || '').trim(),
        copies: Math.max(Number(payload?.copies) || 1, 1),
      }
      printWindow.webContents.print(options, (success, failureReason) => {
        if (success) {
          resolve({
            ok: true,
            taskId: String(job?.taskId || ''),
            templateId: String(job?.templateId || payload?.templateId || ''),
            printer: options.deviceName,
          })
          return
        }
        const error = new Error(String(failureReason || 'HTML print failed.'))
        error.code = 'PRINT_EXEC_FAILED'
        reject(error)
      })
    })
    return printResult
  } finally {
    if (!printWindow.isDestroyed()) {
      printWindow.destroy()
    }
  }
}

async function applyPrintServiceSettings(settings = {}) {
  const runtime = ensurePrintSocketService()
  await runtime.applySettings({
    port: settings?.printServicePort,
    authToken: settings?.printServiceAuthToken,
  })
  if (toBool(settings?.printServiceEnabled, false)) {
    await runtime.start()
  } else {
    await runtime.stop()
  }
  return runtime.getState()
}

async function getInstalledPrinters() {
  const script = await loadPsScript('printer-list-installed')
  const data = await runPowerShellJson(script, { timeoutMs: POWERSHELL_TIMEOUT_MS })
  const list = Array.isArray(data) ? data : data ? [data] : []
  const filtered = filterVirtualPrinterRows(list, virtualPrinterConfigCache)
  const normalized = await Promise.all(
    filtered.map(async (item) => ({
      ...item,
      driver: item.driver ? await normalizeInstalledDriverVersion(item.driver) : item.driver,
    })),
  )
  return normalized
}

async function buildPrinterSnapshot() {
  const settings = await readSettings()
  const backupDir = await ensureWritableBackupDir(settings.backupDir)
  const indexObj = await ensureBackupIndex(backupDir)
  const normalizedIndex = await normalizeIndexDriverVersions(backupDir, indexObj)
  const installedPrinters = await getInstalledPrinters()
  return {
    updatedAt: new Date().toISOString(),
    backupDir,
    installedPrinters,
    driverIndexEntries: Array.isArray(normalizedIndex?.entries) ? normalizedIndex.entries : [],
  }
}

async function refreshPrinterSnapshot({ broadcast = true } = {}) {
  if (printerSnapshotRefreshRunning) {
    printerSnapshotRefreshPending = true
    return printerSnapshotState
  }

  printerSnapshotRefreshRunning = true
  try {
    requestPrinterStateRefresh()
    if (!printerSnapshotState.updatedAt) {
      try {
        const nextSnapshot = await buildPrinterSnapshot()
        printerSnapshotState = {
          ...printerSnapshotState,
          ...nextSnapshot,
        }
      } catch {}
    }
    if (broadcast) {
      broadcastPrinterSnapshot()
    }
    return printerSnapshotState
  } finally {
    printerSnapshotRefreshRunning = false
    if (printerSnapshotRefreshPending) {
      printerSnapshotRefreshPending = false
      void refreshPrinterSnapshot({ broadcast: true }).catch((error) => {
        logWarn(`[printer-snapshot] refresh failed: ${error?.message || error}`)
      })
    }
  }
}

function schedulePrinterSnapshotRefresh(delayMs = 900) {
  if (printerSnapshotRefreshTimer) {
    clearTimeout(printerSnapshotRefreshTimer)
  }
  printerSnapshotRefreshTimer = setTimeout(() => {
    printerSnapshotRefreshTimer = null
    void refreshPrinterSnapshot({ broadcast: true }).catch((error) => {
      logWarn(`[printer-snapshot] scheduled refresh failed: ${error?.message || error}`)
    })
  }, Math.max(Number(delayMs) || 0, 0))
}

async function listUsbPrinterPorts() {
  const script = await loadPsScript('printer-list-usb-ports')
  const data = await runPowerShellJson(script, { timeoutMs: POWERSHELL_TIMEOUT_MS })
  if (Array.isArray(data)) {
    return data.map((item) => String(item))
  }
  if (data) {
    return [String(data)]
  }
  return []
}

async function backupPrinterDriver({ printerName, backupDir }) {
  const targetRoot = await ensureWritableBackupDir(backupDir)

  const script = await loadPsScript('printer-backup-driver', {
    PRINTER_NAME: toPsSingleQuote(printerName),
    TARGET_ROOT: toPsSingleQuote(targetRoot),
  })
  const result = await runPowerShellJson(script, { timeoutMs: 120_000 })
  const backupPath = result.backupDir
  const infRelativePath = await findInfRelativePath(backupPath, path.basename(result.infPath || ''))
  const archiveInfo = await createBackupArchive(backupPath, targetRoot)

  const metadata = {
    printerName: result.printerName,
    driverName: result.driverName,
    driverVersion: '',
    manufacturer: String(result.manufacturer || ''),
    environment: String(result.environment || ''),
    portName: String(result.portName || ''),
    portHostAddress: String(result.portHostAddress || ''),
    portNumber: String(result.portNumber || ''),
    pnpDeviceId: String(result.pnpDeviceId || ''),
    hardwareIds: normalizeStringArray(result.hardwareIds),
    usbVid: String(result.usbVid || ''),
    usbPid: String(result.usbPid || ''),
    usbVidPid: String(result.usbVidPid || ''),
    deviceSerial: String(result.deviceSerial || ''),
    infRelativePath,
    backupAt: new Date().toISOString(),
    method: result.method,
    ...archiveInfo,
    extractPolicy: ARCHIVE_EXTRACT_POLICY_DEFAULT,
  }

  const backupInfPath = metadata.infRelativePath ? path.join(backupPath, metadata.infRelativePath) : ''
  const parsedBackupInf = await readDriverVerFromInfFile(backupInfPath)
  metadata.driverVersion = normalizeDriverVersionDisplay(result.driverVersion, parsedBackupInf)

  try {
    await upsertIndexEntry(targetRoot, {
      printerName: metadata.printerName,
      driverName: metadata.driverName,
      driverVersion: metadata.driverVersion,
      manufacturer: metadata.manufacturer,
      infRelativePath: metadata.infRelativePath,
      backupAt: metadata.backupAt,
      portName: metadata.portName,
      portHostAddress: metadata.portHostAddress,
      portNumber: metadata.portNumber,
      environment: metadata.environment,
      pnpDeviceId: metadata.pnpDeviceId,
      hardwareIds: metadata.hardwareIds,
      usbVid: metadata.usbVid,
      usbPid: metadata.usbPid,
      usbVidPid: metadata.usbVidPid,
      deviceSerial: metadata.deviceSerial,
      archiveFileName: metadata.archiveFileName,
      archiveRelativePath: metadata.archiveRelativePath,
      archiveSha256: metadata.archiveSha256,
      archiveSize: metadata.archiveSize,
      archiveFormat: metadata.archiveFormat,
      extractPolicy: metadata.extractPolicy,
    })

    return {
      ...result,
      ...metadata,
      backupDir: targetRoot,
      archivePath: resolveEntryArchivePath(targetRoot, metadata),
    }
  } finally {
    if (String(backupPath || '').trim()) {
      try {
        await safeRemoveDirectory(backupPath, {
          retries: 8,
          delayMs: 280,
        })
      } catch (error) {
        logWarn(`[backup-cleanup] failed to remove temp backup dir: ${error?.message || error}`)
      }
    }
  }
}

async function installPrinterFromArchive({
  archivePath,
  entry,
  targetPrinterName = '',
  portHostAddressOverride = '',
  onResolvedInfRelativePath,
} = {}) {
  const normalizedEntry = {
    printerName: String(entry?.printerName || '').trim(),
    driverName: String(entry?.driverName || '').trim(),
    portName: String(entry?.portName || '').trim(),
    portHostAddress: String(entry?.portHostAddress || '').trim(),
    infRelativePath: String(entry?.infRelativePath || '').trim(),
    archiveSha256: String(entry?.archiveSha256 || '').trim().toLowerCase(),
    usbVid: String(entry?.usbVid || '').trim().toUpperCase(),
    usbPid: String(entry?.usbPid || '').trim().toUpperCase(),
    usbVidPid: String(entry?.usbVidPid || '').trim().toUpperCase(),
    deviceSerial: String(entry?.deviceSerial || '').trim(),
  }
  const normalizedArchivePath = String(archivePath || '').trim()
  if (!normalizedArchivePath) {
    throw createArchiveError('ARCHIVE_NOT_FOUND', '驱动备份压缩包路径为空。')
  }
  const archiveExists = await isFileExists(normalizedArchivePath)
  if (!archiveExists) {
    throw createArchiveError('ARCHIVE_NOT_FOUND', `驱动备份压缩包不存在：${normalizedArchivePath}`)
  }
  if (normalizedEntry.archiveSha256) {
    const actualHash = await computeFileSha256(normalizedArchivePath)
    if (actualHash !== normalizedEntry.archiveSha256) {
      throw createArchiveError('ARCHIVE_HASH_MISMATCH', `驱动备份压缩包哈希不匹配：${normalizedArchivePath}`)
    }
  }

  const effectivePrinterName = String(targetPrinterName || '').trim() || normalizedEntry.printerName
  const effectivePortHostAddress = String(portHostAddressOverride || '').trim() || normalizedEntry.portHostAddress
  const hasUsbIdentity = Boolean(
    normalizedEntry.usbVidPid
    || (normalizedEntry.usbVid && normalizedEntry.usbPid)
    || normalizedEntry.deviceSerial,
  )
  const isUsbProfile = /^usb/i.test(normalizedEntry.portName) || hasUsbIdentity
  const preferredPortForInstall = isUsbProfile
    ? (normalizedEntry.portName || 'USB')
    : (normalizedEntry.portName || '')
  const preferredPortHostForInstall = isUsbProfile ? '' : effectivePortHostAddress

  let backupPath = ''
  let extractDir = ''
  try {
    const taskId = `install-${Date.now()}-${randomUUID().split('-')[0]}`
    const extracted = await extractBackupArchive(normalizedArchivePath, taskId)
    extractDir = extracted.extractDir
    backupPath = extractDir
  } catch (error) {
    throw createArchiveError(
      'ARCHIVE_EXTRACT_FAILED',
      `驱动备份压缩包解压失败：${normalizedArchivePath}。${error?.message || error}.`,
    )
  }

  let infPath = path.join(backupPath, normalizedEntry.infRelativePath || '')
  let infRelativePath = normalizedEntry.infRelativePath || ''
  let validInfPath = false

  try {
    const stat = await fs.stat(infPath)
    validInfPath = stat.isFile() && infPath.toLowerCase().endsWith('.inf')
  } catch {
    validInfPath = false
  }

  if (!validInfPath) {
    let fallbackInf = ''
    try {
      fallbackInf = await findInfRelativePath(backupPath, path.basename(infRelativePath || ''))
    } catch {
      fallbackInf = ''
    }
    if (fallbackInf) {
      infRelativePath = fallbackInf
      infPath = path.join(backupPath, fallbackInf)
      if (typeof onResolvedInfRelativePath === 'function') {
        await onResolvedInfRelativePath(fallbackInf)
      }
    } else {
      throw createArchiveError(
        'ARCHIVE_INF_NOT_FOUND',
        `驱动备份压缩包中未找到可安装的 INF 文件：${normalizedArchivePath}`,
      )
    }
  }

  const script = await loadPsScript('printer-install-from-backup', {
    PRINTER_NAME: toPsSingleQuote(effectivePrinterName),
    EXPECTED_DRIVER_NAME: toPsSingleQuote(normalizedEntry.driverName),
    PREFERRED_PORT: toPsSingleQuote(preferredPortForInstall),
    PREFERRED_PORT_HOST: toPsSingleQuote(preferredPortHostForInstall),
    INF_PATH: toPsSingleQuote(infPath),
    BACKUP_PATH: toPsSingleQuote(backupPath),
  })
  try {
    const result = await runPowerShellJson(script, { timeoutMs: 120_000 })
    return result
  } finally {
    if (extractDir) {
      await safeCleanupExtractDir(extractDir)
    }
  }
}

async function installPrinterFromBackup({
  printerName,
  backupDir,
  targetPrinterName = '',
  portHostAddressOverride = '',
}) {
  const resolvedBackupDir = await ensureWritableBackupDir(backupDir)
  const indexObj = await ensureBackupIndex(resolvedBackupDir)
  const normalizedPrinterName = String(printerName || '').trim().toLowerCase()
  const entry = indexObj.entries.find((item) => item.printerName === printerName)
    || indexObj.entries.find((item) => item.printerName.toLowerCase() === normalizedPrinterName)
  if (!entry) {
    throw new Error(`No backup index entry found for printer: ${printerName}`)
  }
  const effectivePrinterName = String(targetPrinterName || '').trim() || entry.printerName
  const effectivePortHostAddress = String(portHostAddressOverride || '').trim() || String(entry.portHostAddress || '')

  const archivePath = resolveEntryArchivePath(resolvedBackupDir, entry)
  if (!archivePath) {
    throw createArchiveError('ARCHIVE_NOT_FOUND', `备份索引缺少压缩包路径：${entry.printerName}`)
  }
  return installPrinterFromArchive({
    archivePath,
    entry,
    targetPrinterName: effectivePrinterName,
    portHostAddressOverride: effectivePortHostAddress,
    onResolvedInfRelativePath: async (fallbackInf) => {
      if (!fallbackInf) return
      await upsertIndexEntry(resolvedBackupDir, {
        ...entry,
        infRelativePath: fallbackInf,
      })
    },
  })
}

async function pingHost(host) {
  const targetHost = String(host || '').trim()
  if (!targetHost) {
    throw new Error('Host is required.')
  }
  const script = await loadPsScript('printer-ping-host', {
    HOST_VALUE: toPsSingleQuote(targetHost),
  })
  return runPowerShellJson(script, { timeoutMs: POWERSHELL_TIMEOUT_MS })
}

async function uninstallPrinter({ printerName }) {
  const script = await loadPsScript('printer-uninstall', {
    PRINTER_NAME: toPsSingleQuote(printerName),
  })
  return runPowerShellJson(script, { timeoutMs: 120_000 })
}

async function printPrinterTestPage({ printerName }) {
  const normalizedPrinterName = String(printerName || '').trim()
  if (!normalizedPrinterName) {
    throw new Error('Printer name is required.')
  }
  const script = await loadPsScript('printer-print-test-page', {
    PRINTER_NAME: toPsSingleQuote(normalizedPrinterName),
  })
  return runPowerShellJson(script, { timeoutMs: POWERSHELL_TIMEOUT_MS })
}

async function deleteBackupDriver({ printerName, backupDir }) {
  const targetPrinterName = String(printerName || '').trim()
  if (!targetPrinterName) {
    throw new Error('Printer name is required.')
  }
  const targetRoot = await ensureWritableBackupDir(backupDir)
  const indexObj = await ensureBackupIndex(targetRoot)
  const targetKey = targetPrinterName.toLowerCase()
  const removedIndex = indexObj.entries.findIndex((entry) => String(entry?.printerName || '').trim().toLowerCase() === targetKey)
  if (removedIndex < 0) {
    throw new Error(`No backup index entry found for printer: ${targetPrinterName}`)
  }

  const removedEntry = indexObj.entries[removedIndex]
  const nextEntries = indexObj.entries.filter((_, index) => index !== removedIndex)
  await writeIndexFile(targetRoot, {
    ...indexObj,
    entries: nextEntries,
  })

  const archiveInfo = normalizeArchiveFields(removedEntry)
  const archiveRel = String(archiveInfo.archiveRelativePath || archiveInfo.archiveFileName || '').trim()
  let archiveDeleted = false
  if (archiveRel) {
    const archiveInUse = nextEntries.some((entry) => {
      const nextArchive = normalizeArchiveFields(entry)
      const nextArchiveRel = String(nextArchive.archiveRelativePath || nextArchive.archiveFileName || '').trim()
      return nextArchiveRel && nextArchiveRel.toLowerCase() === archiveRel.toLowerCase()
    })
    if (!archiveInUse) {
      const archivePath = resolvePathInsideRoot(targetRoot, archiveRel)
      if (archivePath) {
        await fs.rm(archivePath, { force: true })
        archiveDeleted = true
      }
    }
  }

  return {
    status: 'deleted',
    printerName: removedEntry.printerName,
    archiveRelativePath: archiveRel,
    archiveDeleted,
  }
}

appShell.captureStartupProtocol(process.argv)

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_, commandLine) => {
    appShell.handleSecondInstance(commandLine)
  })

  app.on('open-url', (event, url) => {
    event.preventDefault()
    appShell.handleProtocolOpen(url)
  })

  app.whenReady().then(async () => {
    appShell.registerCustomProtocolClient()
    updateVirtualPrinterConfigCache(await readVirtualPrinterConfig())
    let startupSettings = await readSettings()
    startupSettings = await ensureStartupBackupDirSetting(startupSettings)
    await ensureBackupIndex(startupSettings.backupDir)
    printerSnapshotState = {
      ...printerSnapshotState,
      backupDir: startupSettings.backupDir,
    }
    try {
      await applyLanSettings(startupSettings)
    } catch (error) {
      logWarn(`[lan-runtime] apply startup settings failed: ${error?.message || error}`)
    }
    try {
      await applyPrintServiceSettings(startupSettings)
    } catch (error) {
      logWarn(`[print-service] apply startup settings failed: ${error?.message || error}`)
    }

    registerIpcHandlers()

    const win = appShell.createWindow()
    updateManager = new UpdateManager(win)
    appShell.createTray()
    startPrinterStateWorker({
      backupDir: startupSettings.backupDir,
      virtualPrinterConfig: virtualPrinterConfigCache,
    })
    void refreshPrinterSnapshot({ broadcast: true }).catch((error) => {
      logWarn(`[printer-snapshot] bootstrap refresh failed: ${error?.message || error}`)
    })
    appShell.openPendingProtocolRoute()

    app.on('activate', () => {
      appShell.show('/')
    })
  })

  app.on('before-quit', () => {
    appShell.markQuitting()
    appShell.destroyTray()
    stopPrinterStateWorker()
    if (lanRuntime) {
      void lanRuntime.dispose()
    }
    if (printSocketService) {
      void printSocketService.dispose()
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
