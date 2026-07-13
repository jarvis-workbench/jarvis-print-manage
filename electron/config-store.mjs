import { app } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

export const DEFAULT_PRINT_SERVICE_PORT = 17521
export const SYSTEM_SETTINGS_RELATIVE_PATH = path.join('config', 'system.json')
export const VIRTUAL_PRINTER_CONFIG_RELATIVE_PATH = path.join('config', 'virtual-printer.json')
export const THEME_MODES = new Set(['light', 'dark', 'system'])
export const DEFAULT_FEATURE_SETTINGS = {
  backup: {
    archiveEnabled: true,
  },
  lan: {
    discoveryEnabled: false,
    transferEnabled: false,
    autoInstallEnabled: false,
  },
}
export const DEFAULT_VIRTUAL_PRINTER_CONFIG = {
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

export function toBool(value, fallback = false) {
  if (value === true || value === false) return value
  if (typeof value === 'string') return value.toLowerCase() === 'true'
  if (value == null) return fallback
  return Boolean(value)
}

export function normalizeFeatureSettings(feature = {}) {
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

export function normalizePrintServicePort(value, fallback = DEFAULT_PRINT_SERVICE_PORT) {
  const port = Number(value)
  if (!Number.isFinite(port)) return fallback
  const normalized = Math.trunc(port)
  if (normalized < 1 || normalized > 65535) return fallback
  return normalized
}


export function getResourceRootPath() {
  return app.isPackaged ? process.resourcesPath : path.join(__dirname, 'resource')
}

export function getWritableConfigRootPath() {
  return app.isPackaged ? app.getPath('userData') : getResourceRootPath()
}

export function getSettingsFilePath() {
  return path.join(getWritableConfigRootPath(), SYSTEM_SETTINGS_RELATIVE_PATH)
}

export function getDefaultSettingsFilePath() {
  return path.join(getResourceRootPath(), SYSTEM_SETTINGS_RELATIVE_PATH)
}

export function getVirtualPrinterConfigPath() {
  return path.join(getWritableConfigRootPath(), VIRTUAL_PRINTER_CONFIG_RELATIVE_PATH)
}

export function getDefaultVirtualPrinterConfigPath() {
  return path.join(getResourceRootPath(), VIRTUAL_PRINTER_CONFIG_RELATIVE_PATH)
}


export function getDefaultBackupDir() {
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

export function stripWindowsLongPathPrefix(rawPath) {
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

export function sanitizeBackupDirPath(rawPath) {
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

export async function isDirectoryPath(targetPath) {
  const value = sanitizeBackupDirPath(targetPath)
  if (!value) return false
  try {
    const stat = await fs.stat(value)
    return stat.isDirectory()
  } catch {
    return false
  }
}

export function getOrderedNonSystemDriveLetters() {
  const letters = []
  for (let code = 68; code <= 90; code += 1) {
    letters.push(String.fromCharCode(code))
  }
  for (let code = 65; code <= 66; code += 1) {
    letters.push(String.fromCharCode(code))
  }
  return letters.filter((letter) => letter !== 'C')
}

export async function resolveForcedStartupBackupDir() {
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

export async function ensureStartupBackupDirSetting(settings = {}) {
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

export function resolveBackupDirPath(backupDir, fallbackBackupDir = '') {
  const primary = sanitizeBackupDirPath(backupDir)
  if (primary) return primary
  const fallback = sanitizeBackupDirPath(fallbackBackupDir)
  if (fallback) return fallback
  return getDefaultBackupDir()
}

export async function ensureWritableBackupDir(backupDir, fallbackBackupDir = '') {
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

export function normalizeVirtualPrinterConfig(raw = {}) {
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

export async function readVirtualPrinterConfig() {
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

export async function writeVirtualPrinterConfig(raw = {}) {
  const normalized = normalizeVirtualPrinterConfig(raw)
  const filePath = getVirtualPrinterConfigPath()
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  await fs.writeFile(filePath, JSON.stringify(normalized, null, 2), 'utf-8')
  return normalized
}


export function normalizeSettings(raw = {}) {
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

export function getFallbackSettings() {
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

export async function readJsonFileIfExists(filePath) {
  try {
    const fileText = await fs.readFile(filePath, 'utf-8')
    return JSON.parse(fileText)
  } catch {
    return null
  }
}

export async function readSettings() {
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

export async function writeSettings(nextSettings) {
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
