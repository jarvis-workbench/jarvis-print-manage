import path from 'node:path'
import fs from 'node:fs/promises'
import { parentPort, workerData } from 'node:worker_threads'
import { loadPsScript } from '../config/script/ps/index.mjs'
import { runPowerShellJson } from '../powershell.mjs'

const pollIntervalMs = Math.max(Number(workerData?.pollIntervalMs) || 2000, 1000)
const WORKER_POWERSHELL_TIMEOUT_MS = 45_000
const ERROR_REPORT_INTERVAL_MS = 10_000
const TIMEOUT_BACKOFF_BASE_MS = 5_000
const TIMEOUT_BACKOFF_MAX_MS = 60_000
const DRIVER_INDEX_FILE_NAME = 'driver-index.json'
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

let timer = null
let seq = 0
let currentBackupDir = String(workerData?.backupDir || '').trim()
let currentVirtualPrinterConfig = normalizeVirtualPrinterConfig(workerData?.virtualPrinterConfig || DEFAULT_VIRTUAL_PRINTER_CONFIG)
let lastSignature = ''
let lastState = {
  printers: [],
  ports: [],
  spooler: 'unknown',
  indexEntries: [],
  printerManage: [],
}
let runtimeStateScriptPromise = null
let pollingInFlight = false
let pendingForcedPoll = false
let timeoutStreak = 0
let timeoutBackoffUntil = 0
let lastErrorKey = ''
let lastErrorAt = 0

function toBool(value) {
  if (value === true || value === false) return value
  if (typeof value === 'string') {
    return value.toLowerCase() === 'true'
  }
  return Boolean(value)
}

function normalizeName(value) {
  return String(value || '').trim()
}

function normalizeToken(value) {
  return String(value || '').trim().toLowerCase()
}

function normalizeStringList(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
  }
  const text = String(value || '').trim()
  if (!text) return []
  return [...new Set(text.split(/[;,]/).map((item) => item.trim()).filter(Boolean))]
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

function isVirtualPrinter(item = {}, virtualConfig = currentVirtualPrinterConfig) {
  const printerName = String(item?.printerName || item?.name || '').toLowerCase()
  const driverName = String(item?.driverName || '').toLowerCase()
  const portName = String(item?.portName || '').toLowerCase()
  if (virtualConfig.keywords.some((keyword) => printerName.includes(keyword) || driverName.includes(keyword))) {
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

function pick(obj, keys, fallback = undefined) {
  for (const key of keys) {
    if (obj?.[key] !== undefined && obj?.[key] !== null) {
      return obj[key]
    }
  }
  return fallback
}

function parseIpCandidate(rawValue) {
  const raw = normalizeName(rawValue)
  if (!raw) return ''
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw)) return raw
  const match = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3})[_-]\d+$/)
  return match ? match[1] : ''
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
    .map((item) => {
      const driver = pick(item, ['driver', 'Driver'], null) || {}
      return {
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
        driverManufacturer: String(pick(driver, ['manufacturer', 'Manufacturer'], '')),
        driverVersion: String(pick(driver, ['driverVersion', 'DriverVersion'], '')),
        systemInfPath: String(pick(driver, ['infPath', 'InfPath'], '')),
        driverEnvironment: String(pick(driver, ['environment', 'Environment'], '')),
        availability: toAvailability(item),
      }
    })
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

function isTransientLanArchivePath(value) {
  const text = String(value || '').trim().replace(/\\/g, '/').toLowerCase()
  if (!text) return false
  if (text.startsWith('lan-remote/')) return true
  return text.includes('/lan-remote/')
}

function normalizeIndexEntry(item = {}) {
  const archiveRelativePath = String(item.archiveRelativePath || item.archiveFileName || '').trim()
  if (isTransientLanArchivePath(archiveRelativePath)) return null
  return {
    printerName: String(item.printerName || '').trim(),
    driverName: String(item.driverName || '').trim(),
    driverVersion: String(item.driverVersion || '').trim(),
    manufacturer: String(item.manufacturer || '').trim(),
    infRelativePath: String(item.infRelativePath || '').trim(),
    backupAt: String(item.backupAt || '').trim(),
    portName: String(item.portName || '').trim(),
    portHostAddress: String(item.portHostAddress || '').trim(),
    portNumber: String(item.portNumber || '').trim(),
    environment: String(item.environment || '').trim(),
    pnpDeviceId: String(item.pnpDeviceId || '').trim(),
    hardwareIds: normalizeStringList(item.hardwareIds),
    usbVid: String(item.usbVid || '').trim(),
    usbPid: String(item.usbPid || '').trim(),
    usbVidPid: String(item.usbVidPid || '').trim(),
    deviceSerial: String(item.deviceSerial || '').trim(),
    archiveFileName: String(item.archiveFileName || '').trim(),
    archiveRelativePath,
    archiveSha256: String(item.archiveSha256 || '').trim().toLowerCase(),
    archiveSize: Number(item.archiveSize) || 0,
    archiveFormat: String(item.archiveFormat || '').trim(),
    extractPolicy: String(item.extractPolicy || '').trim(),
  }
}

async function readDriverIndexEntries() {
  const targetBackupDir = String(currentBackupDir || '').trim()
  if (!targetBackupDir) return []
  const indexPath = path.join(targetBackupDir, DRIVER_INDEX_FILE_NAME)
  try {
    const fileText = await fs.readFile(indexPath, 'utf-8')
    const parsed = JSON.parse(fileText)
    const entries = Array.isArray(parsed?.entries) ? parsed.entries : []
    return entries
      .map((item) => normalizeIndexEntry(item))
      .filter((item) => item && item.printerName)
      .sort((a, b) => String(a.printerName || '').localeCompare(String(b.printerName || '')))
  } catch {
    return []
  }
}

function buildManagePrinters(runtimeState, indexEntries) {
  const runtimePrinters = Array.isArray(runtimeState?.printers) ? runtimeState.printers : []
  const runtimePorts = Array.isArray(runtimeState?.ports) ? runtimeState.ports : []
  const backupEntries = Array.isArray(indexEntries) ? indexEntries : []

  const portMap = new Map(runtimePorts.map((item) => [normalizeToken(item?.name), item]))
  const rowMap = new Map()

  for (const runtimeItem of runtimePrinters) {
    const printerName = normalizeName(runtimeItem?.name)
    if (!printerName) continue
    if (isVirtualPrinter(runtimeItem, currentVirtualPrinterConfig)) continue
    const runtimePortName = String(runtimeItem?.portName || '')
    const portRecord = portMap.get(normalizeToken(runtimePortName))
    const runtimePortHost = String(portRecord?.printerHostAddress || '')
    const resolvedPortHost = runtimePortHost || parseIpCandidate(runtimePortName)
    const row = {
      printerName,
      backupPrinterName: '',
      installed: true,
      backup: false,
      portName: runtimePortName,
      portHostAddress: resolvedPortHost,
      driverName: String(runtimeItem?.driverName || ''),
      manufacturer: String(runtimeItem?.driverManufacturer || ''),
      driverVersion: String(runtimeItem?.driverVersion || ''),
      systemInfPath: String(runtimeItem?.systemInfPath || ''),
      infRelativePath: '',
      printerStatus: runtimeItem?.printerStatus ?? '',
      workOffline: toBool(runtimeItem?.workOffline),
      runtimeAvailability: String(runtimeItem?.availability || ''),
      availability: String(runtimeItem?.availability || ''),
      pnpDeviceId: String(runtimeItem?.pnpDeviceId || ''),
      hardwareIds: normalizeStringList(runtimeItem?.hardwareIds),
      usbVid: String(runtimeItem?.usbVid || ''),
      usbPid: String(runtimeItem?.usbPid || ''),
      usbVidPid: String(runtimeItem?.usbVidPid || ''),
      deviceSerial: String(runtimeItem?.deviceSerial || ''),
    }
    rowMap.set(normalizeToken(printerName), row)
  }

  for (const entry of backupEntries) {
    const backupPrinterName = normalizeName(entry?.printerName)
    if (!backupPrinterName) continue
    if (isVirtualPrinter(entry, currentVirtualPrinterConfig)) continue
    const key = normalizeToken(backupPrinterName)
    const existing = rowMap.get(key)
    if (existing) {
      rowMap.set(key, {
        ...existing,
        backup: true,
        backupPrinterName,
        manufacturer: existing.manufacturer || String(entry?.manufacturer || ''),
        driverVersion: existing.driverVersion || String(entry?.driverVersion || ''),
        infRelativePath: String(entry?.infRelativePath || existing.infRelativePath || ''),
        portHostAddress: existing.portHostAddress || String(entry?.portHostAddress || ''),
        pnpDeviceId: existing.pnpDeviceId || String(entry?.pnpDeviceId || ''),
        hardwareIds: existing.hardwareIds?.length ? existing.hardwareIds : normalizeStringList(entry?.hardwareIds),
        usbVid: existing.usbVid || String(entry?.usbVid || ''),
        usbPid: existing.usbPid || String(entry?.usbPid || ''),
        usbVidPid: existing.usbVidPid || String(entry?.usbVidPid || ''),
        deviceSerial: existing.deviceSerial || String(entry?.deviceSerial || ''),
      })
      continue
    }

    rowMap.set(key, {
      printerName: backupPrinterName,
      backupPrinterName,
      installed: false,
      backup: true,
      portName: String(entry?.portName || ''),
      portHostAddress: String(entry?.portHostAddress || ''),
      driverName: String(entry?.driverName || ''),
      manufacturer: String(entry?.manufacturer || ''),
      driverVersion: String(entry?.driverVersion || ''),
      systemInfPath: '',
      infRelativePath: String(entry?.infRelativePath || ''),
      printerStatus: '',
      workOffline: false,
      runtimeAvailability: '',
      availability: '',
      pnpDeviceId: String(entry?.pnpDeviceId || ''),
      hardwareIds: normalizeStringList(entry?.hardwareIds),
      usbVid: String(entry?.usbVid || ''),
      usbPid: String(entry?.usbPid || ''),
      usbVidPid: String(entry?.usbVidPid || ''),
      deviceSerial: String(entry?.deviceSerial || ''),
    })
  }

  return [...rowMap.values()].sort((a, b) => String(a.printerName || '').localeCompare(String(b.printerName || '')))
}

function buildSignature(state) {
  const runtimePart = state.printers
    .map((item) => `${item.name}|${item.driverName}|${item.driverVersion}|${item.systemInfPath}|${item.portName}|${item.availability}|${item.printerStatus}|${item.queueStatus}|${item.workOffline ? 1 : 0}|${item.usbDisconnected ? 1 : 0}`)
    .join('||')
  const portPart = state.ports
    .map((item) => `${item.name}|${item.printerHostAddress}|${item.portNumber}`)
    .join('||')
  const indexPart = state.indexEntries
    .map((item) => `${item.printerName}|${item.driverName}|${item.driverVersion}|${item.infRelativePath}|${item.portName}|${item.portHostAddress}|${item.archiveRelativePath}|${item.archiveSha256}`)
    .join('||')
  return `${state.spooler}##${state.backupDir || ''}##${runtimePart}##${portPart}##${indexPart}`
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

async function getRuntimeStateScript() {
  if (!runtimeStateScriptPromise) {
    runtimeStateScriptPromise = loadPsScript('printer-runtime-state')
  }
  return runtimeStateScriptPromise
}

async function collectPrinterRuntimeState() {
  const script = await getRuntimeStateScript()
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
      backupDir: nextState.backupDir || '',
      driverIndexEntries: nextState.indexEntries,
      printerManage: nextState.printerManage,
      installedPrinters: nextState.printers,
    },
  })
}

function isPowerShellTimeoutError(error) {
  const text = String(error?.message || error || '').toLowerCase()
  return text.includes('timed out')
}

function emitWorkerError(message, key = message) {
  const now = Date.now()
  const normalizedKey = String(key || '').trim() || String(message || '').trim()
  if (normalizedKey && normalizedKey === lastErrorKey && now - lastErrorAt < ERROR_REPORT_INTERVAL_MS) {
    return
  }
  lastErrorKey = normalizedKey
  lastErrorAt = now
  parentPort?.postMessage({
    type: 'error',
    payload: {
      message: String(message || 'unknown error'),
    },
  })
}

async function pollOnce(force = false) {
  if (pollingInFlight) {
    if (force) {
      pendingForcedPoll = true
    }
    return
  }
  if (!force && timeoutBackoffUntil > Date.now()) {
    return
  }

  pollingInFlight = true
  try {
    const runtime = await collectPrinterRuntimeState()
    const indexEntries = await readDriverIndexEntries()
    const printerManage = buildManagePrinters(runtime, indexEntries)
    timeoutStreak = 0
    timeoutBackoffUntil = 0

    const next = {
      ...runtime,
      backupDir: currentBackupDir,
      indexEntries,
      printerManage,
    }

    const nextSignature = buildSignature(next)
    if (!force && nextSignature === lastSignature) return

    const changes = diffState(lastState, next)
    lastState = next
    lastSignature = nextSignature
    emitState(next, changes)
  } catch (error) {
    if (isPowerShellTimeoutError(error)) {
      timeoutStreak += 1
      const backoffMs = Math.min(TIMEOUT_BACKOFF_MAX_MS, TIMEOUT_BACKOFF_BASE_MS * timeoutStreak)
      timeoutBackoffUntil = Date.now() + backoffMs
      emitWorkerError(
        `${error?.message || String(error)} (timeoutStreak=${timeoutStreak}, backoff=${backoffMs}ms)`,
        'powershell-timeout',
      )
      return
    }
    timeoutStreak = 0
    timeoutBackoffUntil = 0
    emitWorkerError(error?.message || String(error))
  } finally {
    pollingInFlight = false
    if (pendingForcedPoll) {
      pendingForcedPoll = false
      queueMicrotask(() => {
        void pollOnce(true)
      })
    }
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
  if (type === 'config') {
    currentBackupDir = String(message?.payload?.backupDir || '').trim()
    currentVirtualPrinterConfig = normalizeVirtualPrinterConfig(
      message?.payload?.virtualPrinterConfig || currentVirtualPrinterConfig,
    )
    void pollOnce(true)
    return
  }
  if (type === 'stop') {
    stopPolling()
    process.exit(0)
  }
})

startPolling()
