import { app, BrowserWindow, Menu, Tray, nativeImage, shell } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'

export class AppShell {
  constructor({
    appTitle,
    customProtocolScheme,
    dirname,
    isDev,
    isQuitting,
    knownRoutePaths,
    logError,
    logWarn,
    setQuitting,
    trayIconName,
  }) {
    this.appTitle = appTitle
    this.customProtocolScheme = customProtocolScheme
    this.dirname = dirname
    this.isDev = isDev
    this.isQuitting = typeof isQuitting === 'function' ? isQuitting : () => false
    this.knownRoutePaths = knownRoutePaths
    this.logError = typeof logError === 'function' ? logError : () => {}
    this.logWarn = typeof logWarn === 'function' ? logWarn : () => {}
    this.setQuitting = typeof setQuitting === 'function' ? setQuitting : () => {}
    this.trayIconName = trayIconName
    this.window = null
    this.tray = null
    this.pendingProtocolRoutePath = ''
  }

  get mainWindow() {
    return this.window
  }

  captureStartupProtocol(argv = []) {
    const startupProtocolUrl = this.findProtocolUrlFromArgv(argv)
    if (startupProtocolUrl) {
      this.pendingProtocolRoutePath = this.parseProtocolUrlToRoutePath(startupProtocolUrl) || this.pendingProtocolRoutePath
    }
  }

  handleSecondInstance(commandLine = []) {
    const protocolUrl = this.findProtocolUrlFromArgv(commandLine)
    if (protocolUrl && this.handleProtocolOpen(protocolUrl)) {
      return
    }
    if (app.isReady()) {
      this.show('/')
      return
    }
    app.whenReady().then(() => this.show('/'))
  }

  handleProtocolOpen(rawUrl = '') {
    const routePath = this.parseProtocolUrlToRoutePath(rawUrl)
    if (!routePath) return false
    if (app.isReady()) {
      this.openByRoutePath(routePath)
    } else {
      this.pendingProtocolRoutePath = routePath
    }
    return true
  }

  registerCustomProtocolClient() {
    try {
      if (process.defaultApp) {
        const entryScript = process.argv[1] ? path.resolve(process.argv[1]) : ''
        if (entryScript) {
          app.setAsDefaultProtocolClient(this.customProtocolScheme, process.execPath, [entryScript])
          return
        }
      }
      app.setAsDefaultProtocolClient(this.customProtocolScheme)
    } catch (error) {
      this.logWarn(`[protocol] register failed: ${error?.message || error}`)
    }
  }

  openPendingProtocolRoute() {
    if (!this.pendingProtocolRoutePath) return
    const pendingPath = this.pendingProtocolRoutePath
    this.pendingProtocolRoutePath = ''
    this.openByRoutePath(pendingPath)
  }

  markQuitting() {
    this.setQuitting(true)
  }

  destroyTray() {
    if (!this.tray) return
    this.tray.destroy()
    this.tray = null
  }

  openByRoutePath(routePath = '/') {
    const normalizedPath = this.normalizeRoutePath(routePath)
    if (this.window && !this.window.isDestroyed() && this.window.webContents.isLoadingMainFrame()) {
      if (this.window.isMinimized()) this.window.restore()
      this.navigate(normalizedPath)
      return
    }
    this.show(normalizedPath)
  }

  show(pathName = '') {
    if (!this.window || this.window.isDestroyed()) {
      this.createWindow()
    }
    if (!this.window || this.window.isDestroyed()) return

    if (this.window.isMinimized()) this.window.restore()
    if (!this.window.isVisible()) this.window.show()
    this.window.focus()

    if (pathName) {
      this.navigate(pathName)
    }
  }

  navigate(pathName = '/') {
    if (!this.window || this.window.isDestroyed()) return

    const payload = { path: pathName || '/' }
    const send = () => {
      if (!this.window || this.window.isDestroyed()) return
      this.window.webContents.send('app:navigate', payload)
    }

    if (this.window.webContents.isLoadingMainFrame()) {
      this.window.webContents.once('did-finish-load', send)
    } else {
      send()
    }
  }

  createTray() {
    if (this.tray) return this.tray

    const trayIcon = this.getTrayIcon()
    if (!trayIcon) {
      this.logWarn('[tray] tray icon not found, skip tray initialization.')
      return null
    }

    this.tray = new Tray(trayIcon)
    this.tray.setToolTip(this.appTitle)

    const contextMenu = Menu.buildFromTemplate([
      {
        label: '打开主界面',
        click: () => this.show('/'),
      },
      {
        label: '打印机管理',
        click: () => this.show('/printers'),
      },
      {
        label: '系统设置',
        click: () => this.show('/settings'),
      },
      {
        type: 'separator',
      },
      {
        label: '退出',
        click: () => {
          this.markQuitting()
          app.quit()
        },
      },
    ])

    this.tray.setContextMenu(contextMenu)
    this.tray.on('click', () => this.show('/'))
    return this.tray
  }

  createWindow() {
    const packagedAppRoot = app.getAppPath()
    const preloadPath = app.isPackaged
      ? path.join(packagedAppRoot, 'electron', 'preload.cjs')
      : path.join(this.dirname, 'preload.cjs')

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
      title: this.appTitle,
      autoHideMenuBar: true,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    })

    this.window = win

    win.on('close', (event) => {
      if (this.isQuitting()) return
      event.preventDefault()
      win.hide()
    })

    win.on('closed', () => {
      if (this.window === win) {
        this.window = null
      }
    })

    win.on('page-title-updated', (event) => {
      event.preventDefault()
      win.setTitle(this.appTitle)
    })

    if (this.isDev) {
      const devUrl = process.env.VITE_DEV_SERVER_URL
      win.loadURL(devUrl)
      win.webContents.openDevTools({ mode: 'detach' })
      win.webContents.on('did-fail-load', (_, code, desc, url) => {
        this.logError(`[renderer-load-failed] code=${code} desc=${desc} url=${url}`)
      })
    } else {
      win.loadFile(path.join(packagedAppRoot, 'dist', 'index.html'))
    }

    win.webContents.once('did-finish-load', () => {
      if (this.window !== win || win.isDestroyed() || this.isQuitting()) return
      if (!win.isVisible()) win.show()
      win.focus()
    })

    win.webContents.setWindowOpenHandler(({ url }) => {
      shell.openExternal(url)
      return { action: 'deny' }
    })

    return win
  }

  getTrayIcon() {
    const candidates = [
      path.join(this.dirname, this.trayIconName),
      path.join(app.getAppPath(), 'electron', this.trayIconName),
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

  getCustomProtocolPrefix() {
    return `${this.customProtocolScheme}://`
  }

  normalizeRoutePath(routePath = '') {
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
    if (!this.knownRoutePaths.has(text)) {
      text = '/'
    }
    return queryText ? `${text}?${queryText}` : text
  }

  parseProtocolUrlToRoutePath(rawUrl = '') {
    const value = String(rawUrl || '').trim()
    if (!value || !value.toLowerCase().startsWith(this.getCustomProtocolPrefix())) {
      return ''
    }

    let parsed = null
    try {
      parsed = new URL(value)
    } catch {
      return ''
    }
    if (String(parsed.protocol || '').toLowerCase() !== `${this.customProtocolScheme}:`) {
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
    const normalized = this.normalizeRoutePath(routePath)
    const hasQuery = normalized.includes('?')
    const queryText = passthrough.toString()
    if (!hasQuery && queryText) {
      return `${normalized}?${queryText}`
    }
    return normalized
  }

  findProtocolUrlFromArgv(argv = []) {
    const prefix = this.getCustomProtocolPrefix()
    const args = Array.isArray(argv) ? argv : []
    return args.find((arg) => typeof arg === 'string' && arg.toLowerCase().startsWith(prefix)) || ''
  }
}
