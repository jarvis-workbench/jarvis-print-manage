import { parentPort, workerData } from 'node:worker_threads'
import { runPowerShellJson } from '../powershell.mjs'

const pollIntervalMs = Math.max(Number(workerData?.pollIntervalMs) || 2000, 1000)
const WORKER_POWERSHELL_TIMEOUT_MS = 30_000

let timer = null
let seq = 0
let lastSignature = ''
let lastState = {
  printers: [],
  ports: [],
  spooler: 'unknown',
}

function toBool(value) {
  if (value === true || value === false) return value
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true'
  }
  return Boolean(value)
}

function isOfflineStatusNumber(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return false
  return num === 7 || num === 8
}

function isQueueStatusOffline(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return false
  return (num & 0x80) === 0x80
}

function pick(obj, keys, fallback = undefined) {
  for (const key of keys) {
    if (obj?.[key] !== undefined && obj?.[key] !== null) {
      return obj[key]
    }
  }
  return fallback
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
  }
  const text = String(value || '').trim()
  if (!text) return []
  return [...new Set(text.split(/[;,]/).map((item) => item.trim()).filter(Boolean))]
}

function toAvailability(printer) {
  const statusText = [
    pick(printer, ['printerStatus', 'PrinterStatus'], ''),
    pick(printer, ['queueStatus', 'QueueStatus'], ''),
    pick(printer, ['wmiPrinterStatus', 'WmiPrinterStatus'], ''),
    pick(printer, ['wmiAvailability', 'WmiAvailability'], ''),
    pick(printer, ['wmiPrinterState', 'WmiPrinterState'], ''),
    pick(printer, ['wmiExtendedPrinterStatus', 'WmiExtendedPrinterStatus'], ''),
    pick(printer, ['wmiDetectedErrorState', 'WmiDetectedErrorState'], ''),
  ]
    .map((value) => String(value ?? ''))
    .join(' ')
    .toLowerCase()

  if (toBool(pick(printer, ['usbDisconnected', 'UsbDisconnected'], false))) return 'offline'
  if (
    toBool(pick(printer, ['workOffline', 'WorkOffline'], false)) ||
    toBool(pick(printer, ['wmiWorkOffline', 'WmiWorkOffline'], false))
  ) {
    return 'offline'
  }
  if (
    isQueueStatusOffline(pick(printer, ['queueStatus', 'QueueStatus'])) ||
    isOfflineStatusNumber(pick(printer, ['printerStatus', 'PrinterStatus'])) ||
    isOfflineStatusNumber(pick(printer, ['wmiPrinterStatus', 'WmiPrinterStatus'])) ||
    isOfflineStatusNumber(pick(printer, ['wmiAvailability', 'WmiAvailability'])) ||
    isOfflineStatusNumber(pick(printer, ['wmiExtendedPrinterStatus', 'WmiExtendedPrinterStatus'])) ||
    Number(pick(printer, ['wmiPrinterState', 'WmiPrinterState'])) === 6 ||
    Number(pick(printer, ['wmiDetectedErrorState', 'WmiDetectedErrorState'])) === 9
  ) {
    return 'offline'
  }
  if (
    statusText.includes('offline') ||
    statusText.includes('脱机') ||
    statusText.includes('离线') ||
    statusText.includes('離線')
  ) {
    return 'offline'
  }
  return 'ready'
}

function normalizePrinters(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  return list
    .map((item) => ({
      name: String(pick(item, ['name', 'Name'], '')),
      driverName: String(pick(item, ['driverName', 'DriverName'], '')),
      portName: String(pick(item, ['portName', 'PortName'], '')),
      printerStatus: pick(item, ['printerStatus', 'PrinterStatus', 'wmiPrinterStatus', 'WmiPrinterStatus'], ''),
      workOffline: toBool(pick(item, ['workOffline', 'WorkOffline'], false)) || toBool(pick(item, ['wmiWorkOffline', 'WmiWorkOffline'], false)),
      usbDisconnected: toBool(pick(item, ['usbDisconnected', 'UsbDisconnected'], false)),
      queueStatus: pick(item, ['queueStatus', 'QueueStatus'], ''),
      shared: toBool(pick(item, ['shared', 'Shared'], false)),
      shareName: String(pick(item, ['shareName', 'ShareName'], '')),
      pnpDeviceId: String(pick(item, ['pnpDeviceId', 'PnpDeviceId'], '')),
      hardwareIds: normalizeStringList(pick(item, ['hardwareIds', 'HardwareIds', 'hardwareIdList'], [])),
      usbVid: String(pick(item, ['usbVid', 'UsbVid'], '')),
      usbPid: String(pick(item, ['usbPid', 'UsbPid'], '')),
      usbVidPid: String(pick(item, ['usbVidPid', 'UsbVidPid'], '')),
      deviceSerial: String(pick(item, ['deviceSerial', 'DeviceSerial'], '')),
      availability: toAvailability(item),
    }))
    .filter((item) => item.name)
    .sort((a, b) => a.name.localeCompare(b.name))
}

function normalizePorts(raw) {
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  return list
    .map((item) => ({
      name: String(pick(item, ['name', 'Name'], '')),
      printerHostAddress: String(pick(item, ['printerHostAddress', 'PrinterHostAddress'], '')),
      portNumber: String(pick(item, ['portNumber', 'PortNumber'], '')),
    }))
    .filter((item) => item.name)
    .sort((a, b) => a.name.localeCompare(b.name))
}

function buildSignature(state) {
  const printerPart = state.printers
    .map((item) => `${item.name}|${item.driverName}|${item.portName}|${item.availability}|${item.printerStatus}|${item.queueStatus}|${item.workOffline ? 1 : 0}|${item.usbDisconnected ? 1 : 0}`)
    .join('||')
  const portPart = state.ports
    .map((item) => `${item.name}|${item.printerHostAddress}|${item.portNumber}`)
    .join('||')
  return `${state.spooler}##${printerPart}##${portPart}`
}

function diffState(prev, next) {
  const prevPrinters = new Map(prev.printers.map((item) => [item.name, item]))
  const nextPrinters = new Map(next.printers.map((item) => [item.name, item]))
  const prevPorts = new Map(prev.ports.map((item) => [item.name, item]))
  const nextPorts = new Map(next.ports.map((item) => [item.name, item]))

  const addedPrinters = []
  const removedPrinters = []
  const changedPrinters = []
  const addedPorts = []
  const removedPorts = []

  for (const [name, item] of nextPrinters) {
    const old = prevPrinters.get(name)
    if (!old) {
      addedPrinters.push(name)
      continue
    }
    if (
      old.driverName !== item.driverName ||
      old.portName !== item.portName ||
      old.availability !== item.availability ||
      String(old.printerStatus) !== String(item.printerStatus) ||
      String(old.queueStatus) !== String(item.queueStatus) ||
      old.workOffline !== item.workOffline ||
      old.usbDisconnected !== item.usbDisconnected
    ) {
      changedPrinters.push(name)
    }
  }

  for (const name of prevPrinters.keys()) {
    if (!nextPrinters.has(name)) removedPrinters.push(name)
  }

  for (const name of nextPorts.keys()) {
    if (!prevPorts.has(name)) addedPorts.push(name)
  }
  for (const name of prevPorts.keys()) {
    if (!nextPorts.has(name)) removedPorts.push(name)
  }

  return {
    addedPrinters,
    removedPrinters,
    changedPrinters,
    addedPorts,
    removedPorts,
  }
}

async function collectPrinterRuntimeState() {
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
      [PSCustomObject]@{
        spooler = 'stopped'
        printers = @()
        ports = @()
      } | ConvertTo-Json -Depth 6 -Compress
      return
    }

    $wmiPrinterMap = @{}
    foreach ($wmiPrinter in (Get-CimInstance -ClassName Win32_Printer -ErrorAction SilentlyContinue)) {
      if ($wmiPrinter -and $wmiPrinter.Name) {
        $wmiPrinterMap[$wmiPrinter.Name] = $wmiPrinter
      }
    }
    $pnpEntityMap = @{}
    foreach ($pnpEntity in (Get-CimInstance -ClassName Win32_PnPEntity -ErrorAction SilentlyContinue)) {
      if ($pnpEntity -and $pnpEntity.DeviceID) {
        $pnpEntityMap[[string]$pnpEntity.DeviceID] = $pnpEntity
      }
    }
    $presentPnpMap = @{}
    if (Get-Command Get-PnpDevice -ErrorAction SilentlyContinue) {
      foreach ($device in (Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue)) {
        if ($device -and $device.InstanceId) {
          $presentPnpMap[[string]$device.InstanceId.ToLower()] = $true
        }
      }
    }
    $presentUsbPrinterNames = @()
    if (Get-Command Get-PnpDevice -ErrorAction SilentlyContinue) {
      foreach ($device in (Get-PnpDevice -PresentOnly -ErrorAction SilentlyContinue)) {
        $instanceId = [string]$device.InstanceId
        if (-not $instanceId) { continue }
        if ($instanceId -like 'USBPRINT\\*') {
          $friendly = [string]$device.FriendlyName
          if ($friendly) {
            $presentUsbPrinterNames += $friendly.ToLower()
          }
        }
      }
    }

    $printers = @(
      Get-Printer -ErrorAction SilentlyContinue |
      ForEach-Object {
        $wmi = $null
        if ($wmiPrinterMap.ContainsKey($_.Name)) {
          $wmi = $wmiPrinterMap[$_.Name]
        }
        $resolvedWorkOffline = [bool]$_.WorkOffline
        if ($wmi -and $wmi.WorkOffline -ne $null) {
          $resolvedWorkOffline = $resolvedWorkOffline -or [bool]$wmi.WorkOffline
        }
        $portNameText = [string]$_.PortName
        $isUsbPort = $portNameText -match '^(?i)(USB\\d*|DOT4\\d*)'
        $wmiPnpId = if ($wmi) { [string]$wmi.PNPDeviceID } else { '' }
        $hardwareIds = @()
        if ($wmiPnpId -and $pnpEntityMap.ContainsKey($wmiPnpId)) {
          $rawHardwareIds = @($pnpEntityMap[$wmiPnpId].HardwareID)
          if ($rawHardwareIds) {
            $hardwareIds = @($rawHardwareIds | ForEach-Object { [string]$_ } | Where-Object { $_ })
          }
        }
        if (-not $hardwareIds -and $wmiPnpId) {
          $hardwareIds = @($wmiPnpId)
        }
        $usbVid = ''
        $usbPid = ''
        $usbVidPid = ''
        $deviceSerial = ''
        if ($wmiPnpId -match '(?i)VID_([0-9A-F]{4})&PID_([0-9A-F]{4})') {
          $usbVid = $matches[1].ToUpper()
          $usbPid = $matches[2].ToUpper()
          $usbVidPid = ($usbVid + ':' + $usbPid)
        }
        if ($wmiPnpId -like 'USBPRINT\\*' -or $wmiPnpId -like 'USB\\VID_*') {
          $parts = $wmiPnpId -split '\\\\'
          if ($parts.Count -ge 3) {
            $deviceSerial = [string]$parts[$parts.Count - 1]
          }
        }
        $usbDisconnected = $false
        if ($isUsbPort) {
          # USB profiles are considered disconnected by default until a live device matches.
          $usbDisconnected = $true
          if ($wmiPnpId) {
            $usbDisconnected = -not $presentPnpMap.ContainsKey($wmiPnpId.ToLower())
          } else {
            $printerNameLower = ([string]$_.Name).ToLower()
            $driverNameLower = ([string]$_.DriverName).ToLower()
            foreach ($presentName in $presentUsbPrinterNames) {
              if (
                $printerNameLower.Contains($presentName) -or
                $presentName.Contains($printerNameLower) -or
                $driverNameLower.Contains($presentName) -or
                $presentName.Contains($driverNameLower)
              ) {
                $usbDisconnected = $false
                break
              }
            }
          }
        }
        [PSCustomObject]@{
          Name = $_.Name
          DriverName = $_.DriverName
          PortName = $portNameText
          PrinterStatus = $_.PrinterStatus
          WorkOffline = $resolvedWorkOffline
          UsbDisconnected = $usbDisconnected
          Shared = $_.Shared
          ShareName = $_.ShareName
          QueueStatus = $_.QueueStatus
          PnpDeviceId = $wmiPnpId
          HardwareIds = $hardwareIds
          UsbVid = $usbVid
          UsbPid = $usbPid
          UsbVidPid = $usbVidPid
          DeviceSerial = $deviceSerial
          WmiWorkOffline = if ($wmi) { [bool]$wmi.WorkOffline } else { $false }
          WmiPrinterStatus = if ($wmi) { $wmi.PrinterStatus } else { $null }
          WmiAvailability = if ($wmi) { $wmi.Availability } else { $null }
          WmiPrinterState = if ($wmi) { $wmi.PrinterState } else { $null }
          WmiExtendedPrinterStatus = if ($wmi) { $wmi.ExtendedPrinterStatus } else { $null }
          WmiDetectedErrorState = if ($wmi) { $wmi.DetectedErrorState } else { $null }
        }
      }
    )
    $ports = @(
      Get-PrinterPort -ErrorAction SilentlyContinue |
        Select-Object Name, PrinterHostAddress, PortNumber
    )
    [PSCustomObject]@{
      spooler = 'running'
      printers = $printers
      ports = $ports
    } | ConvertTo-Json -Depth 8 -Compress
  `

  const data = await runPowerShellJson(script, { timeoutMs: WORKER_POWERSHELL_TIMEOUT_MS })
  return {
    spooler: String(data?.spooler || 'unknown'),
    printers: normalizePrinters(data?.printers),
    ports: normalizePorts(data?.ports),
  }
}

function emitState(nextState, changes) {
  seq += 1
  parentPort?.postMessage({
    type: 'snapshot',
    payload: {
      seq,
      changedAt: new Date().toISOString(),
      spooler: nextState.spooler,
      printers: nextState.printers,
      ports: nextState.ports,
      changes,
    },
  })
}

async function pollOnce(force = false) {
  try {
    const next = await collectPrinterRuntimeState()
    const nextSignature = buildSignature(next)
    if (!force && nextSignature === lastSignature) return
    const changes = diffState(lastState, next)
    lastState = next
    lastSignature = nextSignature
    emitState(next, changes)
  } catch (error) {
    parentPort?.postMessage({
      type: 'error',
      payload: {
        message: error?.message || String(error),
      },
    })
  }
}

function startPolling() {
  if (timer) return
  timer = setInterval(() => {
    void pollOnce(false)
  }, pollIntervalMs)
  void pollOnce(true)
}

function stopPolling() {
  if (!timer) return
  clearInterval(timer)
  timer = null
}

parentPort?.on('message', (message) => {
  const type = String(message?.type || '')
  if (type === 'refresh') {
    void pollOnce(true)
    return
  }
  if (type === 'stop') {
    stopPolling()
    process.exit(0)
  }
})

startPolling()

