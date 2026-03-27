import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { execFile } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const execFileAsync = promisify(execFile)
const isDev = Boolean(process.env.VITE_DEV_SERVER_URL)
const APP_TITLE = '\u8679\u8272\u6253\u5370\u673a\u52a9\u624b'
const THEME_MODES = new Set(['light', 'dark', 'system'])

function getSettingsFilePath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function toPsSingleQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

async function runPowerShell(script) {
  const wrappedScript = `
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    ${script}
  `
  const { stdout, stderr } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', wrappedScript],
    {
      windowsHide: true,
      maxBuffer: 20 * 1024 * 1024,
    },
  )
  return {
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  }
}

async function runPowerShellJson(script) {
  const wrappedJsonScript = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $__codexResult = & {
      ${script}
    }
    if ($__codexResult -is [string]) {
      $__codexJson = $__codexResult
    } else {
      $__codexJson = $__codexResult | ConvertTo-Json -Depth 12 -Compress
    }
    [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($__codexJson))
  `

  const { stdout, stderr } = await runPowerShell(wrappedJsonScript)
  const base64Text = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || ''
  const jsonText = Buffer.from(base64Text, 'base64').toString('utf8').trim()

  if (!jsonText) {
    throw new Error(stderr || 'PowerShell returned empty output.')
  }

  try {
    return JSON.parse(jsonText)
  } catch {
    throw new Error(stderr || `Failed to parse PowerShell JSON output: ${jsonText}`)
  }
}

function getDefaultBackupDir() {
  return path.join(app.getPath('documents'), 'EleDrive', 'driver-backups')
}

function isVirtualPrinter(printer) {
  const name = String(printer?.name || '').toLowerCase()
  const driverName = String(printer?.driverName || '').toLowerCase()
  const portName = String(printer?.portName || '').toLowerCase()

  const keywordPatterns = [
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
  ]

  if (keywordPatterns.some((keyword) => name.includes(keyword) || driverName.includes(keyword))) {
    return true
  }

  if (portName === 'file:' || portName === 'portprompt:' || portName === 'nul:') {
    return true
  }

  if (portName.startsWith('redir') || portName.startsWith('ts') || portName.includes('prompt')) {
    return true
  }

  return false
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
  const settingsFilePath = getSettingsFilePath()
  await fs.mkdir(path.dirname(settingsFilePath), { recursive: true })
  await fs.writeFile(settingsFilePath, JSON.stringify(merged, null, 2), 'utf-8')
  return merged
}

async function getInstalledPrinters() {
  const script = `
    $ErrorActionPreference = 'Stop'
    $printers = Get-Printer | Select-Object Name, DriverName, PortName, Shared, ShareName
    $drivers = Get-PrinterDriver | Select-Object Name, Manufacturer, MajorVersion, DriverVersion, InfPath, PrinterEnvironment
    $result = foreach ($printer in $printers) {
      $driver = $drivers | Where-Object { $_.Name -eq $printer.DriverName } | Select-Object -First 1
      [PSCustomObject]@{
        name = $printer.Name
        driverName = $printer.DriverName
        portName = $printer.PortName
        shared = [bool]$printer.Shared
        shareName = $printer.ShareName
        driver = if ($driver) {
          [PSCustomObject]@{
            name = $driver.Name
            manufacturer = $driver.Manufacturer
            majorVersion = $driver.MajorVersion
            driverVersion = $driver.DriverVersion
            infPath = $driver.InfPath
            environment = $driver.PrinterEnvironment
          }
        } else {
          $null
        }
      }
    }
    $result | Sort-Object name | ConvertTo-Json -Depth 6 -Compress
  `

  const data = await runPowerShellJson(script)
  const list = Array.isArray(data) ? data : data ? [data] : []
  return list.filter((item) => !isVirtualPrinter(item))
}

async function backupPrinterDriver({ printerName, backupDir }) {
  const targetRoot = backupDir || getDefaultBackupDir()
  await fs.mkdir(targetRoot, { recursive: true })

  const script = `
    $ErrorActionPreference = 'Stop'
    $printerName = ${toPsSingleQuote(printerName)}
    $targetRoot = ${toPsSingleQuote(targetRoot)}

    $printer = Get-Printer -Name $printerName | Select-Object -First 1
    if (-not $printer) {
      throw "Printer not found: $printerName"
    }

    $driver = Get-PrinterDriver -Name $printer.DriverName | Select-Object -First 1
    if (-not $driver) {
      throw "Driver not found for printer: $printerName"
    }

    $safeName = $driver.Name -replace '[\\/:*?"<>|]', '_'
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $dest = Join-Path $targetRoot "$safeName-$timestamp"
    New-Item -ItemType Directory -Path $dest -Force | Out-Null

    $infName = [System.IO.Path]::GetFileName($driver.InfPath)
    $usedPnpUtil = $false
    if ($infName -and $infName -match '^oem\\d+\\.inf$') {
      $proc = Start-Process -FilePath 'pnputil.exe' -ArgumentList @('/export-driver', $infName, $dest) -NoNewWindow -Wait -PassThru
      if ($proc.ExitCode -eq 0) {
        $usedPnpUtil = $true
      }
    }

    if (-not $usedPnpUtil) {
      $files = @()
      $files += $driver.ConfigFile
      $files += $driver.DataFile
      $files += $driver.DriverPath
      $files += $driver.HelpFile
      foreach ($file in $driver.DependentFiles) {
        $files += $file
      }
      $files = $files | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

      if (-not $files -or $files.Count -eq 0) {
        throw "No exportable files found for driver: $($driver.Name)"
      }

      foreach ($filePath in $files) {
        $leaf = Split-Path -Path $filePath -Leaf
        Copy-Item -Path $filePath -Destination (Join-Path $dest $leaf) -Force
      }

      [PSCustomObject]@{
        printerName = $printer.Name
        driverName = $driver.Name
        infPath = $driver.InfPath
        backupDir = $dest
        method = 'copy-files'
      } | ConvertTo-Json -Compress
      return
    }

    [PSCustomObject]@{
      printerName = $printer.Name
      driverName = $driver.Name
      infPath = $driver.InfPath
      backupDir = $dest
      method = 'pnputil-export-driver'
    } | ConvertTo-Json -Compress
  `

  return runPowerShellJson(script)
}

function createMainWindow() {
  const win = new BrowserWindow({
    width: 1000,
    height: 650,
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
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
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

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

app.whenReady().then(() => {
  ipcMain.handle('app:get-version', () => app.getVersion())
  ipcMain.handle('settings:get', async () => readSettings())
  ipcMain.handle('settings:set-backup-dir', async (_, backupDir) => {
    if (!backupDir || typeof backupDir !== 'string') {
      throw new Error('Invalid backup directory path.')
    }
    return writeSettings({ backupDir })
  })
  ipcMain.handle('settings:set-theme-mode', async (_, themeMode) => {
    if (!THEME_MODES.has(themeMode)) {
      throw new Error('Invalid theme mode.')
    }
    return writeSettings({ themeMode })
  })
  ipcMain.handle('settings:choose-backup-dir', async () => {
    const result = await dialog.showOpenDialog({
      title: APP_TITLE,
      properties: ['openDirectory', 'createDirectory'],
    })
    if (result.canceled || !result.filePaths?.[0]) {
      return null
    }
    return result.filePaths[0]
  })
  ipcMain.handle('printers:list-installed', async () => getInstalledPrinters())
  ipcMain.handle('printers:backup-driver', async (_, payload) => {
    if (!payload?.printerName || typeof payload.printerName !== 'string') {
      throw new Error('Invalid printer name.')
    }
    const settings = await readSettings()
    return backupPrinterDriver({
      printerName: payload?.printerName,
      backupDir: payload?.backupDir || settings.backupDir,
    })
  })

  createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
