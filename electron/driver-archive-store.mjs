import { app } from 'electron'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { resolveBackupDirPath } from './config-store.mjs'
import { loadPsScript } from './config/script/ps/index.mjs'
import { runPowerShell } from './powershell.mjs'

export const INDEX_FILE_NAME = 'driver-index.json'
export const BACKUP_META_FILE_NAME = 'driver-backup.json'
export const ARCHIVE_FORMAT = 'pdrv.zip'
export const ARCHIVE_FILE_SUFFIX = '.pdrv.zip'
export const ARCHIVE_EXTRACT_POLICY_DEFAULT = 'cleanup-on-success'

export function toPsSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(Number(ms) || 0, 0)))
}

export class DriverArchiveStore {
  getIndexFilePath(backupDir) {
    return path.join(backupDir, INDEX_FILE_NAME)
  }

  normalizeArchiveFields(entry = {}) {
    const archiveFileName = String(entry.archiveFileName || '').trim()
    const rawArchiveRelativePath = String(entry.archiveRelativePath || archiveFileName).trim()
    const archiveRelativePath = this.normalizeArchiveRelativePath(rawArchiveRelativePath)
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

  normalizeArchiveRelativePath(value) {
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

  resolvePathInsideRoot(rootDir, relativePath) {
    const rawRoot = String(rootDir || '').trim()
    if (!rawRoot) return ''
    const root = path.resolve(rawRoot)
    const rel = this.normalizeArchiveRelativePath(relativePath)
    if (!root || !rel) return ''
    const target = path.resolve(root, rel)
    const relative = path.relative(root, target)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      return ''
    }
    return target
  }

  isTransientLanArchivePath(value) {
    const text = String(value || '').trim().replace(/\\/g, '/').toLowerCase()
    if (!text) return false
    if (text.startsWith('lan-remote/')) return true
    return text.includes('/lan-remote/')
  }

  createArchiveError(code, message) {
    const error = new Error(`[${code}] ${message}`)
    error.code = code
    return error
  }

  async isFileExists(filePath) {
    try {
      const stat = await fs.stat(filePath)
      return stat.isFile()
    } catch {
      return false
    }
  }

  async computeFileSha256(filePath) {
    const hash = createHash('sha256')
    return new Promise((resolve, reject) => {
      const stream = createReadStream(filePath)
      stream.on('data', (chunk) => hash.update(chunk))
      stream.on('error', reject)
      stream.on('end', () => resolve(hash.digest('hex')))
    })
  }

  async safeRemoveDirectory(dirPath, {
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

  normalizeArchiveFileName(name, fallback = `archive-${Date.now()}`) {
    const raw = this.sanitizeFileName(name || '', fallback)
    if (raw.toLowerCase().endsWith(ARCHIVE_FILE_SUFFIX)) {
      return raw
    }
    return `${raw}${ARCHIVE_FILE_SUFFIX}`
  }

  async resolveUniqueArchiveTargetPath(targetRoot, preferredFileName) {
    const normalized = this.normalizeArchiveFileName(preferredFileName, `archive-${Date.now()}`)
    const ext = path.extname(normalized)
    const baseName = normalized.slice(0, normalized.length - ext.length)
    let fileName = normalized
    let absPath = path.join(targetRoot, fileName)
    let suffix = 1
    while (await this.isFileExists(absPath)) {
      fileName = `${baseName}-${suffix}${ext}`
      absPath = path.join(targetRoot, fileName)
      suffix += 1
    }
    return {
      archiveFileName: fileName,
      archivePath: absPath,
    }
  }

  async createBackupArchive(backupPath, targetRoot) {
    const backupSubDir = path.basename(backupPath)
    let archiveFileName = `${backupSubDir}${ARCHIVE_FILE_SUFFIX}`
    let archivePath = path.join(targetRoot, archiveFileName)
    let suffix = 1
    while (await this.isFileExists(archivePath)) {
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
    const archiveSha256 = await this.computeFileSha256(archivePath)
    return {
      archiveFileName,
      archiveRelativePath: archiveFileName,
      archiveSha256,
      archiveSize: stat.size,
      archiveFormat: ARCHIVE_FORMAT,
    }
  }

  resolveEntryArchivePath(backupDir, entry = {}) {
    const archive = this.normalizeArchiveFields(entry)
    const archiveRel = archive.archiveRelativePath || archive.archiveFileName
    if (!archiveRel) return ''
    return this.resolvePathInsideRoot(backupDir, archiveRel)
  }

  async extractBackupArchive(archivePath, taskId) {
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

  async safeCleanupExtractDir(extractDir) {
    if (!extractDir) return
    try {
      await fs.rm(extractDir, { recursive: true, force: true })
    } catch {}
  }

  normalizeStringArray(value) {
    if (Array.isArray(value)) {
      return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
    }
    const text = String(value || '').trim()
    if (!text) return []
    return [...new Set(text.split(/[;,]/).map((item) => item.trim()).filter(Boolean))]
  }

  normalizeIdentityFields(entry = {}) {
    const hardwareIds = this.normalizeStringArray(entry.hardwareIds || entry.hardwareIdList || entry.hardwareId)
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

  buildIndexIdentityKey(entry = {}) {
    const normalized = this.normalizeIdentityFields(entry)
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

  normalizeIndex(raw) {
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
          ...this.normalizeIdentityFields(entry),
          ...this.normalizeArchiveFields(entry),
        }))
        .filter((entry) => !this.isTransientLanArchivePath(entry.archiveRelativePath || entry.archiveFileName)),
    }
  }

  async writeIndexFile(backupDir, indexObj) {
    const targetDir = resolveBackupDirPath(backupDir)
    const normalized = this.normalizeIndex({
      ...indexObj,
      updatedAt: new Date().toISOString(),
    })
    await fs.mkdir(targetDir, { recursive: true })
    await fs.writeFile(this.getIndexFilePath(targetDir), JSON.stringify(normalized, null, 2), 'utf-8')
    return normalized
  }

  async readIndexFileIfExists(backupDir) {
    const targetDir = resolveBackupDirPath(backupDir)
    try {
      const fileText = await fs.readFile(this.getIndexFilePath(targetDir), 'utf-8')
      return this.normalizeIndex(JSON.parse(fileText))
    } catch {
      return null
    }
  }

  async scanBackupDirForIndex(backupDir) {
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
          ...this.normalizeIdentityFields(meta),
          ...this.normalizeArchiveFields(meta),
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

  async ensureBackupIndex(backupDir) {
    const targetDir = resolveBackupDirPath(backupDir)
    await fs.mkdir(targetDir, { recursive: true })
    const existing = await this.readIndexFileIfExists(targetDir)
    if (existing) return existing
    const rebuilt = await this.scanBackupDirForIndex(targetDir)
    return this.writeIndexFile(targetDir, rebuilt)
  }

  async upsertIndexEntry(backupDir, nextEntry) {
    const archiveFields = this.normalizeArchiveFields(nextEntry)
    if (this.isTransientLanArchivePath(archiveFields.archiveRelativePath || archiveFields.archiveFileName)) {
      throw new Error('Transient LAN archive path cannot be persisted in backup index.')
    }
    const indexObj = await this.ensureBackupIndex(backupDir)
    const key = nextEntry.printerName.toLowerCase()
    const nextIdentityKey = this.buildIndexIdentityKey(nextEntry)
    const remaining = indexObj.entries.filter((entry) => {
      if (entry.printerName.toLowerCase() === key) return false
      if (!nextIdentityKey) return true
      const existingIdentityKey = this.buildIndexIdentityKey(entry)
      return !existingIdentityKey || existingIdentityKey !== nextIdentityKey
    })
    remaining.push(nextEntry)
    return this.writeIndexFile(backupDir, {
      ...indexObj,
      entries: remaining.sort((a, b) => a.printerName.localeCompare(b.printerName)),
    })
  }

  async findInfRelativePath(backupPath, preferredInfName = '') {
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

  isRawDriverVersionValue(value) {
    const text = String(value || '').trim()
    return /^\d{10,}$/.test(text)
  }

  extractDriverVerFromInfText(text) {
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

  async readDriverVerFromInfFile(infFilePath) {
    if (!infFilePath) return null
    try {
      const content = await fs.readFile(infFilePath, 'utf-8')
      return this.extractDriverVerFromInfText(content)
    } catch {
      return null
    }
  }

  async resolveSystemInfPath(infPathValue = '') {
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

  normalizeDriverVersionDisplay(fallbackValue, parsedInf) {
    const infVersion = String(parsedInf?.version || '').trim()
    if (infVersion) return infVersion
    const fallback = String(fallbackValue || '').trim()
    if (!fallback) return ''
    if (this.isRawDriverVersionValue(fallback)) return ''
    return fallback
  }

  async normalizeInstalledDriverVersion(driver) {
    if (!driver) return driver
    const infPath = await this.resolveSystemInfPath(driver.infPath)
    const parsedInf = await this.readDriverVerFromInfFile(infPath)
    return {
      ...driver,
      infPath: infPath || String(driver.infPath || ''),
      driverVersion: this.normalizeDriverVersionDisplay(driver.driverVersion, parsedInf),
    }
  }

  async resolveBackupInfPathFromIndexEntry(backupDir, entry) {
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

  async normalizeIndexDriverVersions(backupDir, indexObj) {
    if (!indexObj?.entries?.length) return indexObj
    let changed = false
    const nextEntries = await Promise.all(
      indexObj.entries.map(async (entry) => {
        const needsNormalize = !entry.driverVersion || this.isRawDriverVersionValue(entry.driverVersion)
        if (!needsNormalize) return entry
        const infPath = await this.resolveBackupInfPathFromIndexEntry(backupDir, entry)
        const parsedInf = await this.readDriverVerFromInfFile(infPath)
        const nextVersion = this.normalizeDriverVersionDisplay(entry.driverVersion, parsedInf)
        if (nextVersion === entry.driverVersion) return entry
        changed = true
        return {
          ...entry,
          driverVersion: nextVersion,
        }
      }),
    )

    if (!changed) return indexObj
    return this.writeIndexFile(backupDir, {
      ...indexObj,
      entries: nextEntries,
    })
  }

  sanitizeFileName(name, fallback = 'archive') {
    const raw = String(name || '').trim()
    const sanitized = raw
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
      .replace(/\s+/g, ' ')
      .trim()
    return sanitized || fallback
  }
}

export const driverArchiveStore = new DriverArchiveStore()

export const getIndexFilePath = (...args) => driverArchiveStore.getIndexFilePath(...args)
export const normalizeArchiveFields = (...args) => driverArchiveStore.normalizeArchiveFields(...args)
export const normalizeArchiveRelativePath = (...args) => driverArchiveStore.normalizeArchiveRelativePath(...args)
export const resolvePathInsideRoot = (...args) => driverArchiveStore.resolvePathInsideRoot(...args)
export const isTransientLanArchivePath = (...args) => driverArchiveStore.isTransientLanArchivePath(...args)
export const createArchiveError = (...args) => driverArchiveStore.createArchiveError(...args)
export const isFileExists = (...args) => driverArchiveStore.isFileExists(...args)
export const computeFileSha256 = (...args) => driverArchiveStore.computeFileSha256(...args)
export const safeRemoveDirectory = (...args) => driverArchiveStore.safeRemoveDirectory(...args)
export const normalizeArchiveFileName = (...args) => driverArchiveStore.normalizeArchiveFileName(...args)
export const resolveUniqueArchiveTargetPath = (...args) => driverArchiveStore.resolveUniqueArchiveTargetPath(...args)
export const createBackupArchive = (...args) => driverArchiveStore.createBackupArchive(...args)
export const resolveEntryArchivePath = (...args) => driverArchiveStore.resolveEntryArchivePath(...args)
export const extractBackupArchive = (...args) => driverArchiveStore.extractBackupArchive(...args)
export const safeCleanupExtractDir = (...args) => driverArchiveStore.safeCleanupExtractDir(...args)
export const normalizeStringArray = (...args) => driverArchiveStore.normalizeStringArray(...args)
export const normalizeIdentityFields = (...args) => driverArchiveStore.normalizeIdentityFields(...args)
export const buildIndexIdentityKey = (...args) => driverArchiveStore.buildIndexIdentityKey(...args)
export const normalizeIndex = (...args) => driverArchiveStore.normalizeIndex(...args)
export const writeIndexFile = (...args) => driverArchiveStore.writeIndexFile(...args)
export const readIndexFileIfExists = (...args) => driverArchiveStore.readIndexFileIfExists(...args)
export const scanBackupDirForIndex = (...args) => driverArchiveStore.scanBackupDirForIndex(...args)
export const ensureBackupIndex = (...args) => driverArchiveStore.ensureBackupIndex(...args)
export const upsertIndexEntry = (...args) => driverArchiveStore.upsertIndexEntry(...args)
export const findInfRelativePath = (...args) => driverArchiveStore.findInfRelativePath(...args)
export const isRawDriverVersionValue = (...args) => driverArchiveStore.isRawDriverVersionValue(...args)
export const extractDriverVerFromInfText = (...args) => driverArchiveStore.extractDriverVerFromInfText(...args)
export const readDriverVerFromInfFile = (...args) => driverArchiveStore.readDriverVerFromInfFile(...args)
export const resolveSystemInfPath = (...args) => driverArchiveStore.resolveSystemInfPath(...args)
export const normalizeDriverVersionDisplay = (...args) => driverArchiveStore.normalizeDriverVersionDisplay(...args)
export const normalizeInstalledDriverVersion = (...args) => driverArchiveStore.normalizeInstalledDriverVersion(...args)
export const resolveBackupInfPathFromIndexEntry = (...args) => driverArchiveStore.resolveBackupInfPathFromIndexEntry(...args)
export const normalizeIndexDriverVersions = (...args) => driverArchiveStore.normalizeIndexDriverVersions(...args)
export const sanitizeFileName = (...args) => driverArchiveStore.sanitizeFileName(...args)
