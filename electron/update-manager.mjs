import { app } from 'electron'
import { createRequire } from 'node:module'
import path from 'node:path'

const SUPPORTED_PLATFORMS = new Set(['darwin', 'win32'])
const localRequire = createRequire(import.meta.url)
let cachedAutoUpdater = null

export class UpdateManager {
  constructor(window) {
    this.window = window
    this.isChecking = false
    this.isDownloading = false
    this.autoUpdater = loadAutoUpdater()
    this.status = this.createInitialStatus()

    this.autoUpdater.autoDownload = false
    this.autoUpdater.autoInstallOnAppQuit = false
    this.bindUpdaterEvents()
  }

  getStatus() {
    return this.status
  }

  async checkForUpdates() {
    if (!this.canUseUpdater()) {
      this.setStatus({
        phase: 'unsupported',
        errorText: app.isPackaged ? '当前平台暂不支持自动更新' : '开发模式无法执行真实更新',
      })
      return this.status
    }

    if (this.isChecking || this.status.phase === 'downloading' || this.status.phase === 'installing') {
      return this.status
    }

    this.isChecking = true
    this.setStatus({
      phase: 'checking',
      errorText: undefined,
      progress: undefined,
    })

    try {
      await this.autoUpdater.checkForUpdates()
    } catch (error) {
      this.setStatus({
        phase: 'error',
        errorText: formatError(error),
      })
    } finally {
      this.isChecking = false
    }

    return this.status
  }

  async downloadUpdate() {
    if (!this.canUseUpdater()) {
      this.setStatus({
        phase: 'unsupported',
        errorText: app.isPackaged ? '当前平台暂不支持自动更新' : '开发模式无法执行真实更新',
      })
      return this.status
    }

    if (this.isDownloading || this.status.phase === 'downloading' || this.status.phase === 'downloaded') {
      return this.status
    }

    if (this.status.phase !== 'available') {
      throw new Error('暂无可下载的更新')
    }

    this.isDownloading = true
    this.setStatus({
      phase: 'downloading',
      errorText: undefined,
      progress: {
        percent: 0,
        transferred: 0,
        total: 0,
        bytesPerSecond: 0,
      },
    })

    try {
      await this.autoUpdater.downloadUpdate()
    } catch (error) {
      this.setStatus({
        phase: 'error',
        errorText: formatError(error),
      })
    } finally {
      this.isDownloading = false
    }

    return this.status
  }

  quitAndInstall() {
    if (this.status.phase !== 'downloaded') {
      throw new Error('更新尚未下载完成')
    }

    this.setStatus({ phase: 'installing', errorText: undefined })
    this.autoUpdater.quitAndInstall(false, true)
    return this.status
  }

  createInitialStatus() {
    const canUseUpdater = this.canUseUpdater()
    return {
      phase: canUseUpdater ? 'idle' : 'unsupported',
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      platform: process.platform,
      updatedAt: new Date().toISOString(),
      errorText: canUseUpdater
        ? undefined
        : app.isPackaged
          ? '当前平台暂不支持自动更新'
          : '开发模式无法执行真实更新',
    }
  }

  canUseUpdater() {
    return app.isPackaged && SUPPORTED_PLATFORMS.has(process.platform)
  }

  bindUpdaterEvents() {
    this.autoUpdater.on('update-available', (info) => {
      this.isChecking = false
      this.setStatus({
        ...infoToStatus(info),
        phase: 'available',
        errorText: undefined,
      })
    })

    this.autoUpdater.on('update-not-available', (info) => {
      this.isChecking = false
      this.setStatus({
        ...infoToStatus(info),
        phase: 'not-available',
        errorText: undefined,
        progress: undefined,
      })
    })

    this.autoUpdater.on('download-progress', (progress) => {
      this.setStatus({
        phase: 'downloading',
        progress: normalizeProgress(progress),
        errorText: undefined,
      })
    })

    this.autoUpdater.on('update-downloaded', (info) => {
      this.isDownloading = false
      this.setStatus({
        ...infoToStatus(info),
        phase: 'downloaded',
        progress: {
          percent: 100,
          transferred: 0,
          total: 0,
          bytesPerSecond: 0,
        },
        errorText: undefined,
      })
    })

    this.autoUpdater.on('error', (error) => {
      this.isChecking = false
      this.isDownloading = false
      this.setStatus({
        phase: 'error',
        errorText: formatError(error),
      })
    })
  }

  setStatus(patch) {
    this.status = {
      ...this.status,
      ...patch,
      currentVersion: app.getVersion(),
      isPackaged: app.isPackaged,
      platform: process.platform,
      updatedAt: new Date().toISOString(),
    }
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('updates:status-changed', this.status)
    }
  }
}

function infoToStatus(info) {
  if (!info) return {}
  return {
    availableVersion: info.version,
    releaseDate: info.releaseDate,
    releaseName: info.releaseName || undefined,
    releaseNotes: normalizeReleaseNotes(info.releaseNotes),
  }
}

function normalizeProgress(progress = {}) {
  const percent = Number(progress.percent)
  return {
    percent: Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0,
    transferred: Number(progress.transferred) || 0,
    total: Number(progress.total) || 0,
    bytesPerSecond: Number(progress.bytesPerSecond) || 0,
  }
}

function normalizeReleaseNotes(releaseNotes) {
  if (typeof releaseNotes === 'string') {
    return releaseNotes
  }

  if (Array.isArray(releaseNotes)) {
    return releaseNotes
      .map((note) => {
        if (typeof note === 'string') return note
        return [note?.version, note?.note].filter(Boolean).join('\n')
      })
      .filter(Boolean)
      .join('\n\n')
  }

  return undefined
}

function loadAutoUpdater() {
  if (cachedAutoUpdater) return cachedAutoUpdater

  try {
    cachedAutoUpdater = localRequire('electron-updater').autoUpdater
    return cachedAutoUpdater
  } catch (error) {
    if (!app.isPackaged) throw error
  }

  const appRequire = createRequire(path.join(app.getAppPath(), 'package.json'))
  cachedAutoUpdater = appRequire('electron-updater').autoUpdater
  return cachedAutoUpdater
}

function formatError(error) {
  if (error instanceof Error) return error.message
  return String(error || '未知错误')
}
