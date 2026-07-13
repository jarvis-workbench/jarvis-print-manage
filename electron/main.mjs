import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell } from 'electron'
import { createReadStream, createWriteStream, existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { loadPsScript } from './config/script/ps/index.mjs'
import { createLanRuntime } from './lan/runtime.mjs'
import { createPrintSocketService } from './print-socket-service.mjs'
import { runPowerShell, runPowerShellJson } from './powershell.mjs'
import { UpdateManager } from './update-manager.mjs'
import { runRenderTask } from './worker/print-render-task.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)
const APP_TITLE = '打印机助手'
const THEME_MODES = new Set(['light', 'dark', 'system'])
const INDEX_FILE_NAME = 'driver-index.json'
const BACKUP_META_FILE_NAME = 'driver-backup.json'
const TRAY_ICON_NAME = 'tray.png'
const PRINTER_STATE_POLL_INTERVAL_MS = 2000
const SYSTEM_SETTINGS_RELATIVE_PATH = path.join('config', 'system.json')
const VIRTUAL_PRINTER_CONFIG_RELATIVE_PATH = path.join('config', 'virtual-printer.json')
const POWERSHELL_TIMEOUT_MS = 30_000
const ARCHIVE_FORMAT = 'pdrv.zip'
const ARCHIVE_FILE_SUFFIX = '.pdrv.zip'
const ARCHIVE_EXTRACT_POLICY_DEFAULT = 'cleanup-on-success'
const LAN_SERVICE_ARCHIVE_PATH_PREFIX = '/lan/v1/archive/'
const LAN_DOWNLOAD_TIMEOUT_MS = 120_000
const CUSTOM_PROTOCOL_SCHEME = 'hstools'
const KNOWN_ROUTE_PATHS = new Set(['/', '/printers', '/settings', '/driver-install'])
const DEFAULT_PRINT_SERVICE_PORT = 17521
const DEFAULT_FEATURE_SETTINGS = {
  backup: {
    archiveEnabled: true,
  },
  lan: {
    discoveryEnabled: false,
    transferEnabled: false,
    autoInstallEnabled: false,
  },
}
const DEFAULT_VIRTUAL_PRINTER_CONFIG = {
  keywords: [
    'pdf',
    'xps',
    'fax',
    'onenote',
    'virtual',
    'document writer',
    'microsoft print to pdf',
    'microsoft xps document writer',
    'adobe pdf',
    'foxit pdf',
    'wps pdf',
    'doro pdf',
    'cutepdf',
    'priprinter',
  ],
  exactPorts: ['file:', 'portprompt:', 'nul:'],
  prefixPorts: ['redir', 'ts'],
  containsPorts: ['prompt'],
}

let mainWindow = null
let tray = null
let appIsQuitting = false
if (isDev) {
  const devUserDataPath = path.join(app.getPath('appData'), `${app.getName()}-dev`)
  app.setPath('userData', devUserDataPath)
}
const gotSingleInstanceLock = app.requestSingleInstanceLock()
let printerStateWorker = null
let pendingProtocolRoutePath = ''
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
let lanRuntime = null
let printSocketService = null
let updateManager = null
let printerStateWorkerStarting = false
let virtualPrinterConfigCache = normalizeVirtualPrinterConfig(DEFAULT_VIRTUAL_PRINTER_CONFIG)

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

function upsertIpcHandler(channel, handler) {
  try {
    ipcMain.removeHandler(channel)
  } catch {}
  ipcMain.handle(channel, handler)
}

function toBool(value, fallback = false) {
  if (value === true || value === false) return value
  if (typeof value === 'string') return value.toLowerCase() === 'true'
  if (value == null) return fallback
  return Boolean(value)
}

function normalizeFeatureSettings(feature = {}) {
  return {
    backup: {
      archiveEnabled: toBool(feature?.backup?.archiveEnabled, DEFAULT_FEATURE_SETTINGS.backup.archiveEnabled),
    },
    lan: {
      discoveryEnabled: toBool(feature?.lan?.discoveryEnabled, DEFAULT_FEATURE_SETTINGS.lan.discoveryEnabled),
      transferEnabled: toBool(feature?.lan?.transferEnabled, DEFAULT_FEATURE_SETTINGS.lan.transferEnabled),
      autoInstallEnabled: toBool(feature?.lan?.autoInstallEnabled, DEFAULT_FEATURE_SETTINGS.lan.autoInstallEnabled),
    },
  }
}

function normalizePrintServicePort(value, fallback = DEFAULT_PRINT_SERVICE_PORT) {
  const port = Number(value)
  if (!Number.isFinite(port)) return fallback
  const normalized = Math.trunc(port)
  if (normalized < 1 || normalized > 65535) return fallback
  return normalized
}

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
  if (!mainWindow || mainWindow.isDestroyed()) {
    throw new Error('主窗口尚未就绪')
  }
  updateManager = new UpdateManager(mainWindow)
  return updateManager
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

function getResourceRootPath() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, 'resource')
}

function getWritableConfigRootPath() {
  return app.isPackaged ? app.getPath('userData') : getResourceRootPath()
}

function getSettingsFilePath() {
  return path.join(getWritableConfigRootPath(), SYSTEM_SETTINGS_RELATIVE_PATH)
}

function getDefaultSettingsFilePath() {
  return path.join(getResourceRootPath(), SYSTEM_SETTINGS_RELATIVE_PATH)
}

function getVirtualPrinterConfigPath() {
  return path.join(getWritableConfigRootPath(), VIRTUAL_PRINTER_CONFIG_RELATIVE_PATH)
}

function getDefaultVirtualPrinterConfigPath() {
  return path.join(getResourceRootPath(), VIRTUAL_PRINTER_CONFIG_RELATIVE_PATH)
}

function getIndexFilePath(backupDir) {
  return path.join(backupDir, INDEX_FILE_NAME)
}

function normalizeArchiveFields(entry = {}) {
  const archiveFileName = String(entry.archiveFileName || '').trim()
  const rawArchiveRelativePath = String(entry.archiveRelativePath || archiveFileName).trim()
  const archiveRelativePath = normalizeArchiveRelativePath(rawArchiveRelativePath)
  const archiveSha256 = String(entry.archiveSha256 || '').trim().toLowerCase()
  const archiveSizeRaw = Number(entry.archiveSize)
  const archiveSize = Number.isFinite(archiveSizeRaw) && archiveSizeRaw > 0 ? archiveSizeRaw : 0
  const archiveFormat = String(entry.archiveFormat || '').trim() || (archiveRelativePath ? ARCHIVE_FORMAT : '')
  const extractPolicy = String(entry.extractPolicy || '').trim() || ARCHIVE_EXTRACT_POLICY_DEFAULT
  return {
    archiveFileName,
    archiveRelativePath,
    archiveSha256,
    archiveSize,
    archiveFormat,
    extractPolicy,
  }
}

function normalizeArchiveRelativePath(value) {
  const text = String(value || '').trim()
  if (!text || path.isAbsolute(text)) return ''
  const normalized = path.normalize(text)
  if (
    normalized === '..'
    || normalized.startsWith(`..${path.sep}`)
    || normalized.includes(`${path.sep}..${path.sep}`)
  ) {
    return ''
  }
  return normalized
}

function resolvePathInsideRoot(rootDir, relativePath) {
  const rawRoot = String(rootDir || '').trim()
  if (!rawRoot) return ''
  const root = path.resolve(rawRoot)
  const rel = normalizeArchiveRelativePath(relativePath)
  if (!root || !rel) return ''
  const target = path.resolve(root, rel)
  const relative = path.relative(root, target)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
    return ''
  }
  return target
}

function isTransientLanArchivePath(value) {
  const text = String(value || '').trim().replace(/\\/g, '/').toLowerCase()
  if (!text) return false
  if (text.startsWith('lan-remote/')) return true
  return text.includes('/lan-remote/')
}

function createArchiveError(code, message) {
  const error = new Error(`[${code}] ${message}`)
  error.code = code
  return error
}

async function isFileExists(filePath) {
  try {
    const stat = await fs.stat(filePath)
    return stat.isFile()
  } catch {
    return false
  }
}

async function computeFileSha256(filePath) {
  const hash = createHash('sha256')
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath)
    stream.on('data', (chunk) => hash.update(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(hash.digest('hex')))
  })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(Number(ms) || 0, 0)))
}

async function safeRemoveDirectory(dirPath, {
  retries = 5,
  delayMs = 220,
} = {}) {
  const target = String(dirPath || '').trim()
  if (!target) return
  let lastError = null
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      await fs.rm(target, { recursive: true, force: true })
      return
    } catch (error) {
      lastError = error
      const code = String(error?.code || '').toUpperCase()
      const retryable = code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
      if (!retryable || attempt >= retries) break
      await sleep(delayMs * (attempt + 1))
    }
  }
  throw lastError
}

function normalizeArchiveFileName(name, fallback = `archive-${Date.now()}`) {
  const raw = sanitizeFileName(name || '', fallback)
  if (raw.toLowerCase().endsWith(ARCHIVE_FILE_SUFFIX)) {
    return raw
  }
  return `${raw}${ARCHIVE_FILE_SUFFIX}`
}

async function resolveUniqueArchiveTargetPath(targetRoot, preferredFileName) {
  const normalized = normalizeArchiveFileName(preferredFileName, `archive-${Date.now()}`)
  const ext = path.extname(normalized)
  const baseName = normalized.slice(0, normalized.length - ext.length)
  let fileName = normalized
  let absPath = path.join(targetRoot, fileName)
  let suffix = 1
  while (await isFileExists(absPath)) {
    fileName = `${baseName}-${suffix}${ext}`
    absPath = path.join(targetRoot, fileName)
    suffix += 1
  }
  return {
    archiveFileName: fileName,
    archivePath: absPath,
  }
}

async function createBackupArchive(backupPath, targetRoot) {
  const backupSubDir = path.basename(backupPath)
  let archiveFileName = `${backupSubDir}${ARCHIVE_FILE_SUFFIX}`
  let archivePath = path.join(targetRoot, archiveFileName)
  let suffix = 1
  while (await isFileExists(archivePath)) {
    archiveFileName = `${backupSubDir}-${suffix}${ARCHIVE_FILE_SUFFIX}`
    archivePath = path.join(targetRoot, archiveFileName)
    suffix += 1
  }

  const script = await loadPsScript('printer-archive-create', {
    SOURCE_PATH: toPsSingleQuote(backupPath),
    TARGET_PATH: toPsSingleQuote(archivePath),
  })
  await runPowerShell(script, { timeoutMs: 120_000 })

  const stat = await fs.stat(archivePath)
  const archiveSha256 = await computeFileSha256(archivePath)
  return {
    archiveFileName,
    archiveRelativePath: archiveFileName,
    archiveSha256,
    archiveSize: stat.size,
    archiveFormat: ARCHIVE_FORMAT,
  }
}

function resolveEntryArchivePath(backupDir, entry = {}) {
  const archive = normalizeArchiveFields(entry)
  const archiveRel = archive.archiveRelativePath || archive.archiveFileName
  if (!archiveRel) return ''
  return resolvePathInsideRoot(backupDir, archiveRel)
}

async function extractBackupArchive(archivePath, taskId) {
  const extractRoot = path.join(app.getPath('temp'), 'EleDrive', 'extract')
  const extractDir = path.join(extractRoot, taskId)
  await fs.rm(extractDir, { recursive: true, force: true })
  await fs.mkdir(extractDir, { recursive: true })

  const script = await loadPsScript('printer-archive-extract', {
    ARCHIVE_PATH: toPsSingleQuote(archivePath),
    EXTRACT_PATH: toPsSingleQuote(extractDir),
  })
  await runPowerShell(script, { timeoutMs: 120_000 })
  return {
    extractDir,
  }
}

async function safeCleanupExtractDir(extractDir) {
  if (!extractDir) return
  try {
    await fs.rm(extractDir, { recursive: true, force: true })
  } catch {}
}

function toPsSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
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

function getDefaultBackupDir() {
  const docsPath = sanitizeBackupDirPath(app.getPath('documents'))
  if (docsPath) {
    return path.join(docsPath, 'EleDrive', 'driver-backups')
  }
  const userDataPath = sanitizeBackupDirPath(app.getPath('userData'))
  if (userDataPath) {
    return path.join(userDataPath, 'driver-backups')
  }
  return path.join(process.cwd(), 'driver-backups')
}

function stripWindowsLongPathPrefix(rawPath) {
  const text = String(rawPath || '').trim()
  if (!text) return ''
  if (process.platform !== 'win32') return text
  if (text.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${text.slice('\\\\?\\UNC\\'.length)}`
  }
  if (text.startsWith('\\\\?\\')) {
    return text.slice('\\\\?\\'.length)
  }
  return text
}

function sanitizeBackupDirPath(rawPath) {
  const text = stripWindowsLongPathPrefix(rawPath).trim()
  if (!text) return ''

  if (process.platform === 'win32') {
    const lower = text.toLowerCase()
    if (lower === '\\\\?' || lower === '\\\\?\\' || lower === '\\?' || lower === '?') {
      return ''
    }
    if (/[?*<>|"]/u.test(text)) {
      return ''
    }
  }

  return text
}

async function isDirectoryPath(targetPath) {
  const value = sanitizeBackupDirPath(targetPath)
  if (!value) return false
  try {
    const stat = await fs.stat(value)
    return stat.isDirectory()
  } catch {
    return false
  }
}

function getOrderedNonSystemDriveLetters() {
  const letters = []
  for (let code = 68; code <= 90; code += 1) {
    letters.push(String.fromCharCode(code))
  }
  for (let code = 65; code <= 66; code += 1) {
    letters.push(String.fromCharCode(code))
  }
  return letters.filter((letter) => letter !== 'C')
}

async function resolveForcedStartupBackupDir() {
  if (process.platform !== 'win32') {
    return getDefaultBackupDir()
  }

  for (const letter of getOrderedNonSystemDriveLetters()) {
    const root = `${letter}:\\`
    if (await isDirectoryPath(root)) {
      return path.join(root, 'hstool', 'driver', 'printer')
    }
  }
  return path.join('C:\\', 'hstool', 'driver', 'printer')
}

async function ensureStartupBackupDirSetting(settings = {}) {
  const currentBackupDir = sanitizeBackupDirPath(settings?.backupDir)
  if (currentBackupDir && await isDirectoryPath(currentBackupDir)) {
    return {
      ...settings,
      backupDir: currentBackupDir,
    }
  }

  const forcedBackupDir = await resolveForcedStartupBackupDir()
  await fs.mkdir(forcedBackupDir, { recursive: true })
  const saved = await writeSettings({
    ...settings,
    backupDir: forcedBackupDir,
  })
  return saved
}

function resolveBackupDirPath(backupDir, fallbackBackupDir = '') {
  const primary = sanitizeBackupDirPath(backupDir)
  if (primary) return primary
  const fallback = sanitizeBackupDirPath(fallbackBackupDir)
  if (fallback) return fallback
  return getDefaultBackupDir()
}

async function ensureWritableBackupDir(backupDir, fallbackBackupDir = '') {
  const candidates = [
    resolveBackupDirPath(backupDir, fallbackBackupDir),
    getDefaultBackupDir(),
    path.join(app.getPath('userData'), 'driver-backups'),
  ]
  const uniqueCandidates = [...new Set(candidates.map((item) => sanitizeBackupDirPath(item)).filter(Boolean))]
  let lastError = null
  for (const candidate of uniqueCandidates) {
    try {
      await fs.mkdir(candidate, { recursive: true })
      return candidate
    } catch (error) {
      lastError = error
    }
  }
  throw lastError || new Error('No writable backup directory available.')
}

function normalizeVirtualPrinterConfig(raw = {}) {
  const toLowerList = (value) => {
    const list = Array.isArray(value) ? value : []
    return [...new Set(list.map((item) => String(item || '').trim().toLowerCase()).filter(Boolean))]
  }

  return {
    keywords: toLowerList(raw?.keywords || DEFAULT_VIRTUAL_PRINTER_CONFIG.keywords),
    exactPorts: toLowerList(raw?.exactPorts || raw?.ports?.exact || DEFAULT_VIRTUAL_PRINTER_CONFIG.exactPorts),
    prefixPorts: toLowerList(raw?.prefixPorts || raw?.ports?.prefix || DEFAULT_VIRTUAL_PRINTER_CONFIG.prefixPorts),
    containsPorts: toLowerList(raw?.containsPorts || raw?.ports?.contains || DEFAULT_VIRTUAL_PRINTER_CONFIG.containsPorts),
  }
}

async function readVirtualPrinterConfig() {
  try {
    const fileText = await fs.readFile(getVirtualPrinterConfigPath(), 'utf-8')
    return normalizeVirtualPrinterConfig(JSON.parse(fileText))
  } catch {
    try {
      const fileText = await fs.readFile(getDefaultVirtualPrinterConfigPath(), 'utf-8')
      return normalizeVirtualPrinterConfig(JSON.parse(fileText))
    } catch {
      return normalizeVirtualPrinterConfig(DEFAULT_VIRTUAL_PRINTER_CONFIG)
    }
  }
}

async function writeVirtualPrinterConfig(raw = {}) {
  const normalized = normalizeVirtualPrinterConfig(raw)
  const filePath = getVirtualPrinterConfigPath()
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(normalized, null, 2), 'utf-8')
  virtualPrinterConfigCache = normalized
  return normalized
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

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
  }
  const text = String(value || '').trim()
  if (!text) return []
  return [...new Set(text.split(/[;,]/).map((item) => item.trim()).filter(Boolean))]
}

function normalizeIdentityFields(entry = {}) {
  const hardwareIds = normalizeStringArray(entry.hardwareIds || entry.hardwareIdList || entry.hardwareId)
  const pnpDeviceId = String(entry.pnpDeviceId || '').trim()
  const usbVid = String(entry.usbVid || '').trim().toUpperCase()
  const usbPid = String(entry.usbPid || '').trim().toUpperCase()
  const usbVidPidRaw = String(entry.usbVidPid || '').trim().toUpperCase()
  const usbVidPid = usbVidPidRaw || (usbVid && usbPid ? `${usbVid}:${usbPid}` : '')
  const deviceSerial = String(entry.deviceSerial || '').trim()

  return {
    pnpDeviceId,
    hardwareIds,
    usbVid,
    usbPid,
    usbVidPid,
    deviceSerial,
  }
}

function buildIndexIdentityKey(entry = {}) {
  const normalized = normalizeIdentityFields(entry)
  if (normalized.pnpDeviceId) return `pnp:${normalized.pnpDeviceId.toLowerCase()}`
  if (normalized.usbVidPid && normalized.deviceSerial) {
    return `usb:${normalized.usbVidPid.toLowerCase()}:${normalized.deviceSerial.toLowerCase()}`
  }
  if (normalized.hardwareIds.length > 0) {
    return `hw:${normalized.hardwareIds[0].toLowerCase()}`
  }
  if (normalized.usbVidPid) {
    return `usb:${normalized.usbVidPid.toLowerCase()}`
  }
  return ''
}

function normalizeIndex(raw) {
  const entries = Array.isArray(raw?.entries) ? raw.entries : []
  return {
    version: 1,
    updatedAt: raw?.updatedAt || new Date().toISOString(),
    entries: entries
      .filter((entry) => entry && entry.printerName)
      .map((entry) => ({
        printerName: String(entry.printerName),
        driverName: String(entry.driverName || ''),
        driverVersion: String(entry.driverVersion || ''),
        manufacturer: String(entry.manufacturer || ''),
        infRelativePath: String(entry.infRelativePath || ''),
        backupAt: String(entry.backupAt || ''),
        portName: String(entry.portName || ''),
        portHostAddress: String(entry.portHostAddress || ''),
        portNumber: String(entry.portNumber || ''),
        environment: String(entry.environment || ''),
        ...normalizeIdentityFields(entry),
        ...normalizeArchiveFields(entry),
      }))
      .filter((entry) => !isTransientLanArchivePath(entry.archiveRelativePath || entry.archiveFileName)),
  }
}

async function writeIndexFile(backupDir, indexObj) {
  const targetDir = resolveBackupDirPath(backupDir)
  const normalized = normalizeIndex({
    ...indexObj,
    updatedAt: new Date().toISOString(),
  })
  await fs.mkdir(targetDir, { recursive: true })
  await fs.writeFile(getIndexFilePath(targetDir), JSON.stringify(normalized, null, 2), 'utf-8')
  return normalized
}

async function readIndexFileIfExists(backupDir) {
  const targetDir = resolveBackupDirPath(backupDir)
  try {
    const fileText = await fs.readFile(getIndexFilePath(targetDir), 'utf-8')
    return normalizeIndex(JSON.parse(fileText))
  } catch {
    return null
  }
}

async function scanBackupDirForIndex(backupDir) {
  const targetDir = resolveBackupDirPath(backupDir)
  let dirents = []
  try {
    dirents = await fs.readdir(targetDir, { withFileTypes: true })
  } catch {
    return {
      version: 1,
      updatedAt: new Date().toISOString(),
      entries: [],
    }
  }

  const entries = []
  // Legacy folder-mode backup index rebuild fallback.
  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue
    const backupSubDir = dirent.name
    const backupPath = path.join(targetDir, backupSubDir)
    const metaPath = path.join(backupPath, BACKUP_META_FILE_NAME)

    try {
      const metaText = await fs.readFile(metaPath, 'utf-8')
      const meta = JSON.parse(metaText)
      if (!meta?.printerName) continue
      entries.push({
        printerName: String(meta.printerName),
        driverName: String(meta.driverName || ''),
        driverVersion: String(meta.driverVersion || ''),
        manufacturer: String(meta.manufacturer || ''),
        infRelativePath: String(meta.infRelativePath || ''),
        backupAt: String(meta.backupAt || ''),
        portName: String(meta.portName || ''),
        portHostAddress: String(meta.portHostAddress || ''),
        portNumber: String(meta.portNumber || ''),
        environment: String(meta.environment || ''),
        ...normalizeIdentityFields(meta),
        ...normalizeArchiveFields(meta),
      })
    } catch {
      // ignore invalid metadata file
    }
  }

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    entries,
  }
}

async function ensureBackupIndex(backupDir) {
  const targetDir = resolveBackupDirPath(backupDir)
  await fs.mkdir(targetDir, { recursive: true })
  const existing = await readIndexFileIfExists(targetDir)
  if (existing) return existing
  const rebuilt = await scanBackupDirForIndex(targetDir)
  return writeIndexFile(targetDir, rebuilt)
}

async function upsertIndexEntry(backupDir, nextEntry) {
  const archiveFields = normalizeArchiveFields(nextEntry)
  if (isTransientLanArchivePath(archiveFields.archiveRelativePath || archiveFields.archiveFileName)) {
    throw new Error('Transient LAN archive path cannot be persisted in backup index.')
  }
  const indexObj = await ensureBackupIndex(backupDir)
  const key = nextEntry.printerName.toLowerCase()
  const nextIdentityKey = buildIndexIdentityKey(nextEntry)
  const remaining = indexObj.entries.filter((entry) => {
    if (entry.printerName.toLowerCase() === key) return false
    if (!nextIdentityKey) return true
    const existingIdentityKey = buildIndexIdentityKey(entry)
    return !existingIdentityKey || existingIdentityKey !== nextIdentityKey
  })
  remaining.push(nextEntry)
  return writeIndexFile(backupDir, {
    ...indexObj,
    entries: remaining.sort((a, b) => a.printerName.localeCompare(b.printerName)),
  })
}

async function findInfRelativePath(backupPath, preferredInfName = '') {
  const found = []

  async function walk(currentPath, relBase = '') {
    const dirents = await fs.readdir(currentPath, { withFileTypes: true })
    for (const dirent of dirents) {
      const nextAbs = path.join(currentPath, dirent.name)
      const nextRel = relBase ? path.join(relBase, dirent.name) : dirent.name
      if (dirent.isDirectory()) {
        await walk(nextAbs, nextRel)
      } else if (dirent.isFile() && dirent.name.toLowerCase().endsWith('.inf')) {
        found.push(nextRel)
      }
    }
  }

  await walk(backupPath)
  if (found.length === 0) return ''
  if (!preferredInfName) return found[0]

  const preferred = found.find((item) => path.basename(item).toLowerCase() === preferredInfName.toLowerCase())
  return preferred || found[0]
}

function isRawDriverVersionValue(value) {
  const text = String(value || '').trim()
  return /^\d{10,}$/.test(text)
}

function extractDriverVerFromInfText(text) {
  if (!text) return null
  const lines = String(text).split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line || line.startsWith(';')) continue
    const match = line.match(/^DriverVer(?:\.[^=]+)?\s*=\s*([^,]+)\s*,\s*([^\s,;][^;]*)$/i)
    if (!match) continue
    const rawDate = String(match[1] || '').trim()
    const rawVersion = String(match[2] || '').trim()
    if (!rawVersion) continue
    return {
      version: rawVersion,
      date: rawDate,
    }
  }
  return null
}

async function readDriverVerFromInfFile(infFilePath) {
  if (!infFilePath) return null
  try {
    const content = await fs.readFile(infFilePath, 'utf-8')
    return extractDriverVerFromInfText(content)
  } catch {
    return null
  }
}

async function resolveSystemInfPath(infPathValue = '') {
  const raw = String(infPathValue || '').trim()
  if (!raw) return ''
  const checkCandidate = async (candidate) => {
    try {
      const stat = await fs.stat(candidate)
      if (stat.isFile()) return candidate
    } catch {}
    return ''
  }

  if (path.isAbsolute(raw)) {
    const found = await checkCandidate(raw)
    if (found) return found
  }

  const windir = process.env.windir || process.env.WINDIR || 'C:\\Windows'
  if (raw.toLowerCase().endsWith('.inf')) {
    const found = await checkCandidate(path.join(windir, 'INF', raw))
    if (found) return found
  }

  return ''
}

function normalizeDriverVersionDisplay(fallbackValue, parsedInf) {
  const infVersion = String(parsedInf?.version || '').trim()
  if (infVersion) return infVersion
  const fallback = String(fallbackValue || '').trim()
  if (!fallback) return ''
  if (isRawDriverVersionValue(fallback)) return ''
  return fallback
}

async function normalizeInstalledDriverVersion(driver) {
  if (!driver) return driver
  const infPath = await resolveSystemInfPath(driver.infPath)
  const parsedInf = await readDriverVerFromInfFile(infPath)
  return {
    ...driver,
    infPath: infPath || String(driver.infPath || ''),
    driverVersion: normalizeDriverVersionDisplay(driver.driverVersion, parsedInf),
  }
}

async function resolveBackupInfPathFromIndexEntry(backupDir, entry) {
  const infRelativePath = String(entry?.infRelativePath || '').trim()
  if (!infRelativePath) return ''
  const candidates = [path.join(backupDir, infRelativePath)]
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate)
      if (stat.isFile()) return candidate
    } catch {}
  }
  return ''
}

async function normalizeIndexDriverVersions(backupDir, indexObj) {
  if (!indexObj?.entries?.length) return indexObj
  let changed = false
  const nextEntries = await Promise.all(
    indexObj.entries.map(async (entry) => {
      const needsNormalize = !entry.driverVersion || isRawDriverVersionValue(entry.driverVersion)
      if (!needsNormalize) return entry
      const infPath = await resolveBackupInfPathFromIndexEntry(backupDir, entry)
      const parsedInf = await readDriverVerFromInfFile(infPath)
      const nextVersion = normalizeDriverVersionDisplay(entry.driverVersion, parsedInf)
      if (nextVersion === entry.driverVersion) return entry
      changed = true
      return {
        ...entry,
        driverVersion: nextVersion,
      }
    }),
  )

  if (!changed) return indexObj
  return writeIndexFile(backupDir, {
    ...indexObj,
    entries: nextEntries,
  })
}

function normalizeSettings(raw = {}) {
  const parsed = raw && typeof raw === 'object' ? raw : {}
  const feature = normalizeFeatureSettings(parsed?.feature)
  const lanEnabled = toBool(parsed?.lanEnabled, feature.lan.discoveryEnabled)
  feature.lan.discoveryEnabled = lanEnabled
  const backupDir = resolveBackupDirPath(parsed?.backupDir)
  const printServiceEnabled = toBool(parsed?.printServiceEnabled, false)
  const printServicePort = normalizePrintServicePort(parsed?.printServicePort, DEFAULT_PRINT_SERVICE_PORT)
  const printServiceAuthToken = String(parsed?.printServiceAuthToken || '').trim()
  return {
    backupDir,
    themeMode: THEME_MODES.has(parsed.themeMode) ? parsed.themeMode : 'system',
    lanEnabled,
    printServiceEnabled,
    printServicePort,
    printServiceAuthToken,
    feature,
  }
}

function getFallbackSettings() {
  const feature = normalizeFeatureSettings()
  return {
    backupDir: getDefaultBackupDir(),
    themeMode: 'system',
    lanEnabled: feature.lan.discoveryEnabled,
    printServiceEnabled: false,
    printServicePort: DEFAULT_PRINT_SERVICE_PORT,
    printServiceAuthToken: '',
    feature,
  }
}

async function readJsonFileIfExists(filePath) {
  try {
    const fileText = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(fileText)
  } catch {
    return null
  }
}

async function readSettings() {
  const writableSettings = await readJsonFileIfExists(getSettingsFilePath())
  if (writableSettings) {
    return normalizeSettings(writableSettings)
  }
  const defaultSettings = await readJsonFileIfExists(getDefaultSettingsFilePath())
  if (defaultSettings) {
    return normalizeSettings(defaultSettings)
  }
  return getFallbackSettings()
}

async function writeSettings(nextSettings) {
  const current = await readSettings()
  const nextFeature = normalizeFeatureSettings(nextSettings?.feature || current?.feature || {})
  const lanEnabled = typeof nextSettings?.lanEnabled === 'boolean'
    ? nextSettings.lanEnabled
    : toBool(current?.lanEnabled, nextFeature.lan.discoveryEnabled)
  nextFeature.lan.discoveryEnabled = lanEnabled
  const printServiceEnabled = typeof nextSettings?.printServiceEnabled === 'boolean'
    ? nextSettings.printServiceEnabled
    : toBool(current?.printServiceEnabled, false)
  const printServicePort = normalizePrintServicePort(nextSettings?.printServicePort, current?.printServicePort)
  const printServiceAuthToken = nextSettings?.printServiceAuthToken !== undefined
    ? String(nextSettings.printServiceAuthToken || '').trim()
    : String(current?.printServiceAuthToken || '').trim()
  const backupDir = resolveBackupDirPath(nextSettings?.backupDir, current?.backupDir)
  const merged = {
    backupDir,
    themeMode: THEME_MODES.has(nextSettings.themeMode) ? nextSettings.themeMode : current.themeMode || 'system',
    lanEnabled,
    printServiceEnabled,
    printServicePort,
    printServiceAuthToken,
    feature: nextFeature,
  }

  await fs.mkdir(path.dirname(getSettingsFilePath()), { recursive: true })
  await fs.writeFile(getSettingsFilePath(), JSON.stringify(merged, null, 2), 'utf-8')
  return merged
}

function sanitizeFileName(name, fallback = 'archive') {
  const raw = String(name || '').trim()
  const sanitized = raw
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
  return sanitized || fallback
}

function sanitizeLanArchiveRelativePath(rawRelativePath, fallbackOfferId = '') {
  const raw = String(rawRelativePath || '').trim().replace(/\\/g, '/')
  const fallbackName = sanitizeFileName(fallbackOfferId || `offer-${Date.now()}`, 'offer')
  const base = sanitizeFileName(path.posix.basename(raw || `${fallbackName}${ARCHIVE_FILE_SUFFIX}`), fallbackName)
  const withExt = base.toLowerCase().endsWith(ARCHIVE_FILE_SUFFIX)
    ? base
    : `${base}${ARCHIVE_FILE_SUFFIX}`
  return path.posix.join('lan-remote', withExt)
}

function buildLanOfferId(entry = {}) {
  const archive = normalizeArchiveFields(entry)
  const seed = [
    String(entry.printerName || ''),
    String(entry.driverName || ''),
    String(entry.driverVersion || ''),
    String(entry.environment || ''),
    String(entry.portHostAddress || entry.portName || ''),
    String(entry.pnpDeviceId || ''),
    String(archive.archiveRelativePath || archive.archiveFileName || ''),
    String(archive.archiveSha256 || ''),
  ].join('|')
  const digest = createHash('sha1').update(seed).digest('hex').slice(0, 24)
  return `offer-${digest}`
}

function toLanOfferRecord({ entry = {}, backupDir = '', nodeId = '' } = {}) {
  const archive = normalizeArchiveFields(entry)
  const archiveRelativePath = String(archive.archiveRelativePath || archive.archiveFileName || '').trim()
  if (!archiveRelativePath) return null
  const archiveFileName = String(archive.archiveFileName || path.basename(archiveRelativePath)).trim()
  const archivePath = resolvePathInsideRoot(backupDir, archiveRelativePath)
  if (!archivePath) return null
  const identityKey = buildIndexIdentityKey(entry)
    || `${String(entry.driverName || '').trim().toLowerCase()}::${String(entry.printerName || '').trim().toLowerCase()}`
  return {
    offerId: buildLanOfferId(entry),
    nodeId: String(nodeId || '').trim(),
    printerName: String(entry.printerName || ''),
    driverName: String(entry.driverName || ''),
    driverVersion: String(entry.driverVersion || ''),
    manufacturer: String(entry.manufacturer || ''),
    environment: String(entry.environment || ''),
    portName: String(entry.portName || ''),
    portHostAddress: String(entry.portHostAddress || ''),
    portNumber: String(entry.portNumber || ''),
    pnpDeviceId: String(entry.pnpDeviceId || ''),
    hardwareIds: normalizeStringArray(entry.hardwareIds),
    usbVid: String(entry.usbVid || ''),
    usbPid: String(entry.usbPid || ''),
    usbVidPid: String(entry.usbVidPid || ''),
    deviceSerial: String(entry.deviceSerial || ''),
    infRelativePath: String(entry.infRelativePath || ''),
    backupAt: String(entry.backupAt || ''),
    identityKey,
    archiveFileName,
    archiveRelativePath,
    archivePath,
    archiveFormat: String(archive.archiveFormat || ARCHIVE_FORMAT || ''),
    archiveSha256: String(archive.archiveSha256 || '').toLowerCase(),
    archiveSize: Number(archive.archiveSize) || 0,
    extractPolicy: String(archive.extractPolicy || ARCHIVE_EXTRACT_POLICY_DEFAULT),
  }
}

async function listLanTransferOffers({ nodeId = '' } = {}) {
  const settings = await readSettings()
  const backupDir = await ensureWritableBackupDir(settings?.backupDir)
  const indexObj = await ensureBackupIndex(backupDir)
  const offers = []
  for (const entry of indexObj.entries || []) {
    if (isVirtualPrinter(entry, virtualPrinterConfigCache)) continue
    const offer = toLanOfferRecord({ entry, backupDir, nodeId })
    if (!offer?.archiveRelativePath) continue
    const archiveExists = await isFileExists(offer.archivePath)
    if (!archiveExists) continue
    if (!offer.archiveSize) {
      try {
        const stat = await fs.stat(offer.archivePath)
        if (stat.isFile()) {
          offer.archiveSize = Number(stat.size) || 0
        }
      } catch {}
    }
    offers.push({
      offerId: offer.offerId,
      nodeId: offer.nodeId,
      printerName: offer.printerName,
      driverName: offer.driverName,
      driverVersion: offer.driverVersion,
      manufacturer: offer.manufacturer,
      environment: offer.environment,
      portName: offer.portName,
      portHostAddress: offer.portHostAddress,
      portNumber: offer.portNumber,
      identityKey: offer.identityKey,
      archiveFileName: offer.archiveFileName,
      archiveRelativePath: offer.archiveRelativePath,
      archiveFormat: offer.archiveFormat,
      archiveSha256: offer.archiveSha256,
      archiveSize: offer.archiveSize,
      infRelativePath: offer.infRelativePath,
      backupAt: offer.backupAt,
      pnpDeviceId: offer.pnpDeviceId,
      hardwareIds: offer.hardwareIds,
      usbVid: offer.usbVid,
      usbPid: offer.usbPid,
      usbVidPid: offer.usbVidPid,
      deviceSerial: offer.deviceSerial,
    })
  }
  return offers.sort((a, b) => String(a.printerName || '').localeCompare(String(b.printerName || '')))
}

async function resolveLanOfferArchive({ offerId = '', nodeId = '' } = {}) {
  const normalizedOfferId = String(offerId || '').trim()
  if (!normalizedOfferId) return null
  const offers = await listLanTransferOffers({ nodeId })
  const matched = offers.find((item) => String(item.offerId || '') === normalizedOfferId)
  if (!matched) return null
  const settings = await readSettings()
  const backupDir = await ensureWritableBackupDir(settings?.backupDir)
  const archivePath = resolvePathInsideRoot(backupDir, String(matched.archiveRelativePath || ''))
  if (!archivePath) return null
  const archiveExists = await isFileExists(archivePath)
  if (!archiveExists) return null
  return {
    offer: matched,
    archivePath,
  }
}

async function downloadLanArchiveToPath({ archiveUrl, targetPath, timeoutMs = LAN_DOWNLOAD_TIMEOUT_MS, onProgress } = {}) {
  const urlObj = new URL(String(archiveUrl || ''))
  const client = urlObj.protocol === 'https:' ? https : http
  const tmpPath = `${targetPath}.downloading-${Date.now()}-${randomUUID().slice(0, 8)}`
  await fs.mkdir(path.dirname(targetPath), { recursive: true })

  return new Promise((resolve, reject) => {
    let settled = false
    let req = null
    let fileStream = null
    const hash = createHash('sha256')
    let downloaded = 0
    let total = 0

    const cleanup = async () => {
      try {
        if (fileStream) {
          fileStream.destroy()
        }
      } catch {}
      try {
        await fs.rm(tmpPath, { force: true })
      } catch {}
    }

    const finish = async (error, payload = null) => {
      if (settled) return
      settled = true
      if (req) {
        try { req.destroy() } catch {}
      }
      if (error) {
        await cleanup()
        reject(error)
        return
      }
      try {
        await fs.rename(tmpPath, targetPath)
      } catch (renameError) {
        await cleanup()
        reject(renameError)
        return
      }
      resolve(payload || {
        size: downloaded,
        sha256: hash.digest('hex'),
      })
    }

    req = client.request(urlObj, { method: 'GET', timeout: timeoutMs }, (res) => {
      const statusCode = Number(res.statusCode || 0)
      if (statusCode !== 200) {
        const chunks = []
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf-8').slice(0, 400)
          void finish(new Error(`LAN archive download failed: HTTP ${statusCode}${bodyText ? ` ${bodyText}` : ''}`))
        })
        return
      }

      total = Number(res.headers['content-length'] || 0) || 0
      fileStream = createWriteStream(tmpPath, { flags: 'w' })
      fileStream.on('error', (error) => {
        void finish(error)
      })
      res.on('error', (error) => {
        void finish(error)
      })
      res.on('data', (chunk) => {
        const buf = Buffer.from(chunk)
        downloaded += buf.length
        hash.update(buf)
        if (typeof onProgress === 'function') {
          try {
            onProgress({
              downloaded,
              total,
            })
          } catch {}
        }
      })
      res.pipe(fileStream)
      fileStream.on('close', () => {
        void finish(null, {
          size: downloaded,
          sha256: hash.digest('hex'),
        })
      })
    })

    req.on('timeout', () => {
      void finish(new Error('LAN archive download timeout.'))
    })
    req.on('error', (error) => {
      void finish(error)
    })
    req.end()
  })
}

async function installLanOfferFromRemote({
  node,
  offer,
  targetPrinterName = '',
  onProgress,
} = {}) {
  const host = String(node?.host || '').trim()
  const servicePort = Number(node?.servicePort) || 0
  const offerId = String(offer?.offerId || '').trim()
  if (!host || !servicePort || !offerId) {
    throw new Error('LAN offer install payload is invalid.')
  }

  const settings = await readSettings()
  const backupDir = await ensureWritableBackupDir(settings?.backupDir)
  const tempArchiveRoot = path.join(backupDir, 'lan-remote')
  await fs.mkdir(tempArchiveRoot, { recursive: true })
  const tempArchiveTarget = await resolveUniqueArchiveTargetPath(
    tempArchiveRoot,
    path.basename(String(offer.archiveFileName || `${offerId}${ARCHIVE_FILE_SUFFIX}`)),
  )
  const tempArchivePath = tempArchiveTarget.archivePath
  const archiveUrl = `http://${host}:${servicePort}${LAN_SERVICE_ARCHIVE_PATH_PREFIX}${encodeURIComponent(offerId)}`

  if (typeof onProgress === 'function') {
    onProgress(8)
  }

  const downloadResult = await downloadLanArchiveToPath({
    archiveUrl,
    targetPath: tempArchivePath,
    timeoutMs: LAN_DOWNLOAD_TIMEOUT_MS,
    onProgress: ({ downloaded, total }) => {
      if (typeof onProgress !== 'function') return
      if (!total || total <= 0) return
      const ratio = Math.max(0, Math.min(downloaded / total, 1))
      const progress = Math.round(8 + (ratio * 52))
      onProgress(progress)
    },
  })

  const actualSha256 = String(downloadResult?.sha256 || '').toLowerCase()
  const expectedSha256 = String(offer?.archiveSha256 || '').trim().toLowerCase()
  if (expectedSha256 && actualSha256 && expectedSha256 !== actualSha256) {
    throw createArchiveError(
      'ARCHIVE_HASH_MISMATCH',
      `远端驱动包哈希不匹配。expected=${expectedSha256}, actual=${actualSha256}`,
    )
  }

  const actualSize = Number(downloadResult?.size) || 0
  const expectedSize = Number(offer?.archiveSize) || 0
  if (expectedSize > 0 && actualSize > 0 && expectedSize !== actualSize) {
    logWarn(`[lan-install] archive size mismatch, continue with downloaded file. expected=${expectedSize}, actual=${actualSize}`)
  }

  let resolvedInfRelativePath = String(offer?.infRelativePath || '')
  const installEntry = {
    printerName: String(offer?.printerName || ''),
    driverName: String(offer?.driverName || ''),
    driverVersion: String(offer?.driverVersion || ''),
    manufacturer: String(offer?.manufacturer || ''),
    infRelativePath: resolvedInfRelativePath,
    backupAt: String(offer?.backupAt || new Date().toISOString()),
    portName: String(offer?.portName || ''),
    portHostAddress: String(offer?.portHostAddress || ''),
    portNumber: String(offer?.portNumber || ''),
    environment: String(offer?.environment || ''),
    pnpDeviceId: String(offer?.pnpDeviceId || ''),
    hardwareIds: normalizeStringArray(offer?.hardwareIds),
    usbVid: String(offer?.usbVid || ''),
    usbPid: String(offer?.usbPid || ''),
    usbVidPid: String(offer?.usbVidPid || ''),
    deviceSerial: String(offer?.deviceSerial || ''),
    archiveFileName: '',
    archiveRelativePath: '',
    archiveSha256: expectedSha256 || actualSha256,
    archiveSize: actualSize || expectedSize,
    archiveFormat: String(offer?.archiveFormat || ARCHIVE_FORMAT || ''),
    extractPolicy: ARCHIVE_EXTRACT_POLICY_DEFAULT,
  }

  let shouldCleanupTempArchive = false
  try {
    if (typeof onProgress === 'function') {
      onProgress(70)
    }
    const installResult = await installPrinterFromArchive({
      archivePath: tempArchivePath,
      entry: installEntry,
      targetPrinterName: String(targetPrinterName || '').trim(),
      portHostAddressOverride: '',
      onResolvedInfRelativePath: async (fallbackInf) => {
        resolvedInfRelativePath = String(fallbackInf || '').trim()
      },
    })

    if (typeof onProgress === 'function') {
      onProgress(90)
    }

    const persistedArchiveTarget = await resolveUniqueArchiveTargetPath(
      backupDir,
      path.basename(String(offer.archiveFileName || `${offerId}${ARCHIVE_FILE_SUFFIX}`)),
    )
    await fs.copyFile(tempArchivePath, persistedArchiveTarget.archivePath)
    const persistedArchiveStat = await fs.stat(persistedArchiveTarget.archivePath)
    await upsertIndexEntry(backupDir, {
      ...installEntry,
      printerName: String(installResult?.printerName || installEntry.printerName),
      infRelativePath: resolvedInfRelativePath,
      archiveFileName: persistedArchiveTarget.archiveFileName,
      archiveRelativePath: persistedArchiveTarget.archiveFileName,
      archiveSha256: actualSha256 || expectedSha256,
      archiveSize: Number(persistedArchiveStat?.size || actualSize || expectedSize || 0),
    })
    shouldCleanupTempArchive = true

    requestPrinterStateRefresh()
    await refreshPrinterSnapshot({ broadcast: true })

    if (typeof onProgress === 'function') {
      onProgress(100)
    }

    return {
      status: String(installResult?.status || 'done'),
      printerName: String(installResult?.printerName || installEntry.printerName),
      driverName: String(installResult?.driverName || installEntry.driverName),
      archiveRelativePath: persistedArchiveTarget.archiveFileName,
      backupPersisted: true,
    }
  } catch (error) {
    logWarn(`[lan-install] failed. offerId=${offerId}, archive=${tempArchivePath}, message=${error?.message || error}`)
    throw error
  } finally {
    if (shouldCleanupTempArchive) {
      try {
        await fs.rm(tempArchivePath, { force: true })
      } catch {}
      try {
        const rest = await fs.readdir(tempArchiveRoot)
        if (!rest.length) {
          await fs.rm(tempArchiveRoot, { recursive: true, force: true })
        }
      } catch {}
    }
  }
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

function getTrayIcon() {
  const candidates = [
    path.join(__dirname, TRAY_ICON_NAME),
    path.join(app.getAppPath(), 'electron', TRAY_ICON_NAME),
  ]

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const icon = nativeImage.createFromPath(candidate)
    if (!icon.isEmpty()) {
      return process.platform === 'win32' ? icon.resize({ width: 16, height: 16 }) : icon
    }
  }

  return null
}

function getCustomProtocolPrefix() {
  return `${CUSTOM_PROTOCOL_SCHEME}://`
}

function normalizeRoutePath(routePath = '') {
  let text = String(routePath || '').trim()
  if (!text) return '/'
  if (text.startsWith('#')) {
    text = text.slice(1)
  }
  if (!text.startsWith('/')) {
    text = `/${text}`
  }
  text = text.replace(/\/{2,}/g, '/')

  let queryText = ''
  const queryIndex = text.indexOf('?')
  if (queryIndex >= 0) {
    queryText = text.slice(queryIndex + 1)
    text = text.slice(0, queryIndex)
  }
  if (text.length > 1) {
    text = text.replace(/\/+$/, '')
  }
  if (!KNOWN_ROUTE_PATHS.has(text)) {
    text = '/'
  }
  return queryText ? `${text}?${queryText}` : text
}

function parseProtocolUrlToRoutePath(rawUrl = '') {
  const value = String(rawUrl || '').trim()
  if (!value || !value.toLowerCase().startsWith(getCustomProtocolPrefix())) {
    return ''
  }

  let parsed = null
  try {
    parsed = new URL(value)
  } catch {
    return ''
  }
  if (String(parsed.protocol || '').toLowerCase() !== `${CUSTOM_PROTOCOL_SCHEME}:`) {
    return ''
  }

  let routePath = String(parsed.searchParams.get('path') || parsed.searchParams.get('route') || '').trim()
  if (!routePath) {
    if (parsed.hash && parsed.hash.startsWith('#/')) {
      routePath = parsed.hash.slice(1)
    } else {
      const host = decodeURIComponent(String(parsed.hostname || '').trim())
      const pathname = decodeURIComponent(String(parsed.pathname || '').trim())
      if (host && pathname && pathname !== '/') {
        routePath = `/${host}${pathname}`
      } else if (host) {
        routePath = `/${host}`
      } else {
        routePath = pathname || '/'
      }
    }
  }

  const passthrough = new URLSearchParams(parsed.searchParams)
  passthrough.delete('path')
  passthrough.delete('route')
  const normalized = normalizeRoutePath(routePath)
  const hasQuery = normalized.includes('?')
  const queryText = passthrough.toString()
  if (!hasQuery && queryText) {
    return `${normalized}?${queryText}`
  }
  return normalized
}

function findProtocolUrlFromArgv(argv = []) {
  const prefix = getCustomProtocolPrefix()
  const args = Array.isArray(argv) ? argv : []
  return args.find((arg) => typeof arg === 'string' && arg.toLowerCase().startsWith(prefix)) || ''
}

function registerCustomProtocolClient() {
  try {
    if (process.defaultApp) {
      const entryScript = process.argv[1] ? path.resolve(process.argv[1]) : ''
      if (entryScript) {
        app.setAsDefaultProtocolClient(CUSTOM_PROTOCOL_SCHEME, process.execPath, [entryScript])
        return
      }
    }
    app.setAsDefaultProtocolClient(CUSTOM_PROTOCOL_SCHEME)
  } catch (error) {
    logWarn(`[protocol] register failed: ${error?.message || error}`)
  }
}

function openMainWindowByRoutePath(routePath = '/') {
  const normalizedPath = normalizeRoutePath(routePath)
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents.isLoadingMainFrame()) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    navigateMainWindow(normalizedPath)
    return
  }
  showMainWindow(normalizedPath)
}

function handleProtocolOpen(rawUrl = '') {
  const routePath = parseProtocolUrlToRoutePath(rawUrl)
  if (!routePath) return false
  if (app.isReady()) {
    openMainWindowByRoutePath(routePath)
  } else {
    pendingProtocolRoutePath = routePath
  }
  return true
}

function navigateMainWindow(pathName = '/') {
  if (!mainWindow || mainWindow.isDestroyed()) return

  const payload = { path: pathName || '/' }
  const send = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    mainWindow.webContents.send('app:navigate', payload)
  }

  if (mainWindow.webContents.isLoadingMainFrame()) {
    mainWindow.webContents.once('did-finish-load', send)
  } else {
    send()
  }
}

function showMainWindow(pathName = '') {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow()
  }
  if (!mainWindow || mainWindow.isDestroyed()) return

  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  mainWindow.focus()

  if (pathName) {
    navigateMainWindow(pathName)
  }
}

function createTray() {
  if (tray) return tray

  const trayIcon = getTrayIcon()
  if (!trayIcon) {
    logWarn('[tray] tray icon not found, skip tray initialization.')
    return null
  }

  tray = new Tray(trayIcon)
  tray.setToolTip(APP_TITLE)

  const contextMenu = Menu.buildFromTemplate([
    {
      label: '打开主界面',
      click: () => showMainWindow('/'),
    },
    {
      label: '打印机管理',
      click: () => showMainWindow('/printers'),
    },
    {
      label: '系统设置',
      click: () => showMainWindow('/settings'),
    },
    {
      type: 'separator',
    },
    {
      label: '退出',
      click: () => {
        appIsQuitting = true
        app.quit()
      },
    },
  ])

  tray.setContextMenu(contextMenu)
  tray.on('click', () => showMainWindow('/'))
  return tray
}

function createMainWindow() {
  const packagedAppRoot = app.getAppPath()
  const preloadPath = app.isPackaged
    ? path.join(packagedAppRoot, 'electron', 'preload.cjs')
    : path.join(__dirname, 'preload.cjs')

  const win = new BrowserWindow({
    width: 1000,
    height: 650,
    show: false,
    minWidth: 1000,
    minHeight: 650,
    maxWidth: 1000,
    maxHeight: 650,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: APP_TITLE,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow = win

  win.on('close', (event) => {
    if (appIsQuitting) return
    event.preventDefault()
    win.hide()
  })

  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null
    }
  })

  win.on('page-title-updated', (event) => {
    event.preventDefault()
    win.setTitle(APP_TITLE)
  })

  if (isDev) {
    const devUrl = process.env.VITE_DEV_SERVER_URL
    win.loadURL(devUrl)
    win.webContents.openDevTools({ mode: 'detach' })
    win.webContents.on('did-fail-load', (_, code, desc, url) => {
      logError(`[renderer-load-failed] code=${code} desc=${desc} url=${url}`)
    })
  } else {
    win.loadFile(path.join(packagedAppRoot, 'dist', 'index.html'))
  }

  // Avoid white-screen flash: reveal window only after renderer finishes loading.
  win.webContents.once('did-finish-load', () => {
    if (mainWindow !== win || win.isDestroyed() || appIsQuitting) return
    if (!win.isVisible()) win.show()
    win.focus()
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  return win
}

const startupProtocolUrl = findProtocolUrlFromArgv(process.argv)
if (startupProtocolUrl) {
  pendingProtocolRoutePath = parseProtocolUrlToRoutePath(startupProtocolUrl) || pendingProtocolRoutePath
}

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', (_, commandLine) => {
    const protocolUrl = findProtocolUrlFromArgv(commandLine)
    if (protocolUrl && handleProtocolOpen(protocolUrl)) {
      return
    }
    if (app.isReady()) {
      showMainWindow('/')
      return
    }
    app.whenReady().then(() => showMainWindow('/'))
  })

  app.on('open-url', (event, url) => {
    event.preventDefault()
    handleProtocolOpen(url)
  })

  app.whenReady().then(async () => {
    registerCustomProtocolClient()
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

    upsertIpcHandler('app:get-version', () => app.getVersion())
    upsertIpcHandler('updates:get-status', async () => ensureUpdateManager().getStatus())
    upsertIpcHandler('updates:check-for-updates', async () => ensureUpdateManager().checkForUpdates())
    upsertIpcHandler('updates:download-update', async () => ensureUpdateManager().downloadUpdate())
    upsertIpcHandler('updates:quit-and-install', async () => {
      const manager = ensureUpdateManager()
      if (manager.getStatus()?.phase !== 'downloaded') {
        return manager.quitAndInstall()
      }
      appIsQuitting = true
      return manager.quitAndInstall()
    })

    upsertIpcHandler('settings:get', async () => readSettings())
    upsertIpcHandler('settings:get-virtual-printer-config', async () => ({
      ...virtualPrinterConfigCache,
    }))
    upsertIpcHandler('settings:set-backup-dir', async (_, backupDir) => {
      if (!backupDir || typeof backupDir !== 'string') {
        throw new Error('Invalid backup directory path.')
      }
      const writableBackupDir = await ensureWritableBackupDir(backupDir)
      const saved = await writeSettings({ backupDir: writableBackupDir })
      await ensureBackupIndex(saved.backupDir)
      updatePrinterStateWorkerConfig({ backupDir: saved.backupDir })
      requestPrinterStateRefresh()
      await refreshPrinterSnapshot({ broadcast: true })
      return saved
    })
    upsertIpcHandler('settings:set-virtual-printer-config', async (_, payload) => {
      const savedConfig = await writeVirtualPrinterConfig(payload || {})
      updatePrinterStateWorkerConfig({
        backupDir: printerSnapshotState.backupDir,
        virtualPrinterConfig: savedConfig,
      })
      requestPrinterStateRefresh()
      await refreshPrinterSnapshot({ broadcast: true })
      broadcastLanState()
      return {
        ...savedConfig,
      }
    })
    upsertIpcHandler('settings:set-theme-mode', async (_, themeMode) => {
      if (!THEME_MODES.has(themeMode)) {
        throw new Error('Invalid theme mode.')
      }
      return writeSettings({ themeMode })
    })
    upsertIpcHandler('settings:choose-backup-dir', async () => {
      const result = await dialog.showOpenDialog({
        title: '选择打印机驱动备份目录',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (result.canceled || !result.filePaths?.[0]) {
        return null
      }
      return result.filePaths[0]
    })
    upsertIpcHandler('settings:open-backup-dir', async () => {
      const settings = await readSettings()
      const backupDir = await ensureWritableBackupDir(settings?.backupDir)
      if (!backupDir) {
        throw new Error('备份目录未配置')
      }
      const openResult = await shell.openPath(backupDir)
      if (openResult) {
        throw new Error(openResult)
      }
      return {
        path: backupDir,
        opened: true,
      }
    })

    upsertIpcHandler('lan:get-state', async () => {
      const runtime = ensureLanRuntime()
      return filterVirtualOffersFromLanState(runtime.getState(), virtualPrinterConfigCache)
    })
    upsertIpcHandler('lan:set-enabled', async (_, payload) => {
      const enabled = toBool(payload?.enabled, false)
      const saved = await writeSettings({ lanEnabled: enabled })
      const state = await applyLanSettings(saved)
      return {
        enabled: state.enabled,
        startedAt: state.startedAt,
      }
    })
    upsertIpcHandler('lan:list-nodes', async () => {
      const runtime = ensureLanRuntime()
      return runtime.listNodes()
    })
    upsertIpcHandler('lan:list-offers', async () => {
      const runtime = ensureLanRuntime()
      if (typeof runtime.syncOffers === 'function') {
        await runtime.syncOffers()
      }
      return filterVirtualPrinterRows(runtime.listOffers(), virtualPrinterConfigCache)
    })
    upsertIpcHandler('lan:request-install', async (_, payload) => {
      const runtime = ensureLanRuntime()
      const task = await runtime.requestInstall(payload || {})
      return {
        taskId: task.taskId,
        status: task.status,
      }
    })
    upsertIpcHandler('lan:get-task', async (_, payload) => {
      const runtime = ensureLanRuntime()
      return runtime.getTask(payload?.taskId)
    })
    upsertIpcHandler('lan:cancel-task', async (_, payload) => {
      const runtime = ensureLanRuntime()
      return runtime.cancelTask(payload?.taskId)
    })

    upsertIpcHandler('print:service:get-state', async () => {
      const runtime = ensurePrintSocketService()
      return runtime.getState()
    })
    upsertIpcHandler('print:service:set-enabled', async (_, payload) => {
      const enabled = toBool(payload?.enabled, false)
      const saved = await writeSettings({
        printServiceEnabled: enabled,
        printServicePort: payload?.port,
        printServiceAuthToken: payload?.authToken,
      })
      return applyPrintServiceSettings(saved)
    })
    upsertIpcHandler('print:service:get-client-info', async () => {
      const runtime = ensurePrintSocketService()
      return runtime.getClientInfo()
    })
    upsertIpcHandler('print:service:get-printer-list', async () => {
      const runtime = ensurePrintSocketService()
      return runtime.getPrinterList()
    })
    upsertIpcHandler('print:service:list-jobs', async () => {
      const runtime = ensurePrintSocketService()
      return runtime.listJobs()
    })
    upsertIpcHandler('print:service:get-job', async (_, payload) => {
      const runtime = ensurePrintSocketService()
      return runtime.getJob(payload?.taskId)
    })
    upsertIpcHandler('print:service:submit-job', async (_, payload) => {
      const runtime = ensurePrintSocketService()
      return runtime.submitJob(payload || {})
    })
    upsertIpcHandler('print:service:reprint', async (_, payload) => {
      const runtime = ensurePrintSocketService()
      return runtime.reprint(payload?.taskId)
    })

    upsertIpcHandler('printers:list-installed', async () => getInstalledPrinters())
    upsertIpcHandler('printers:snapshot:get', async () => {
      if (!printerSnapshotState.updatedAt) {
        await refreshPrinterSnapshot({ broadcast: false })
      }
      return {
        ...printerSnapshotState,
      }
    })
    upsertIpcHandler('printers:list-usb-ports', async () => listUsbPrinterPorts())
    upsertIpcHandler('printers:state:get', async () => ({ ...printerRuntimeState }))
    upsertIpcHandler('printers:open-system-add-wizard', async () => openSystemAddPrinterWizard())
    upsertIpcHandler('printers:open-properties', async (_, payload) => {
      if (!payload?.printerName || typeof payload.printerName !== 'string') {
        throw new Error('Invalid printer name.')
      }
      return openPrinterPropertiesDialog({
        printerName: payload.printerName,
      })
    })
    upsertIpcHandler('printers:open-preferences', async (_, payload) => {
      if (!payload?.printerName || typeof payload.printerName !== 'string') {
        throw new Error('Invalid printer name.')
      }
      return openPrinterPreferencesDialog({
        printerName: payload.printerName,
      })
    })
    upsertIpcHandler('printers:rename', async (_, payload) => {
      if (!payload?.printerName || typeof payload.printerName !== 'string') {
        throw new Error('Invalid printer name.')
      }
      if (!payload?.newPrinterName || typeof payload.newPrinterName !== 'string') {
        throw new Error('Invalid new printer name.')
      }
      const result = await renameInstalledPrinter({
        printerName: payload.printerName,
        newPrinterName: payload.newPrinterName,
      })
      requestPrinterStateRefresh()
      await refreshPrinterSnapshot({ broadcast: true })
      return result
    })
    upsertIpcHandler('printers:backup-driver', async (_, payload) => {
      if (!payload?.printerName || typeof payload.printerName !== 'string') {
        throw new Error('Invalid printer name.')
      }
      const settings = await readSettings()
      const result = await backupPrinterDriver({
        printerName: payload.printerName,
        backupDir: payload.backupDir || settings.backupDir,
      })
      await refreshPrinterSnapshot({ broadcast: true })
      return result
    })
    upsertIpcHandler('printers:install', async (_, payload) => {
      if (!payload?.printerName || typeof payload.printerName !== 'string') {
        throw new Error('Invalid printer name.')
      }
      const settings = await readSettings()
      const result = await installPrinterFromBackup({
        printerName: payload.printerName,
        backupDir: settings.backupDir,
        targetPrinterName: payload.targetPrinterName || '',
        portHostAddressOverride: payload.portHostAddressOverride || '',
      })
      requestPrinterStateRefresh()
      await refreshPrinterSnapshot({ broadcast: true })
      return result
    })
    upsertIpcHandler('printers:ping-host', async (_, payload) => {
      const host = String(payload?.host || '').trim()
      if (!host) {
        throw new Error('Invalid host.')
      }
      return pingHost(host)
    })
    upsertIpcHandler('printers:uninstall', async (_, payload) => {
      if (!payload?.printerName || typeof payload.printerName !== 'string') {
        throw new Error('Invalid printer name.')
      }
      const result = await uninstallPrinter({
        printerName: payload.printerName,
      })
      requestPrinterStateRefresh()
      await refreshPrinterSnapshot({ broadcast: true })
      return result
    })
    upsertIpcHandler('printers:print-test-page', async (_, payload) => {
      if (!payload?.printerName || typeof payload.printerName !== 'string') {
        throw new Error('Invalid printer name.')
      }
      return printPrinterTestPage({
        printerName: payload.printerName,
      })
    })
    upsertIpcHandler('printers:backup-delete', async (_, payload) => {
      if (!payload?.printerName || typeof payload.printerName !== 'string') {
        throw new Error('Invalid printer name.')
      }
      const settings = await readSettings()
      const result = await deleteBackupDriver({
        printerName: payload.printerName,
        backupDir: settings.backupDir,
      })
      await refreshPrinterSnapshot({ broadcast: true })
      return result
    })

    upsertIpcHandler('drivers:index:get', async () => {
      if (!printerSnapshotState.updatedAt) {
        await refreshPrinterSnapshot({ broadcast: false })
      }
      return {
        backupDir: printerSnapshotState.backupDir,
        index: {
          version: 1,
          updatedAt: printerSnapshotState.updatedAt,
          entries: printerSnapshotState.driverIndexEntries,
        },
      }
    })

    const win = createMainWindow()
    updateManager = new UpdateManager(win)
    createTray()
    startPrinterStateWorker({
      backupDir: startupSettings.backupDir,
      virtualPrinterConfig: virtualPrinterConfigCache,
    })
    void refreshPrinterSnapshot({ broadcast: true }).catch((error) => {
      logWarn(`[printer-snapshot] bootstrap refresh failed: ${error?.message || error}`)
    })
    if (pendingProtocolRoutePath) {
      const pendingPath = pendingProtocolRoutePath
      pendingProtocolRoutePath = ''
      openMainWindowByRoutePath(pendingPath)
    }

    app.on('activate', () => {
      showMainWindow('/')
    })
  })

  app.on('before-quit', () => {
    appIsQuitting = true
    if (tray) {
      tray.destroy()
      tray = null
    }
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


