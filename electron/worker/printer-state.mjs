import { parentPort, workerData } from 'node:worker_threads'
import { loadPsScript } from '../config/script/ps/index.mjs'
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
let runtimeStateScriptPromise = null

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

