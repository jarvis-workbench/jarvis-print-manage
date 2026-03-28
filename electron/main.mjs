import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell } from 'electron'
import { createReadStream, existsSync } from 'node:fs'
import fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { loadPsScript } from './config/script/ps/index.mjs'
import { runPowerShell, runPowerShellJson } from './powershell.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)
const APP_TITLE = '虹色图文助手'
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
const CUSTOM_PROTOCOL_SCHEME = 'hstools'
const KNOWN_ROUTE_PATHS = new Set(['/', '/printers', '/settings', '/driver-install'])
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

function broadcastPrinterState() {
  const payload = {
    ...printerRuntimeState,
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win || win.isDestroyed()) continue
    win.webContents.send('printers:state-updated', payload)
  }
}

function requestPrinterStateRefresh() {
  if (!printerStateWorker) return
  try {
    printerStateWorker.postMessage({ type: 'refresh' })
  } catch {}
}

function stopPrinterStateWorker() {
  if (!printerStateWorker) return
  try {
    printerStateWorker.postMessage({ type: 'stop' })
  } catch {}
  try {
    printerStateWorker.terminate()
  } catch {}
  printerStateWorker = null
}

function startPrinterStateWorker() {
  if (printerStateWorker || appIsQuitting) return
  const workerPath = path.join(__dirname, 'worker', 'printer-state.mjs')
  printerStateWorker = new Worker(workerPath, {
    workerData: {
      pollIntervalMs: PRINTER_STATE_POLL_INTERVAL_MS,
    },
  })

  printerStateWorker.on('message', (message) => {
    const type = String(message?.type || '')
    if (type === 'snapshot') {
      printerRuntimeState = {
        ...printerRuntimeState,
        ...message.payload,
      }
      broadcastPrinterState()
      return
    }
    if (type === 'error') {
      const msg = message?.payload?.message || 'unknown error'
      console.warn(`[printer-state] ${msg}`)
    }
  })

  printerStateWorker.on('error', (error) => {
    console.warn(`[printer-state] crash: ${error?.message || error}`)
  })

  printerStateWorker.on('exit', (code) => {
    printerStateWorker = null
    if (!appIsQuitting && code !== 0) {
      setTimeout(() => {
        startPrinterStateWorker()
      }, 1200)
    }
  })
}

function getResourceRootPath() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, 'resource')
}

function getSettingsFilePath() {
  return path.join(getResourceRootPath(), SYSTEM_SETTINGS_RELATIVE_PATH)
}

function getVirtualPrinterConfigPath() {
  return path.join(getResourceRootPath(), VIRTUAL_PRINTER_CONFIG_RELATIVE_PATH)
}

function getIndexFilePath(backupDir) {
  return path.join(backupDir, INDEX_FILE_NAME)
}

function normalizeArchiveFields(entry = {}) {
  const archiveFileName = String(entry.archiveFileName || '').trim()
  const archiveRelativePath = String(entry.archiveRelativePath || archiveFileName).trim()
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
  return path.join(backupDir, archiveRel)
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

function getDefaultBackupDir() {
  return path.join(app.getPath('documents'), 'EleDrive', 'driver-backups')
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
    return normalizeVirtualPrinterConfig(DEFAULT_VIRTUAL_PRINTER_CONFIG)
  }
}

function isVirtualPrinter(printer, virtualConfig = DEFAULT_VIRTUAL_PRINTER_CONFIG) {
  const name = String(printer?.name || '').toLowerCase()
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
      })),
  }
}

async function writeIndexFile(backupDir, indexObj) {
  const normalized = normalizeIndex({
    ...indexObj,
    updatedAt: new Date().toISOString(),
  })
  await fs.mkdir(backupDir, { recursive: true })
  await fs.writeFile(getIndexFilePath(backupDir), JSON.stringify(normalized, null, 2), 'utf-8')
  return normalized
}

async function readIndexFileIfExists(backupDir) {
  try {
    const fileText = await fs.readFile(getIndexFilePath(backupDir), 'utf-8')
    return normalizeIndex(JSON.parse(fileText))
  } catch {
    return null
  }
}

async function scanBackupDirForIndex(backupDir) {
  let dirents = []
  try {
    dirents = await fs.readdir(backupDir, { withFileTypes: true })
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
    const backupPath = path.join(backupDir, backupSubDir)
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
  await fs.mkdir(backupDir, { recursive: true })
  const existing = await readIndexFileIfExists(backupDir)
  if (existing) return existing
  const rebuilt = await scanBackupDirForIndex(backupDir)
  return writeIndexFile(backupDir, rebuilt)
}

async function upsertIndexEntry(backupDir, nextEntry) {
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

async function readSettings() {
  try {
    const fileText = await fs.readFile(getSettingsFilePath(), 'utf-8')
    const parsed = JSON.parse(fileText)
    return {
      backupDir: parsed.backupDir || getDefaultBackupDir(),
      themeMode: THEME_MODES.has(parsed.themeMode) ? parsed.themeMode : 'system',
    }
  } catch {
    return {
      backupDir: getDefaultBackupDir(),
      themeMode: 'system',
    }
  }
}

async function writeSettings(nextSettings) {
  const current = await readSettings()
  const merged = {
    backupDir: nextSettings.backupDir || current.backupDir || getDefaultBackupDir(),
    themeMode: THEME_MODES.has(nextSettings.themeMode) ? nextSettings.themeMode : current.themeMode || 'system',
  }

  await fs.mkdir(path.dirname(getSettingsFilePath()), { recursive: true })
  await fs.writeFile(getSettingsFilePath(), JSON.stringify(merged, null, 2), 'utf-8')
  return merged
}

async function getInstalledPrinters() {
  const script = await loadPsScript('printer-list-installed')
  const data = await runPowerShellJson(script, { timeoutMs: POWERSHELL_TIMEOUT_MS })
  const virtualPrinterConfig = await readVirtualPrinterConfig()
  const list = Array.isArray(data) ? data : data ? [data] : []
  const filtered = list.filter((item) => !isVirtualPrinter(item, virtualPrinterConfig))
  const normalized = await Promise.all(
    filtered.map(async (item) => ({
      ...item,
      driver: item.driver ? await normalizeInstalledDriverVersion(item.driver) : item.driver,
    })),
  )
  return normalized
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
  const targetRoot = backupDir || getDefaultBackupDir()
  await fs.mkdir(targetRoot, { recursive: true })

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
      archivePath: path.join(targetRoot, metadata.archiveRelativePath || metadata.archiveFileName || ''),
    }
  } finally {
    if (String(backupPath || '').trim()) {
      await fs.rm(backupPath, { recursive: true, force: true })
    }
  }
}

async function installPrinterFromBackup({
  printerName,
  backupDir,
  targetPrinterName = '',
  portHostAddressOverride = '',
}) {
  const indexObj = await ensureBackupIndex(backupDir)
  const normalizedPrinterName = String(printerName || '').trim().toLowerCase()
  const entry = indexObj.entries.find((item) => item.printerName === printerName)
    || indexObj.entries.find((item) => item.printerName.toLowerCase() === normalizedPrinterName)
  if (!entry) {
    throw new Error(`No backup index entry found for printer: ${printerName}`)
  }
  const effectivePrinterName = String(targetPrinterName || '').trim() || entry.printerName
  const effectivePortHostAddress = String(portHostAddressOverride || '').trim() || String(entry.portHostAddress || '')

  const archivePath = resolveEntryArchivePath(backupDir, entry)
  if (!archivePath) {
    throw createArchiveError('ARCHIVE_NOT_FOUND', `备份索引缺少压缩包路径：${entry.printerName}`)
  }

  let backupPath = ''
  let extractDir = ''
  let installSucceeded = false

  const archiveExists = await isFileExists(archivePath)
  if (!archiveExists) {
    throw createArchiveError('ARCHIVE_NOT_FOUND', `驱动备份压缩包不存在：${archivePath}`)
  }
  const expectedHash = String(entry.archiveSha256 || '').trim().toLowerCase()
  if (expectedHash) {
    const actualHash = await computeFileSha256(archivePath)
    if (actualHash !== expectedHash) {
      throw createArchiveError('ARCHIVE_HASH_MISMATCH', `驱动备份压缩包哈希不匹配：${archivePath}`)
    }
  }
  try {
    const taskId = `install-${Date.now()}-${randomUUID().split('-')[0]}`
    const extracted = await extractBackupArchive(archivePath, taskId)
    extractDir = extracted.extractDir
    backupPath = extractDir
  } catch (error) {
    throw createArchiveError(
      'ARCHIVE_EXTRACT_FAILED',
      `驱动备份压缩包解压失败：${archivePath}。${error?.message || error}.`,
    )
  }

  let infPath = path.join(backupPath, entry.infRelativePath || '')
  let infRelativePath = entry.infRelativePath || ''
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

      // Backfill index entry when older records miss INF relative path.
      await upsertIndexEntry(backupDir, {
        ...entry,
        infRelativePath: fallbackInf,
      })
    } else {
      infPath = ''
    }
  }

  const script = await loadPsScript('printer-install-from-backup', {
    PRINTER_NAME: toPsSingleQuote(effectivePrinterName),
    EXPECTED_DRIVER_NAME: toPsSingleQuote(entry.driverName),
    PREFERRED_PORT: toPsSingleQuote(entry.portName || ''),
    PREFERRED_PORT_HOST: toPsSingleQuote(effectivePortHostAddress),
    INF_PATH: toPsSingleQuote(infPath),
    BACKUP_PATH: toPsSingleQuote(backupPath),
  })
  try {
    const result = await runPowerShellJson(script, { timeoutMs: 120_000 })
    installSucceeded = true
    return result
  } finally {
    if (extractDir && installSucceeded) {
      await safeCleanupExtractDir(extractDir)
    }
  }
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
    console.warn(`[protocol] register failed: ${error?.message || error}`)
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
    console.warn('[tray] tray icon not found, skip tray initialization.')
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
  ])

  tray.setContextMenu(contextMenu)
  tray.on('click', () => showMainWindow('/'))
  return tray
}

function createMainWindow() {
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
      preload: path.join(__dirname, 'preload.cjs'),
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
      console.error(`[renderer-load-failed] code=${code} desc=${desc} url=${url}`)
    })
  } else {
    win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
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

  app.whenReady().then(() => {
    registerCustomProtocolClient()

    ipcMain.handle('app:get-version', () => app.getVersion())

    ipcMain.handle('settings:get', async () => readSettings())
    ipcMain.handle('settings:set-backup-dir', async (_, backupDir) => {
      if (!backupDir || typeof backupDir !== 'string') {
        throw new Error('Invalid backup directory path.')
      }
      const saved = await writeSettings({ backupDir })
      await ensureBackupIndex(saved.backupDir)
      return saved
    })
    ipcMain.handle('settings:set-theme-mode', async (_, themeMode) => {
      if (!THEME_MODES.has(themeMode)) {
        throw new Error('Invalid theme mode.')
      }
      return writeSettings({ themeMode })
    })
    ipcMain.handle('settings:choose-backup-dir', async () => {
      const result = await dialog.showOpenDialog({
        title: '选择打印机驱动备份目录',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (result.canceled || !result.filePaths?.[0]) {
        return null
      }
      return result.filePaths[0]
    })
    ipcMain.handle('settings:open-backup-dir', async () => {
      const settings = await readSettings()
      const backupDir = String(settings?.backupDir || '').trim()
      if (!backupDir) {
        throw new Error('备份目录未配置')
      }
      await fs.mkdir(backupDir, { recursive: true })
      const openResult = await shell.openPath(backupDir)
      if (openResult) {
        throw new Error(openResult)
      }
      return {
        path: backupDir,
        opened: true,
      }
    })

    ipcMain.handle('printers:list-installed', async () => getInstalledPrinters())
    ipcMain.handle('printers:list-usb-ports', async () => listUsbPrinterPorts())
    ipcMain.handle('printers:state:get', async () => ({ ...printerRuntimeState }))
    ipcMain.handle('printers:open-system-add-wizard', async () => openSystemAddPrinterWizard())
    ipcMain.handle('printers:backup-driver', async (_, payload) => {
      if (!payload?.printerName || typeof payload.printerName !== 'string') {
        throw new Error('Invalid printer name.')
      }
      const settings = await readSettings()
      return backupPrinterDriver({
        printerName: payload.printerName,
        backupDir: payload.backupDir || settings.backupDir,
      })
    })
    ipcMain.handle('printers:install', async (_, payload) => {
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
      return result
    })
    ipcMain.handle('printers:ping-host', async (_, payload) => {
      const host = String(payload?.host || '').trim()
      if (!host) {
        throw new Error('Invalid host.')
      }
      return pingHost(host)
    })
    ipcMain.handle('printers:uninstall', async (_, payload) => {
      if (!payload?.printerName || typeof payload.printerName !== 'string') {
        throw new Error('Invalid printer name.')
      }
      const result = await uninstallPrinter({
        printerName: payload.printerName,
      })
      requestPrinterStateRefresh()
      return result
    })

    ipcMain.handle('drivers:index:get', async () => {
      const settings = await readSettings()
      const indexObj = await ensureBackupIndex(settings.backupDir)
      const normalizedIndex = await normalizeIndexDriverVersions(settings.backupDir, indexObj)
      return {
        backupDir: settings.backupDir,
        index: normalizedIndex,
      }
    })

    createMainWindow()
    createTray()
    startPrinterStateWorker()
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
    stopPrinterStateWorker()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}


