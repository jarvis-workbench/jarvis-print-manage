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
const APP_TITLE = '虹色图文助手'
const THEME_MODES = new Set(['light', 'dark', 'system'])
const INDEX_FILE_NAME = 'driver-index.json'
const BACKUP_META_FILE_NAME = 'driver-backup.json'

function getSettingsFilePath() {
  return path.join(app.getPath('userData'), 'settings.json')
}

function getIndexFilePath(backupDir) {
  return path.join(backupDir, INDEX_FILE_NAME)
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
    if ($null -eq $__codexResult) {
      $__codexJson = 'null'
    } elseif ($__codexResult -is [string]) {
      $__codexJson = $__codexResult
    } else {
      $__codexJson = $__codexResult | ConvertTo-Json -Depth 12 -Compress
    }
    if ($null -eq $__codexJson -or $__codexJson -eq '') {
      $__codexJson = 'null'
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

async function openSystemAddPrinterWizard() {
  const script = `
    $ErrorActionPreference = 'Stop'
    $attempts = @(
      @{ file = 'rundll32.exe'; args = 'printui.dll,PrintUIEntry /im' },
      @{ file = 'rundll32.exe'; args = 'printui.dll,PrintUIEntry /il' },
      @{ file = 'rundll32.exe'; args = 'shell32.dll,SHHelpShortcuts_RunDLL AddPrinter' }
    )
    $lastError = ''
    foreach ($attempt in $attempts) {
      try {
        Start-Process -FilePath $attempt.file -ArgumentList $attempt.args -WindowStyle Normal -ErrorAction Stop | Out-Null
        [PSCustomObject]@{ status = 'opened' } | ConvertTo-Json -Compress
        return
      } catch {
        $lastError = $_.Exception.Message
      }
    }
    throw "Failed to open Add Printer wizard: $lastError"
  `
  return runPowerShellJson(script)
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
        backupSubDir: String(entry.backupSubDir || ''),
        backupAt: String(entry.backupAt || ''),
        portName: String(entry.portName || ''),
        portHostAddress: String(entry.portHostAddress || ''),
        portNumber: String(entry.portNumber || ''),
        environment: String(entry.environment || ''),
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
        backupSubDir,
        backupAt: String(meta.backupAt || ''),
        portName: String(meta.portName || ''),
        portHostAddress: String(meta.portHostAddress || ''),
        portNumber: String(meta.portNumber || ''),
        environment: String(meta.environment || ''),
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
  const remaining = indexObj.entries.filter((entry) => entry.printerName.toLowerCase() !== key)
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

async function normalizeIndexDriverVersions(backupDir, indexObj) {
  if (!indexObj?.entries?.length) return indexObj
  let changed = false
  const nextEntries = await Promise.all(
    indexObj.entries.map(async (entry) => {
      const needsNormalize = !entry.driverVersion || isRawDriverVersionValue(entry.driverVersion)
      if (!needsNormalize) return entry
      const infPath = entry.infRelativePath
        ? path.join(backupDir, entry.backupSubDir || '', entry.infRelativePath)
        : ''
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
  const script = `
    $ErrorActionPreference = 'Stop'
    $spooler = Get-Service -Name spooler -ErrorAction SilentlyContinue
    if ($spooler -and $spooler.Status -ne 'Running') {
      try {
        Start-Service -Name spooler -ErrorAction Stop
        Start-Sleep -Milliseconds 700
      } catch {}
    }
    $spooler = Get-Service -Name spooler -ErrorAction SilentlyContinue
    if (-not $spooler -or $spooler.Status -ne 'Running') {
      @() | ConvertTo-Json -Compress
      return
    }

    $printers = @(Get-Printer -ErrorAction SilentlyContinue | Select-Object Name, DriverName, PortName, Shared, ShareName, PrinterStatus, WorkOffline)
    $drivers = @(Get-PrinterDriver -ErrorAction SilentlyContinue | Select-Object Name, Manufacturer, MajorVersion, DriverVersion, InfPath, PrinterEnvironment)
    $result = foreach ($printer in $printers) {
      $driver = $drivers | Where-Object { $_.Name -eq $printer.DriverName } | Select-Object -First 1
      [PSCustomObject]@{
        name = $printer.Name
        driverName = $printer.DriverName
        portName = $printer.PortName
        shared = [bool]$printer.Shared
        shareName = $printer.ShareName
        printerStatus = $printer.PrinterStatus
        workOffline = [bool]$printer.WorkOffline
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
  const filtered = list.filter((item) => !isVirtualPrinter(item))
  const normalized = await Promise.all(
    filtered.map(async (item) => ({
      ...item,
      driver: item.driver ? await normalizeInstalledDriverVersion(item.driver) : item.driver,
    })),
  )
  return normalized
}

async function listUsbPrinterPorts() {
  const script = `
    $ErrorActionPreference = 'Stop'
    $spooler = Get-Service -Name spooler -ErrorAction SilentlyContinue
    if ($spooler -and $spooler.Status -ne 'Running') {
      try {
        Start-Service -Name spooler -ErrorAction Stop
        Start-Sleep -Milliseconds 700
      } catch {}
    }
    $spooler = Get-Service -Name spooler -ErrorAction SilentlyContinue
    if (-not $spooler -or $spooler.Status -ne 'Running') {
      @() | ConvertTo-Json -Compress
      return
    }

    $ports = @(
      Get-PrinterPort -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -match '(?i)^USB[0-9]+$' } |
        Select-Object -ExpandProperty Name -Unique |
        Sort-Object
    )
    $ports | ConvertTo-Json -Compress
  `

  const data = await runPowerShellJson(script)
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
    $port = Get-PrinterPort -Name $printer.PortName -ErrorAction SilentlyContinue | Select-Object -First 1

    $safeName = $driver.Name -replace '[\\/:*?"<>|]', '_'
    $timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $dest = Join-Path $targetRoot "$safeName-$timestamp"
    New-Item -ItemType Directory -Path $dest -Force | Out-Null

    function Get-InfReferencedFiles {
      param([string]$InfPath)
      $names = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
      if (-not $InfPath -or -not (Test-Path $InfPath)) {
        return @()
      }

      $inSourceDisksFiles = $false
      foreach ($rawLine in (Get-Content -LiteralPath $InfPath -ErrorAction SilentlyContinue)) {
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith(';')) { continue }

        if ($line -match '^\\[(.+)\\]$') {
          $sectionName = $matches[1].Trim()
          $inSourceDisksFiles = $sectionName -match '(?i)^SourceDisksFiles(\\.|$)'
          continue
        }

        if ($line -match '(?i)^CatalogFile(?:\\.[^=]+)?\\s*=\\s*([^,;]+)') {
          $null = $names.Add($matches[1].Trim().Trim('"'))
        }
        if ($line -match '(?i)^DriverFile\\s*=\\s*([^,;]+)') {
          $null = $names.Add($matches[1].Trim().Trim('"'))
        }
        if ($line -match '(?i)^ConfigFile\\s*=\\s*([^,;]+)') {
          $null = $names.Add($matches[1].Trim().Trim('"'))
        }
        if ($line -match '(?i)^DataFile\\s*=\\s*([^,;]+)') {
          $null = $names.Add($matches[1].Trim().Trim('"'))
        }
        if ($line -match '(?i)^HelpFile\\s*=\\s*([^,;]+)') {
          $null = $names.Add($matches[1].Trim().Trim('"'))
        }
        if ($line -match '(?i)^PrintProcessor\\s*=\\s*"?[^",;]+[, ]+([^",;]+)') {
          $null = $names.Add($matches[1].Trim().Trim('"'))
        }
        if ($line -match '(?i)^LanguageMonitor\\s*=\\s*"?[^",;]+[, ]+([^",;]+)') {
          $null = $names.Add($matches[1].Trim().Trim('"'))
        }

        if ($inSourceDisksFiles -and $line -match '^([^=,;\\s]+)\\s*=') {
          $null = $names.Add($matches[1].Trim().Trim('"'))
        }
      }

      return @($names)
    }

    function Find-FileInRoots {
      param(
        [string]$FileName,
        [string[]]$Roots
      )

      foreach ($root in $Roots) {
        if (-not $root -or -not (Test-Path $root)) { continue }
        $direct = Join-Path $root $FileName
        if (Test-Path $direct) {
          return (Resolve-Path $direct).Path
        }
      }

      foreach ($root in $Roots) {
        if (-not $root -or -not (Test-Path $root)) { continue }
        try {
          $found = Get-ChildItem -Path $root -Filter $FileName -File -Recurse -ErrorAction SilentlyContinue | Select-Object -First 1
          if ($found) {
            return $found.FullName
          }
        } catch {}
      }

      return ''
    }

    function Find-InfMappedSourceFileName {
      param(
        [string]$InfPath,
        [string]$TargetFileName
      )

      if (-not $InfPath -or -not $TargetFileName -or -not (Test-Path $InfPath)) {
        return ''
      }
      $escaped = [regex]::Escape($TargetFileName)
      $pattern = '(?i)^\\s*' + $escaped + '\\s*,\\s*([^"]+?)\\s*$'

      foreach ($rawLine in (Get-Content -LiteralPath $InfPath -ErrorAction SilentlyContinue)) {
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith(';')) { continue }
        if ($line -match $pattern) {
          $candidate = $matches[1].Trim().Trim('"')
          if ($candidate -and $candidate -match '^[^\\/:*?"<>|]+\\.[A-Za-z0-9_]{1,5}$') {
            return $candidate
          }
        }
      }
      return ''
    }

    function Ensure-InfSourceLayout {
      param([string]$InfPath)
      if (-not $InfPath -or -not (Test-Path $InfPath)) {
        return
      }

      $infDir = Split-Path -Path $InfPath -Parent
      $diskMap = @{}
      $fileMap = @()
      $currentSection = ''

      foreach ($rawLine in (Get-Content -LiteralPath $InfPath -ErrorAction SilentlyContinue)) {
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith(';')) { continue }

        if ($line -match '^\\[(.+)\\]$') {
          $currentSection = $matches[1].Trim().ToLower()
          continue
        }

        if ($currentSection -eq 'sourcedisksnames' -or $currentSection -eq 'sourcedisksnames.amd64') {
          if ($line -match '^\\s*(\\d+)\\s*=\\s*[^,]*,[^,]*,[^,]*,\\s*"?(.*?)"?\\s*$') {
            $diskId = $matches[1]
            $diskPath = $matches[2].Trim()
            $diskMap[$diskId] = $diskPath
          }
          continue
        }

        if ($currentSection -match '^sourcedisksfiles(\\.|$)') {
          if ($line -match '^\\s*([^=,;\\s]+)\\s*=\\s*(\\d+)') {
            $fileName = $matches[1].Trim()
            $diskId = $matches[2].Trim()
            $fileMap += [PSCustomObject]@{
              fileName = $fileName
              diskId = $diskId
            }
          }
        }
      }

      foreach ($item in $fileMap) {
        $fileName = $item.fileName
        $diskId = $item.diskId
        $subPath = ''
        if ($diskMap.ContainsKey($diskId)) {
          $subPath = [string]$diskMap[$diskId]
        }
        if (-not $subPath) { continue }

        $sourceRootPath = Join-Path $infDir $fileName
        $targetPath = Join-Path $infDir (Join-Path $subPath $fileName)
        if ((-not (Test-Path $targetPath)) -and (Test-Path $sourceRootPath)) {
          $targetDir = Split-Path -Path $targetPath -Parent
          if ($targetDir -and -not (Test-Path $targetDir)) {
            New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
          }
          try {
            Copy-Item -LiteralPath $sourceRootPath -Destination $targetPath -Force
          } catch {}
        }
      }
    }

    $infName = [System.IO.Path]::GetFileName($driver.InfPath)
    $publishedInfName = ''
    $enumText = (& pnputil.exe /enum-drivers 2>&1 | Out-String)
    $blocks = $enumText -split '(?ms)\\r?\\n\\s*\\r?\\n'
    foreach ($block in $blocks) {
      $lower = $block.ToLower()
      $matched = $false
      if ($driver.Name -and $lower.Contains($driver.Name.ToLower())) {
        $matched = $true
      }
      if (-not $matched -and $infName -and $lower.Contains($infName.ToLower())) {
        $matched = $true
      }
      if ($matched -and $block -match '(?im)Published Name\\s*:\\s*(oem\\d+\\.inf)') {
        $publishedInfName = $matches[1]
        break
      }
    }
    if (-not $publishedInfName -and $infName -and $infName -match '^oem\\d+\\.inf$') {
      $publishedInfName = $infName
    }

    $usedPnpUtil = $false
    if ($publishedInfName) {
      $proc = Start-Process -FilePath 'pnputil.exe' -ArgumentList @('/export-driver', $publishedInfName, $dest) -NoNewWindow -Wait -PassThru
      if ($proc.ExitCode -eq 0) {
        $usedPnpUtil = $true
      }
    }

    $effectiveInfPath = $driver.InfPath
    if (-not $usedPnpUtil) {
      $candidateInfPaths = @()
      if ($driver.InfPath -and (Test-Path $driver.InfPath)) {
        $candidateInfPaths += (Resolve-Path $driver.InfPath).Path
      }
      if ($infName) {
        $winInfPath = Join-Path $env:windir (Join-Path 'INF' $infName)
        if (Test-Path $winInfPath) {
          $candidateInfPaths += (Resolve-Path $winInfPath).Path
        }
      }
      if ($publishedInfName) {
        $publishedInfPath = Join-Path $env:windir (Join-Path 'INF' $publishedInfName)
        if (Test-Path $publishedInfPath) {
          $candidateInfPaths += (Resolve-Path $publishedInfPath).Path
        }
      }
      $candidateInfPaths = $candidateInfPaths | Select-Object -Unique
      if (-not $candidateInfPaths -or $candidateInfPaths.Count -eq 0) {
        throw "INF file not found for driver: $($driver.Name)"
      }

      $resolvedInfPath = $candidateInfPaths | Select-Object -First 1
      $effectiveInfPath = $resolvedInfPath
      $infDir = Split-Path -Path $resolvedInfPath -Parent
      $infBaseName = [System.IO.Path]::GetFileName($resolvedInfPath)

      Copy-Item -LiteralPath $resolvedInfPath -Destination (Join-Path $dest $infBaseName) -Force

      $searchRoots = @($infDir)
      $metaFiles = @($driver.ConfigFile, $driver.DataFile, $driver.DriverPath, $driver.HelpFile)
      foreach ($metaFile in $metaFiles) {
        if ($metaFile -and (Test-Path $metaFile)) {
          $searchRoots += (Split-Path -Path $metaFile -Parent)
        }
      }
      foreach ($depFile in $driver.DependentFiles) {
        if ($depFile -and (Test-Path $depFile)) {
          $searchRoots += (Split-Path -Path $depFile -Parent)
        }
      }

      $driverStoreRoot = Join-Path $env:windir 'System32\\DriverStore\\FileRepository'
      if (Test-Path $driverStoreRoot) {
        $pkgDirs = Get-ChildItem -Path $driverStoreRoot -Directory -ErrorAction SilentlyContinue | Where-Object {
          Test-Path (Join-Path $_.FullName $infBaseName)
        } | Select-Object -ExpandProperty FullName
        $searchRoots += $pkgDirs
      }

      $searchRoots += (Join-Path $env:windir 'INF')
      $searchRoots += (Join-Path $env:windir 'System32\\spool\\drivers\\x64\\3')
      $searchRoots += (Join-Path $env:windir 'System32\\spool\\drivers\\x64\\PCC')
      $searchRoots += (Join-Path $env:windir 'System32\\spool\\drivers\\x64')
      $searchRoots = $searchRoots | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique

      $requiredFileNames = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
      $requiredFromInf = Get-InfReferencedFiles -InfPath $resolvedInfPath
      foreach ($f in $requiredFromInf) {
        if ($f) { $null = $requiredFileNames.Add($f) }
      }
      foreach ($f in $metaFiles) {
        if ($f) { $null = $requiredFileNames.Add([System.IO.Path]::GetFileName($f)) }
      }
      foreach ($f in $driver.DependentFiles) {
        if ($f) { $null = $requiredFileNames.Add([System.IO.Path]::GetFileName($f)) }
      }

      $copiedNames = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
      $missingFiles = @()
      foreach ($fileName in $requiredFileNames) {
        if (-not $fileName) { continue }
        $foundPath = Find-FileInRoots -FileName $fileName -Roots $searchRoots
        if (-not $foundPath) {
          $mappedSourceName = Find-InfMappedSourceFileName -InfPath $resolvedInfPath -TargetFileName $fileName
          if ($mappedSourceName) {
            $mappedSourcePath = Find-FileInRoots -FileName $mappedSourceName -Roots $searchRoots
            if ($mappedSourcePath) {
              Copy-Item -LiteralPath $mappedSourcePath -Destination (Join-Path $dest $fileName) -Force
              $null = $copiedNames.Add($fileName)
              continue
            }
          }
          $missingFiles += $fileName
          continue
        }
        if ($copiedNames.Contains($fileName)) { continue }
        Copy-Item -LiteralPath $foundPath -Destination (Join-Path $dest $fileName) -Force
        $null = $copiedNames.Add($fileName)
      }

      if ($copiedNames.Count -eq 0) {
        throw "Failed to build driver backup package. No additional driver files were found."
      }

      Ensure-InfSourceLayout -InfPath (Join-Path $dest $infBaseName)
      $missingFiles = $missingFiles | Select-Object -Unique
    } else {
      $missingFiles = @()
    }

    [PSCustomObject]@{
      printerName = $printer.Name
      driverName = $driver.Name
      driverVersion = $driver.DriverVersion
      manufacturer = $driver.Manufacturer
      environment = $driver.PrinterEnvironment
      portName = $printer.PortName
      portHostAddress = if ($port) { $port.PrinterHostAddress } else { '' }
      portNumber = if ($port) { $port.PortNumber } else { '' }
      infPath = $effectiveInfPath
      backupDir = $dest
      method = if ($usedPnpUtil) { 'pnputil-export-driver' } else { 'copy-required-files' }
      missingFiles = $missingFiles
    } | ConvertTo-Json -Compress
  `

  const result = await runPowerShellJson(script)
  const backupPath = result.backupDir
  const infRelativePath = await findInfRelativePath(backupPath, path.basename(result.infPath || ''))

  const metadata = {
    printerName: result.printerName,
    driverName: result.driverName,
    driverVersion: '',
    manufacturer: String(result.manufacturer || ''),
    environment: String(result.environment || ''),
    portName: String(result.portName || ''),
    portHostAddress: String(result.portHostAddress || ''),
    portNumber: String(result.portNumber || ''),
    infRelativePath,
    backupAt: new Date().toISOString(),
    method: result.method,
  }

  const backupInfPath = metadata.infRelativePath ? path.join(backupPath, metadata.infRelativePath) : ''
  const parsedBackupInf = await readDriverVerFromInfFile(backupInfPath)
  metadata.driverVersion = normalizeDriverVersionDisplay(result.driverVersion, parsedBackupInf)

  await fs.writeFile(path.join(backupPath, BACKUP_META_FILE_NAME), JSON.stringify(metadata, null, 2), 'utf-8')

  await upsertIndexEntry(targetRoot, {
    printerName: metadata.printerName,
    driverName: metadata.driverName,
    driverVersion: metadata.driverVersion,
    manufacturer: metadata.manufacturer,
    infRelativePath: metadata.infRelativePath,
    backupSubDir: path.basename(backupPath),
    backupAt: metadata.backupAt,
    portName: metadata.portName,
    portHostAddress: metadata.portHostAddress,
    portNumber: metadata.portNumber,
    environment: metadata.environment,
  })

  return {
    ...result,
    ...metadata,
  }
}

async function installPrinterFromBackup({ printerName, backupDir }) {
  const indexObj = await ensureBackupIndex(backupDir)
  const entry = indexObj.entries.find((item) => item.printerName === printerName)
  if (!entry) {
    throw new Error(`No backup index entry found for printer: ${printerName}`)
  }

  const backupPath = path.join(backupDir, entry.backupSubDir || '')
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
    const fallbackInf = await findInfRelativePath(backupPath, path.basename(infRelativePath || ''))
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

  const script = `
    $ErrorActionPreference = 'Stop'
    $printerName = ${toPsSingleQuote(entry.printerName)}
    $expectedDriverName = ${toPsSingleQuote(entry.driverName)}
    $preferredPort = ${toPsSingleQuote(entry.portName || '')}
    $preferredPortHost = ${toPsSingleQuote(entry.portHostAddress || '')}
    $infPath = ${toPsSingleQuote(infPath)}
    $backupPath = ${toPsSingleQuote(backupPath)}
    $infFileName = [System.IO.Path]::GetFileName($infPath)
    $beforeDrivers = @(Get-PrinterDriver | Select-Object -ExpandProperty Name)

    function Ensure-InfMappedAliases {
      param([string]$InfPath)
      if (-not $InfPath -or -not (Test-Path $InfPath)) {
        return
      }
      $infDir = Split-Path -Path $InfPath -Parent
      foreach ($rawLine in (Get-Content -LiteralPath $InfPath -ErrorAction SilentlyContinue)) {
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith(';')) { continue }
        if ($line -match '^(?i)([^\\/:*?"<>|,=\\s]+\\.[A-Za-z0-9_]{1,5})\\s*,\\s*([^\\/:*?"<>|,=\\s]+\\.[A-Za-z0-9_]{1,5})\\s*$') {
          $destName = $matches[1]
          $sourceName = $matches[2]
          $destPath = Join-Path $infDir $destName
          $sourcePath = Join-Path $infDir $sourceName
          if (-not (Test-Path $destPath) -and (Test-Path $sourcePath)) {
            try {
              Copy-Item -LiteralPath $sourcePath -Destination $destPath -Force
            } catch {}
          }
        }
      }
    }

    function Ensure-InfSourceLayout {
      param([string]$InfPath)
      if (-not $InfPath -or -not (Test-Path $InfPath)) {
        return
      }

      $infDir = Split-Path -Path $InfPath -Parent
      $diskMap = @{}
      $fileMap = @()
      $currentSection = ''

      foreach ($rawLine in (Get-Content -LiteralPath $InfPath -ErrorAction SilentlyContinue)) {
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith(';')) { continue }

        if ($line -match '^\\[(.+)\\]$') {
          $currentSection = $matches[1].Trim().ToLower()
          continue
        }

        if ($currentSection -eq 'sourcedisksnames' -or $currentSection -eq 'sourcedisksnames.amd64') {
          if ($line -match '^\\s*(\\d+)\\s*=\\s*[^,]*,[^,]*,[^,]*,\\s*"?(.*?)"?\\s*$') {
            $diskId = $matches[1]
            $diskPath = $matches[2].Trim()
            $diskMap[$diskId] = $diskPath
          }
          continue
        }

        if ($currentSection -match '^sourcedisksfiles(\\.|$)') {
          if ($line -match '^\\s*([^=,;\\s]+)\\s*=\\s*(\\d+)') {
            $fileName = $matches[1].Trim()
            $diskId = $matches[2].Trim()
            $fileMap += [PSCustomObject]@{
              fileName = $fileName
              diskId = $diskId
            }
          }
        }
      }

      foreach ($item in $fileMap) {
        $fileName = $item.fileName
        $diskId = $item.diskId
        $subPath = ''
        if ($diskMap.ContainsKey($diskId)) {
          $subPath = [string]$diskMap[$diskId]
        }
        if (-not $subPath) { continue }

        $sourceRootPath = Join-Path $infDir $fileName
        $targetPath = Join-Path $infDir (Join-Path $subPath $fileName)
        if ((-not (Test-Path $targetPath)) -and (Test-Path $sourceRootPath)) {
          $targetDir = Split-Path -Path $targetPath -Parent
          if ($targetDir -and -not (Test-Path $targetDir)) {
            New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
          }
          try {
            Copy-Item -LiteralPath $sourceRootPath -Destination $targetPath -Force
          } catch {}
        }
      }
    }

    $existing = Get-Printer -Name $printerName -ErrorAction SilentlyContinue
    if ($existing) {
      [PSCustomObject]@{ status = 'already-installed'; printerName = $printerName } | ConvertTo-Json -Compress
      return
    }

    $driver = $null
    $pnpOutput = ''

    if ($infPath -and (Test-Path $infPath)) {
      $candidateInfs = @()
      if (Test-Path $backupPath) {
        $candidateInfs += @(Get-ChildItem -Path $backupPath -Filter *.inf -File -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
      }
      if ($infPath -and (Test-Path $infPath) -and ($candidateInfs -notcontains $infPath)) {
        $candidateInfs = @($infPath) + $candidateInfs
      }
      foreach ($candidateInf in ($candidateInfs | Select-Object -Unique)) {
        Ensure-InfMappedAliases -InfPath $candidateInf
        Ensure-InfSourceLayout -InfPath $candidateInf
      }
      $pnpOutput = (& pnputil.exe /add-driver $infPath /install 2>&1 | Out-String)
      if ($LASTEXITCODE -ne 0) {
        $pnpFallbackOutput = (& pnputil.exe /add-driver (Join-Path $backupPath '*.inf') /subdirs /install 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0) {
          throw "Failed to install driver package. pnputil direct output: $pnpOutput; fallback output: $pnpFallbackOutput"
        }
        $pnpOutput = $pnpOutput + [Environment]::NewLine + $pnpFallbackOutput
      }
      $publishedInf = ''
      if ($pnpOutput -match '(?im)Published Name\\s*:\\s*(oem\\d+\\.inf)') {
        $publishedInf = $matches[1]
      }

      $driver = Get-PrinterDriver -Name $expectedDriverName -ErrorAction SilentlyContinue | Select-Object -First 1
      if (-not $driver) {
        $driver = Get-PrinterDriver | Where-Object {
          $_.InfPath -and ([System.IO.Path]::GetFileName($_.InfPath).ToLower() -eq $infFileName.ToLower())
        } | Select-Object -First 1
      }
      if (-not $driver -and $publishedInf -and $expectedDriverName) {
        $publishedInfPath = Join-Path $env:windir (Join-Path 'INF' $publishedInf)
        if (Test-Path $publishedInfPath) {
          try {
            Add-PrinterDriver -Name $expectedDriverName -InfPath $publishedInfPath -ErrorAction Stop
          } catch {}
        }
        $driver = Get-PrinterDriver -Name $expectedDriverName -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $driver) {
          $driver = Get-PrinterDriver | Where-Object {
            $_.InfPath -and ([System.IO.Path]::GetFileName($_.InfPath).ToLower() -eq $publishedInf.ToLower())
          } | Select-Object -First 1
        }
      }
      if (-not $driver) {
        $afterDrivers = @(Get-PrinterDriver)
        $driver = $afterDrivers | Where-Object { $_.Name -notin $beforeDrivers } | Select-Object -First 1
      }
      if (-not $driver -and $expectedDriverName) {
        $driver = Get-PrinterDriver | Where-Object { $_.Name -like \"$expectedDriverName*\" } | Select-Object -First 1
      }
      if (-not $driver -and $expectedDriverName) {
        $driver = Get-PrinterDriver | Where-Object { $expectedDriverName -like \"$($_.Name)*\" } | Select-Object -First 1
      }
    } else {
      $driver = Get-PrinterDriver -Name $expectedDriverName -ErrorAction SilentlyContinue | Select-Object -First 1
    }

    if (-not $driver) {
      if ($infPath) {
        throw "Driver not available after installation. Expected driver: $expectedDriverName. pnputil output: $pnpOutput"
      } else {
        throw "INF file not found in backup folder and expected driver is not present in system: $expectedDriverName"
      }
    }
    $driverName = $driver.Name
    $isUsbProfile = $preferredPort -and $preferredPort -match '(?i)^USB'
    if ($isUsbProfile) {
      [PSCustomObject]@{
        status = 'driver-installed'
        printerName = $printerName
        driverName = $driverName
        portName = ''
      } | ConvertTo-Json -Compress
      return
    }

    if ($preferredPort -and -not (Get-PrinterPort -Name $preferredPort -ErrorAction SilentlyContinue)) {
      $tcpHost = $preferredPortHost
      if (-not $tcpHost -and $preferredPort -match '^(\\d{1,3}(?:\\.\\d{1,3}){3})[_-]\\d+$') {
        $tcpHost = $matches[1]
      }
      if ($tcpHost) {
        try {
          Add-PrinterPort -Name $preferredPort -PrinterHostAddress $tcpHost -ErrorAction Stop
        } catch {
          # ignore recreate failures and fallback later
        }
      }
    }

    $portToUse = $preferredPort
    if (-not $portToUse -or -not (Get-PrinterPort -Name $portToUse -ErrorAction SilentlyContinue)) {
      if ($preferredPortHost) {
        $portToUse = (Get-PrinterPort | Where-Object { $_.PrinterHostAddress -eq $preferredPortHost } | Select-Object -First 1).Name
      }
      if (-not $portToUse) {
        $portToUse = (Get-PrinterPort | Where-Object {
          $_.Name -notin @('FILE:', 'PORTPROMPT:', 'NUL:') -and $_.PrinterHostAddress
        } | Select-Object -First 1).Name
      }
    }
    if (-not $portToUse) {
      $portToUse = 'PORTPROMPT:'
    }
    if (-not (Get-PrinterPort -Name $portToUse -ErrorAction SilentlyContinue) -and $portToUse -ne 'PORTPROMPT:') {
      $portToUse = 'PORTPROMPT:'
    }

    try {
      Add-Printer -Name $printerName -DriverName $driverName -PortName $portToUse -ErrorAction Stop
    } catch {
      if ($portToUse -ne 'PORTPROMPT:') {
        Add-Printer -Name $printerName -DriverName $driverName -PortName 'PORTPROMPT:' -ErrorAction Stop
        $portToUse = 'PORTPROMPT:'
      } else {
        throw "Add-Printer failed: $($_.Exception.Message)"
      }
    }

    [PSCustomObject]@{
      status = 'installed'
      printerName = $printerName
      driverName = $driverName
      portName = $portToUse
    } | ConvertTo-Json -Compress
  `

  return runPowerShellJson(script)
}

async function uninstallPrinter({ printerName }) {
  const script = `
    $ErrorActionPreference = 'Stop'
    $printerName = ${toPsSingleQuote(printerName)}

    function Stop-SpoolerSafe {
      try {
        $svc = Get-Service -Name spooler -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -eq 'Running') {
          Stop-Service -Name spooler -Force -ErrorAction SilentlyContinue
          Start-Sleep -Milliseconds 900
        }
      } catch {}
      try { Stop-Process -Name PrintIsolationHost -Force -ErrorAction SilentlyContinue } catch {}
      try { Stop-Process -Name splwow64 -Force -ErrorAction SilentlyContinue } catch {}
      Start-Sleep -Milliseconds 500
    }

    function Start-SpoolerSafe {
      try {
        $svc = Get-Service -Name spooler -ErrorAction SilentlyContinue
        if ($svc -and $svc.Status -ne 'Running') {
          Start-Service -Name spooler -ErrorAction SilentlyContinue
          Start-Sleep -Milliseconds 900
        }
      } catch {}
    }

    function Restart-SpoolerSafe {
      Stop-SpoolerSafe
      Start-SpoolerSafe
    }

    function Get-MatchingOemInfs {
      param([string[]]$Tokens)
      $enumText = (& pnputil.exe /enum-drivers 2>&1 | Out-String)
      $blocks = $enumText -split '(?ms)\\r?\\n\\s*\\r?\\n'
      $all = @()
      foreach ($block in $blocks) {
        $lower = $block.ToLower()
        $matched = $false
        foreach ($token in $Tokens) {
          if ($token -and $lower.Contains($token.ToLower())) { $matched = $true; break }
        }
        if ($matched) {
          $oems = [regex]::Matches($lower, 'oem\\d+\\.inf') | ForEach-Object { $_.Value } | Select-Object -Unique
          $all += $oems
        }
      }
      return $all | Select-Object -Unique
    }

    function Get-InfReferencedFiles {
      param([string]$InfPath)
      $names = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
      if (-not $InfPath -or -not (Test-Path $InfPath)) {
        return @()
      }

      $inSourceDisksFiles = $false
      foreach ($rawLine in (Get-Content -LiteralPath $InfPath -ErrorAction SilentlyContinue)) {
        $line = $rawLine.Trim()
        if (-not $line -or $line.StartsWith(';')) { continue }

        if ($line -match '^\\[(.+)\\]$') {
          $sectionName = $matches[1].Trim()
          $inSourceDisksFiles = $sectionName -match '(?i)^SourceDisksFiles(\\.|$)'
          continue
        }

        if ($line -match '(?i)^CatalogFile(?:\\.[^=]+)?\\s*=\\s*([^,;]+)') {
          $null = $names.Add($matches[1].Trim().Trim('"'))
        }
        if ($line -match '(?i)^DriverFile\\s*=\\s*([^,;]+)') {
          $null = $names.Add($matches[1].Trim().Trim('"'))
        }
        if ($line -match '(?i)^ConfigFile\\s*=\\s*([^,;]+)') {
          $null = $names.Add($matches[1].Trim().Trim('"'))
        }
        if ($line -match '(?i)^DataFile\\s*=\\s*([^,;]+)') {
          $null = $names.Add($matches[1].Trim().Trim('"'))
        }
        if ($line -match '(?i)^HelpFile\\s*=\\s*([^,;]+)') {
          $null = $names.Add($matches[1].Trim().Trim('"'))
        }
        if ($line -match '(?i)^PrintProcessor\\s*=\\s*"?[^",;]+[, ]+([^",;]+)') {
          $null = $names.Add($matches[1].Trim().Trim('"'))
        }
        if ($line -match '(?i)^LanguageMonitor\\s*=\\s*"?[^",;]+[, ]+([^",;]+)') {
          $null = $names.Add($matches[1].Trim().Trim('"'))
        }
        if ($inSourceDisksFiles -and $line -match '^([^=,;\\s]+)\\s*=') {
          $null = $names.Add($matches[1].Trim().Trim('"'))
        }
      }

      return @($names)
    }

    function Get-SpoolResidues {
      param([string[]]$ExactNames)
      $result = @()
      $hasExact = $ExactNames -and $ExactNames.Count -gt 0
      if (-not $hasExact) {
        return $result
      }
      $exactSet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
      if ($hasExact) {
        foreach ($n in $ExactNames) {
          if ($n) { $null = $exactSet.Add($n.ToLower()) }
        }
      }
      try {
        $allSpool = Get-ChildItem -Path (Join-Path $env:windir 'System32\\spool\\drivers\\x64\\3') -File -ErrorAction SilentlyContinue
        foreach ($f in $allSpool) {
          $n = $f.Name.ToLower()
          if ($exactSet.Contains($n)) {
            $result += $f.FullName
          }
        }
      } catch {}
      return $result | Select-Object -Unique
    }

    function Remove-SpoolFileSafe {
      param([string]$FilePath)
      if (-not $FilePath -or -not (Test-Path -LiteralPath $FilePath)) {
        return $true
      }

      try {
        Remove-Item -LiteralPath $FilePath -Force -ErrorAction Stop
        return $true
      } catch {}

      try {
        [System.IO.File]::SetAttributes($FilePath, [System.IO.FileAttributes]::Normal)
      } catch {}
      try {
        & takeown.exe /f $FilePath /a | Out-Null
      } catch {}
      try {
        & icacls.exe $FilePath '/grant:r' '*S-1-5-32-544:(F)' '/c' | Out-Null
      } catch {}
      try {
        Remove-Item -LiteralPath $FilePath -Force -ErrorAction Stop
        return $true
      } catch {}
      try {
        & cmd.exe /d /c "del /f /q ""$FilePath""" | Out-Null
      } catch {}

      return -not (Test-Path -LiteralPath $FilePath)
    }

    $printer = Get-Printer -Name $printerName -ErrorAction SilentlyContinue
    $driverName = ''
    $portName = ''
    $driverInfBase = ''
    $spoolExactNames = @()
    $status = 'not-installed'

    if ($printer) {
      $status = 'uninstalled'
      $driverName = $printer.DriverName
      $portName = $printer.PortName

      $driver = Get-PrinterDriver -Name $driverName -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($driver -and $driver.InfPath) {
        $driverInfBase = [System.IO.Path]::GetFileName($driver.InfPath)
      }
      $exactNameSet = New-Object 'System.Collections.Generic.HashSet[string]' ([System.StringComparer]::OrdinalIgnoreCase)
      function Add-ExactName {
        param([string]$Value)
        if (-not $Value) { return }
        $name = [System.IO.Path]::GetFileName($Value)
        if (-not $name) { return }
        $null = $exactNameSet.Add($name.ToLower())
      }

      $driverFiles = @()
      if ($driver) {
        $driverFiles += $driver.ConfigFile
        $driverFiles += $driver.DataFile
        $driverFiles += $driver.DriverPath
        $driverFiles += $driver.HelpFile
        $driverFiles += $driver.InfPath
        foreach ($dep in $driver.DependentFiles) {
          $driverFiles += $dep
        }
      }
      foreach ($fileItem in ($driverFiles | Where-Object { $_ } | Select-Object -Unique)) {
        Add-ExactName -Value $fileItem
      }
      if ($driver -and $driver.InfPath -and (Test-Path $driver.InfPath)) {
        foreach ($infRef in (Get-InfReferencedFiles -InfPath $driver.InfPath)) {
          Add-ExactName -Value $infRef
        }
      }
      if ($driverInfBase) {
        Add-ExactName -Value $driverInfBase
      }
      $spoolExactNames = @($exactNameSet)

      Remove-Printer -Name $printerName -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 500
    }

    $portRemoved = $false
    $portRemoveError = ''
    if ($portName) {
      if ($portName.Trim() -match '(?i)^USB') {
        # Keep USB virtual ports to avoid removal errors and keep reinstall path stable.
        $portRemoved = $true
      } else {
        $portRefs = @(Get-Printer | Where-Object { $_.PortName -eq $portName }).Count
        if ($portRefs -eq 0) {
          try {
            Remove-PrinterPort -Name $portName -ErrorAction Stop
            $portRemoved = $true
          } catch {
            $portRemoveError = $_.Exception.Message
          }
        } else {
          $portRemoveError = "Port still referenced by $portRefs printer(s)."
        }
      }
    }

    $driverRemoved = $false
    $driverRemoveError = ''
    $targetTokens = @($driverName, $driverInfBase) | Where-Object { $_ } | Select-Object -Unique
    if ($driverInfBase -and $driverInfBase -match '^([^\\.]+\\.inf)') {
      $targetTokens += $matches[1]
    }

    for ($attempt = 0; $attempt -lt 4; $attempt++) {
      $candidateOems = Get-MatchingOemInfs -Tokens $targetTokens

      if ($driverName) {
        try { Remove-PrinterDriver -Name $driverName -ErrorAction Stop } catch {}
        try { & rundll32 printui.dll,PrintUIEntry /dd /m $driverName /q } catch {}
      }

      foreach ($oemInf in $candidateOems) {
        $pnputilOutput = (& pnputil.exe /delete-driver $oemInf /uninstall /force 2>&1 | Out-String)
        if ($LASTEXITCODE -ne 0) {
          if ($driverRemoveError) {
            $driverRemoveError = $driverRemoveError + [Environment]::NewLine + $pnputilOutput
          } else {
            $driverRemoveError = $pnputilOutput
          }
        }
      }

      Restart-SpoolerSafe

      $remainByName = @()
      if ($driverName) {
        $remainByName = @(Get-PrinterDriver -Name $driverName -ErrorAction SilentlyContinue)
      }
      $remainByOem = Get-MatchingOemInfs -Tokens $targetTokens
      $driverRemoved = ($remainByName.Count -eq 0 -and $remainByOem.Count -eq 0)
      if ($driverRemoved) {
        $driverRemoveError = ''
        break
      }
    }

    if (-not $driverRemoved -and -not $driverRemoveError) {
      $driverRemoveError = 'Driver package still present after removal attempts.'
    }
    if ($portName -and -not $portRemoved -and -not $portRemoveError) {
      $portRemoveError = 'Port still present after removal attempts.'
    }

    $fileRepoResidues = @()
    $spoolResidues = @()
    $spoolCleanupError = ''
    if ($targetTokens.Count -gt 0) {
      try {
        $allRepo = Get-ChildItem -Path (Join-Path $env:windir 'System32\\DriverStore\\FileRepository') -Directory -ErrorAction SilentlyContinue
        foreach ($d in $allRepo) {
          $n = $d.Name.ToLower()
          foreach ($token in $targetTokens) {
            if ($token -and $n.Contains($token.ToLower().Replace('.inf',''))) {
              $fileRepoResidues += $d.FullName
              break
            }
          }
        }
        $fileRepoResidues = $fileRepoResidues | Select-Object -Unique
      } catch {}
    }

    if ($driverRemoved -and $spoolExactNames.Count -gt 0) {
      $spoolResidues = Get-SpoolResidues -ExactNames $spoolExactNames
    }

    if ($spoolResidues.Count -gt 0) {
      Stop-SpoolerSafe
      foreach ($spoolFile in $spoolResidues) {
        try {
          if (Test-Path -LiteralPath $spoolFile) {
            $removed = Remove-SpoolFileSafe -FilePath $spoolFile
            if (-not $removed) {
              throw "Access denied or file is still in use."
            }
          }
        } catch {
          $msg = "Failed to delete spool file: $spoolFile => $($_.Exception.Message)"
          if ($spoolCleanupError) {
            $spoolCleanupError = $spoolCleanupError + [Environment]::NewLine + $msg
          } else {
            $spoolCleanupError = $msg
          }
        }
      }
      Start-SpoolerSafe
      $spoolResidues = Get-SpoolResidues -ExactNames $spoolExactNames
    }

    [PSCustomObject]@{
      status = $status
      printerName = $printerName
      driverName = $driverName
      driverRemoved = $driverRemoved
      driverRemoveError = $driverRemoveError
      portName = $portName
      portRemoved = $portRemoved
      portRemoveError = $portRemoveError
      fileRepoResidues = $fileRepoResidues
      spoolResidues = $spoolResidues
      spoolCleanupError = $spoolCleanupError
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

  ipcMain.handle('printers:list-installed', async () => getInstalledPrinters())
  ipcMain.handle('printers:list-usb-ports', async () => listUsbPrinterPorts())
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
    return installPrinterFromBackup({
      printerName: payload.printerName,
      backupDir: settings.backupDir,
    })
  })
  ipcMain.handle('printers:uninstall', async (_, payload) => {
    if (!payload?.printerName || typeof payload.printerName !== 'string') {
      throw new Error('Invalid printer name.')
    }
    return uninstallPrinter({
      printerName: payload.printerName,
    })
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
