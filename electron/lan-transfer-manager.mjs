import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import {
  ARCHIVE_EXTRACT_POLICY_DEFAULT,
  ARCHIVE_FILE_SUFFIX,
  ARCHIVE_FORMAT,
  buildIndexIdentityKey,
  createArchiveError,
  ensureBackupIndex,
  isFileExists,
  normalizeArchiveFields,
  normalizeStringArray,
  resolvePathInsideRoot,
  resolveUniqueArchiveTargetPath,
  sanitizeFileName,
  upsertIndexEntry,
} from './driver-archive-store.mjs'

export class LanTransferManager {
  constructor({
    downloadTimeoutMs = 120_000,
    ensureWritableBackupDir,
    getVirtualPrinterConfig,
    installPrinterFromArchive,
    isVirtualPrinter,
    logWarn,
    readSettings,
    refreshPrinterSnapshot,
    requestPrinterStateRefresh,
    serviceArchivePathPrefix,
  } = {}) {
    this.downloadTimeoutMs = downloadTimeoutMs
    this.ensureWritableBackupDir = ensureWritableBackupDir
    this.getVirtualPrinterConfig = getVirtualPrinterConfig
    this.installPrinterFromArchive = installPrinterFromArchive
    this.isVirtualPrinter = isVirtualPrinter
    this.logWarn = typeof logWarn === 'function' ? logWarn : () => {}
    this.readSettings = readSettings
    this.refreshPrinterSnapshot = refreshPrinterSnapshot
    this.requestPrinterStateRefresh = requestPrinterStateRefresh
    this.serviceArchivePathPrefix = serviceArchivePathPrefix
  }

  sanitizeArchiveRelativePath(rawRelativePath, fallbackOfferId = '') {
    const raw = String(rawRelativePath || '').trim().replace(/\\/g, '/')
    const fallbackName = sanitizeFileName(fallbackOfferId || `offer-${Date.now()}`, 'offer')
    const base = sanitizeFileName(path.posix.basename(raw || `${fallbackName}${ARCHIVE_FILE_SUFFIX}`), fallbackName)
    const withExt = base.toLowerCase().endsWith(ARCHIVE_FILE_SUFFIX)
      ? base
      : `${base}${ARCHIVE_FILE_SUFFIX}`
    return path.posix.join('lan-remote', withExt)
  }

  buildOfferId(entry = {}) {
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

  toOfferRecord({ entry = {}, backupDir = '', nodeId = '' } = {}) {
    const archive = normalizeArchiveFields(entry)
    const archiveRelativePath = String(archive.archiveRelativePath || archive.archiveFileName || '').trim()
    if (!archiveRelativePath) return null
    const archiveFileName = String(archive.archiveFileName || path.basename(archiveRelativePath)).trim()
    const archivePath = resolvePathInsideRoot(backupDir, archiveRelativePath)
    if (!archivePath) return null
    const identityKey = buildIndexIdentityKey(entry)
      || `${String(entry.driverName || '').trim().toLowerCase()}::${String(entry.printerName || '').trim().toLowerCase()}`
    return {
      offerId: this.buildOfferId(entry),
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

  async listTransferOffers({ nodeId = '' } = {}) {
    const settings = await this.readSettings()
    const backupDir = await this.ensureWritableBackupDir(settings?.backupDir)
    const indexObj = await ensureBackupIndex(backupDir)
    const virtualConfig = this.getVirtualPrinterConfig()
    const offers = []
    for (const entry of indexObj.entries || []) {
      if (this.isVirtualPrinter(entry, virtualConfig)) continue
      const offer = this.toOfferRecord({ entry, backupDir, nodeId })
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

  async resolveOfferArchive({ offerId = '', nodeId = '' } = {}) {
    const normalizedOfferId = String(offerId || '').trim()
    if (!normalizedOfferId) return null
    const offers = await this.listTransferOffers({ nodeId })
    const matched = offers.find((item) => String(item.offerId || '') === normalizedOfferId)
    if (!matched) return null
    const settings = await this.readSettings()
    const backupDir = await this.ensureWritableBackupDir(settings?.backupDir)
    const archivePath = resolvePathInsideRoot(backupDir, String(matched.archiveRelativePath || ''))
    if (!archivePath) return null
    const archiveExists = await isFileExists(archivePath)
    if (!archiveExists) return null
    return {
      offer: matched,
      archivePath,
    }
  }

  async downloadArchiveToPath({ archiveUrl, targetPath, timeoutMs = this.downloadTimeoutMs, onProgress } = {}) {
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

  async installOfferFromRemote({
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

    const settings = await this.readSettings()
    const backupDir = await this.ensureWritableBackupDir(settings?.backupDir)
    const tempArchiveRoot = path.join(backupDir, 'lan-remote')
    await fs.mkdir(tempArchiveRoot, { recursive: true })
    const tempArchiveTarget = await resolveUniqueArchiveTargetPath(
      tempArchiveRoot,
      path.basename(String(offer.archiveFileName || `${offerId}${ARCHIVE_FILE_SUFFIX}`)),
    )
    const tempArchivePath = tempArchiveTarget.archivePath
    const archiveUrl = `http://${host}:${servicePort}${this.serviceArchivePathPrefix}${encodeURIComponent(offerId)}`

    if (typeof onProgress === 'function') {
      onProgress(8)
    }

    const downloadResult = await this.downloadArchiveToPath({
      archiveUrl,
      targetPath: tempArchivePath,
      timeoutMs: this.downloadTimeoutMs,
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
      this.logWarn(`[lan-install] archive size mismatch, continue with downloaded file. expected=${expectedSize}, actual=${actualSize}`)
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
      const installResult = await this.installPrinterFromArchive({
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

      this.requestPrinterStateRefresh()
      await this.refreshPrinterSnapshot({ broadcast: true })

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
      this.logWarn(`[lan-install] failed. offerId=${offerId}, archive=${tempArchivePath}, message=${error?.message || error}`)
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
}
