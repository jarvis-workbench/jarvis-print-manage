import { defineStore } from 'pinia'

const DEFAULT_THEME_MODE = 'system'

function createEmptyChanges() {
  return {
    addedPrinters: [],
    removedPrinters: [],
    changedPrinters: [],
    addedPorts: [],
    removedPorts: [],
  }
}

function createEmptyPrinterServerManage() {
  return {
    spooler: 'unknown',
    ports: [],
    changes: createEmptyChanges(),
    printers: [],
  }
}

function toBool(value) {
  if (value === true || value === false) return value
  if (typeof value === 'string') return value.toLowerCase() === 'true'
  return Boolean(value)
}

function normalizeName(value) {
  return String(value || '').trim()
}

function normalizeToken(value) {
  return String(value || '').trim().toLowerCase()
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || '').trim()).filter(Boolean))]
  }
  const text = String(value || '').trim()
  if (!text) return []
  return [...new Set(text.split(/[;,]/).map((item) => item.trim()).filter(Boolean))]
}

function normalizeUsbVidPid(item = {}) {
  const raw = normalizeName(item.usbVidPid || item.UsbVidPid)
  if (raw) return raw.toUpperCase()
  const usbVid = normalizeName(item.usbVid || item.UsbVid).toUpperCase()
  const usbPid = normalizeName(item.usbPid || item.UsbPid).toUpperCase()
  if (!usbVid || !usbPid) return ''
  return `${usbVid}:${usbPid}`
}

function parseIpCandidate(rawValue) {
  const raw = normalizeName(rawValue)
  if (!raw) return ''
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw)) return raw
  const match = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3})[_-]\d+$/)
  return match ? match[1] : ''
}

function pick(obj, keys, fallback = '') {
  for (const key of keys) {
    if (obj?.[key] !== undefined && obj?.[key] !== null) {
      return obj[key]
    }
  }
  return fallback
}

function isVirtualPrinterRecord({ printerName, driverName, portName }) {
  const name = String(printerName || '').toLowerCase()
  const driver = String(driverName || '').toLowerCase()
  const port = String(portName || '').toLowerCase()

  const keywords = [
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

  if (keywords.some((keyword) => name.includes(keyword) || driver.includes(keyword))) {
    return true
  }

  if (port === 'file:' || port === 'portprompt:' || port === 'nul:') {
    return true
  }

  if (port.startsWith('redir') || port.startsWith('ts') || port.includes('prompt')) {
    return true
  }

  return false
}

function buildIdentityTokens(item = {}) {
  const tokens = new Set()
  const pnpDeviceId = normalizeName(item.pnpDeviceId || item.PnpDeviceId)
  const hardwareIds = normalizeStringArray(item.hardwareIds || item.HardwareIds || item.hardwareIdList)
  const usbVidPid = normalizeUsbVidPid(item)
  const deviceSerial = normalizeName(item.deviceSerial || item.DeviceSerial)
  const driverName = normalizeName(item.driverName || item.DriverName)
  const manufacturer = normalizeName(item.manufacturer || item.Manufacturer)
  const portHostAddress = normalizeName(item.portHostAddress || item.PortHostAddress)
  const portName = normalizeName(item.portName || item.PortName)
  const portIp = parseIpCandidate(portHostAddress) || parseIpCandidate(portName)

  if (pnpDeviceId) tokens.add(`pnp:${normalizeToken(pnpDeviceId)}`)
  for (const hardwareId of hardwareIds) {
    tokens.add(`hw:${normalizeToken(hardwareId)}`)
  }
  if (usbVidPid) tokens.add(`usb:${normalizeToken(usbVidPid)}`)
  if (usbVidPid && deviceSerial) {
    tokens.add(`usb-device:${normalizeToken(usbVidPid)}:${normalizeToken(deviceSerial)}`)
  }
  if (driverName && portHostAddress) {
    tokens.add(`driver-host:${normalizeToken(driverName)}:${normalizeToken(portHostAddress)}`)
  }
  if (driverName && portIp) {
    tokens.add(`driver-ip:${normalizeToken(driverName)}:${normalizeToken(portIp)}`)
  }
  if (driverName && manufacturer) {
    tokens.add(`driver-maker:${normalizeToken(driverName)}:${normalizeToken(manufacturer)}`)
  }

  return [...tokens]
}

function buildStrongIdentityTokens(item = {}) {
  const strong = buildIdentityTokens(item).filter((token) =>
    token.startsWith('pnp:')
    || token.startsWith('usb-device:')
    || token.startsWith('hw:')
    || token.startsWith('driver-host:')
    || token.startsWith('driver-ip:'))
  return [...new Set(strong)]
}

function hasTokenOverlap(left = [], right = []) {
  if (!left.length || !right.length) return false
  const set = new Set(left.map((token) => normalizeToken(token)))
  return right.some((token) => set.has(normalizeToken(token)))
}

function toAvailability({ runtimeAvailability, printerStatus, workOffline, installed }) {
  if (!installed) return ''
  const runtime = String(runtimeAvailability || '').toLowerCase()
  const statusText = String(printerStatus ?? '').toLowerCase()
  const statusNum = Number(printerStatus)

  if (runtime === 'offline') return 'offline'
  if (toBool(workOffline)) return 'offline'
  if (Number.isFinite(statusNum) && (statusNum === 7 || statusNum === 8)) return 'offline'
  if (statusText.includes('offline') || statusText.includes('off-line')) return 'offline'

  if (runtime === 'ready') return 'ready'
  return 'ready'
}

function withDerivedAvailability(printer) {
  return {
    ...printer,
    availability: toAvailability(printer),
  }
}

function mergeIdentityFields(base, next) {
  const hardwareIds = [...new Set([
    ...normalizeStringArray(base.hardwareIds),
    ...normalizeStringArray(next.hardwareIds),
  ])]

  const merged = {
    ...base,
    ...next,
    pnpDeviceId: normalizeName(base.pnpDeviceId || next.pnpDeviceId),
    usbVid: normalizeName(base.usbVid || next.usbVid),
    usbPid: normalizeName(base.usbPid || next.usbPid),
    usbVidPid: normalizeName(base.usbVidPid || next.usbVidPid),
    deviceSerial: normalizeName(base.deviceSerial || next.deviceSerial),
    hardwareIds,
  }

  merged.identityTokens = buildIdentityTokens(merged)
  merged.identityStrongTokens = buildStrongIdentityTokens(merged)
  return merged
}

function pickIdentityPatch(item = {}) {
  return {
    pnpDeviceId: normalizeName(item.pnpDeviceId || item.PnpDeviceId),
    hardwareIds: normalizeStringArray(item.hardwareIds || item.HardwareIds || item.hardwareIdList),
    usbVid: normalizeName(item.usbVid || item.UsbVid),
    usbPid: normalizeName(item.usbPid || item.UsbPid),
    usbVidPid: normalizeName(item.usbVidPid || item.UsbVidPid) || normalizeUsbVidPid(item),
    deviceSerial: normalizeName(item.deviceSerial || item.DeviceSerial),
  }
}

function sortPrinters(list) {
  return [...list].sort((a, b) => String(a.printerName || '').localeCompare(String(b.printerName || '')))
}

function createInstalledRecord(raw, previous = null) {
  const name = normalizeName(pick(raw, ['name', 'printerName', 'Name']))
  const driverName = String(pick(raw, ['driverName', 'DriverName']))
  const portName = String(pick(raw, ['portName', 'PortName']))
  const portHostAddress = String(pick(raw, ['portHostAddress', 'PortHostAddress']))
  const driverObj = raw?.driver || raw?.Driver || null

  const record = {
    printerName: name,
    backupPrinterName: String(previous?.backupPrinterName || ''),
    installed: true,
    backup: false,
    portName,
    portHostAddress,
    driverName,
    manufacturer: String(pick(driverObj, ['manufacturer', 'Manufacturer'])),
    driverVersion: String(pick(driverObj, ['driverVersion', 'DriverVersion'])),
    systemInfPath: String(pick(driverObj, ['infPath', 'InfPath'])),
    infRelativePath: String(previous?.infRelativePath || ''),
    printerStatus: pick(raw, ['printerStatus', 'PrinterStatus'], ''),
    workOffline: toBool(pick(raw, ['workOffline', 'WorkOffline'], false)),
    runtimeAvailability: String(previous?.runtimeAvailability || ''),
    pnpDeviceId: normalizeName(pick(raw, ['pnpDeviceId', 'PnpDeviceId'])),
    hardwareIds: normalizeStringArray(pick(raw, ['hardwareIds', 'HardwareIds', 'hardwareIdList'], [])),
    usbVid: normalizeName(pick(raw, ['usbVid', 'UsbVid'])),
    usbPid: normalizeName(pick(raw, ['usbPid', 'UsbPid'])),
    usbVidPid: normalizeName(pick(raw, ['usbVidPid', 'UsbVidPid'])) || normalizeUsbVidPid(raw),
    deviceSerial: normalizeName(pick(raw, ['deviceSerial', 'DeviceSerial'])),
  }

  return mergeIdentityFields(record, {})
}

function createBackupRecord(raw, previous = null) {
  const name = normalizeName(pick(raw, ['printerName', 'name', 'Name']))
  const record = {
    printerName: name,
    backupPrinterName: name,
    installed: false,
    backup: true,
    portName: String(pick(raw, ['portName', 'PortName'])),
    portHostAddress: String(pick(raw, ['portHostAddress', 'PortHostAddress'])),
    driverName: String(pick(raw, ['driverName', 'DriverName'])),
    manufacturer: String(pick(raw, ['manufacturer', 'Manufacturer'])),
    driverVersion: String(pick(raw, ['driverVersion', 'DriverVersion'])),
    systemInfPath: '',
    infRelativePath: String(pick(raw, ['infRelativePath', 'InfRelativePath'])),
    printerStatus: '',
    workOffline: false,
    runtimeAvailability: String(previous?.runtimeAvailability || ''),
    pnpDeviceId: normalizeName(pick(raw, ['pnpDeviceId', 'PnpDeviceId'])),
    hardwareIds: normalizeStringArray(pick(raw, ['hardwareIds', 'HardwareIds', 'hardwareIdList'], [])),
    usbVid: normalizeName(pick(raw, ['usbVid', 'UsbVid'])),
    usbPid: normalizeName(pick(raw, ['usbPid', 'UsbPid'])),
    usbVidPid: normalizeName(pick(raw, ['usbVidPid', 'UsbVidPid'])) || normalizeUsbVidPid(raw),
    deviceSerial: normalizeName(pick(raw, ['deviceSerial', 'DeviceSerial'])),
  }

  return mergeIdentityFields(record, {})
}

function computeMatchScore(installedRow, backupRow) {
  const installedName = normalizeToken(installedRow.printerName)
  const backupName = normalizeToken(backupRow.printerName)
  const installedPnp = normalizeToken(installedRow.pnpDeviceId)
  const backupPnp = normalizeToken(backupRow.pnpDeviceId)
  const installedUsbDevice = normalizeToken(installedRow.usbVidPid && installedRow.deviceSerial ? `${installedRow.usbVidPid}:${installedRow.deviceSerial}` : '')
  const backupUsbDevice = normalizeToken(backupRow.usbVidPid && backupRow.deviceSerial ? `${backupRow.usbVidPid}:${backupRow.deviceSerial}` : '')
  const installedUsbVidPid = normalizeToken(installedRow.usbVidPid)
  const backupUsbVidPid = normalizeToken(backupRow.usbVidPid)
  const installedDriverHost = normalizeToken(installedRow.driverName && installedRow.portHostAddress ? `${installedRow.driverName}:${installedRow.portHostAddress}` : '')
  const backupDriverHost = normalizeToken(backupRow.driverName && backupRow.portHostAddress ? `${backupRow.driverName}:${backupRow.portHostAddress}` : '')
  const installedIp = parseIpCandidate(installedRow.portHostAddress) || parseIpCandidate(installedRow.portName)
  const backupIp = parseIpCandidate(backupRow.portHostAddress) || parseIpCandidate(backupRow.portName)
  const installedDriverIp = normalizeToken(installedRow.driverName && installedIp ? `${installedRow.driverName}:${installedIp}` : '')
  const backupDriverIp = normalizeToken(backupRow.driverName && backupIp ? `${backupRow.driverName}:${backupIp}` : '')

  if (installedPnp && backupPnp && installedPnp === backupPnp) return 100
  if (installedUsbDevice && backupUsbDevice && installedUsbDevice === backupUsbDevice) return 95
  if (hasTokenOverlap(installedRow.identityStrongTokens, backupRow.identityStrongTokens)) return 90
  if (installedDriverIp && backupDriverIp && installedDriverIp === backupDriverIp) return 85
  if (installedUsbVidPid && backupUsbVidPid && installedUsbVidPid === backupUsbVidPid) return 80
  if (installedDriverHost && backupDriverHost && installedDriverHost === backupDriverHost) return 70
  if (installedName && backupName && installedName === backupName) return 40
  return 0
}

function findBestMatchIndex(installedRows, backupRow) {
  let bestIndex = -1
  let bestScore = 0
  for (let i = 0; i < installedRows.length; i += 1) {
    const candidate = installedRows[i]
    const score = computeMatchScore(candidate, backupRow)
    if (score > bestScore) {
      bestScore = score
      bestIndex = i
    }
  }
  return bestScore >= 70 || bestScore === 40 ? bestIndex : -1
}

export const useRuntimeStore = defineStore('runtime', {
  state: () => ({
    settingsLoaded: false,
    settings: {
      backupDir: '',
      themeMode: DEFAULT_THEME_MODE,
    },
    PrinterServerManage: createEmptyPrinterServerManage(),
    usbPorts: [],
    busy: {
      refreshing: false,
      backingUp: false,
      installing: false,
      uninstalling: false,
    },
    wizard: {
      visible: false,
      printerName: '',
      host: '',
    },
    lastSyncAt: '',
  }),
  actions: {
    setSettings(settings = {}) {
      this.settings = {
        backupDir: String(settings?.backupDir || ''),
        themeMode: String(settings?.themeMode || DEFAULT_THEME_MODE),
      }
      this.settingsLoaded = true
    },
    setPrinterSnapshot(payload = {}) {
      const installed = Array.isArray(payload?.installedPrinters) ? payload.installedPrinters : []
      const indexEntries = Array.isArray(payload?.driverIndexEntries) ? payload.driverIndexEntries : []
      const previousPrinters = Array.isArray(this.PrinterServerManage?.printers) ? this.PrinterServerManage.printers : []
      const previousMap = new Map(previousPrinters.map((item) => [normalizeName(item?.printerName), item]))

      const installedRows = []
      for (const item of installed) {
        const name = normalizeName(pick(item, ['name', 'printerName', 'Name']))
        if (!name) continue
        const driverName = String(pick(item, ['driverName', 'DriverName']))
        const portName = String(pick(item, ['portName', 'PortName']))
        if (isVirtualPrinterRecord({ printerName: name, driverName, portName })) continue

        const previous = previousMap.get(name)
        installedRows.push(withDerivedAvailability(createInstalledRecord(item, previous)))
      }

      const mergedRows = [...installedRows]
      for (const entry of indexEntries) {
        const backupName = normalizeName(pick(entry, ['printerName', 'name', 'Name']))
        if (!backupName) continue
        const entryDriverName = String(pick(entry, ['driverName', 'DriverName']))
        const entryPortName = String(pick(entry, ['portName', 'PortName']))
        if (isVirtualPrinterRecord({ printerName: backupName, driverName: entryDriverName, portName: entryPortName })) continue

        const previous = previousMap.get(backupName)
        const backupRecord = withDerivedAvailability(createBackupRecord(entry, previous))
        const matchedIndex = findBestMatchIndex(mergedRows, backupRecord)

        if (matchedIndex >= 0) {
          const matched = mergedRows[matchedIndex]
          mergedRows[matchedIndex] = withDerivedAvailability(mergeIdentityFields({
            ...matched,
            backup: true,
            backupPrinterName: backupRecord.backupPrinterName || backupRecord.printerName,
            manufacturer: matched.manufacturer || backupRecord.manufacturer,
            driverVersion: matched.driverVersion || backupRecord.driverVersion,
            infRelativePath: backupRecord.infRelativePath || matched.infRelativePath,
            portHostAddress: matched.portHostAddress || backupRecord.portHostAddress,
          }, pickIdentityPatch(backupRecord)))
        } else {
          mergedRows.push(backupRecord)
        }
      }

      this.settings = {
        ...this.settings,
        backupDir: String(payload?.backupDir || this.settings.backupDir || ''),
      }
      this.PrinterServerManage = {
        ...this.PrinterServerManage,
        printers: sortPrinters(mergedRows.map((row) => withDerivedAvailability(row))),
      }
      this.lastSyncAt = new Date().toISOString()
    },
    setPrinterRuntimeState(state = {}) {
      const currentPrinters = Array.isArray(this.PrinterServerManage?.printers) ? this.PrinterServerManage.printers : []
      const runtimePrinters = Array.isArray(state?.printers) ? state.printers : []
      const nextPrinters = currentPrinters.map((item) => ({ ...item }))

      const findMatchIndex = (runtimeRecord) => {
        const runtimeName = normalizeName(runtimeRecord.printerName)
        const byNameIndex = nextPrinters.findIndex((item) => normalizeName(item?.printerName) === runtimeName)
        if (byNameIndex >= 0) return byNameIndex
        const strongTokens = runtimeRecord.identityStrongTokens || []
        if (!strongTokens.length) return -1
        return nextPrinters.findIndex((item) => hasTokenOverlap(item.identityStrongTokens || [], strongTokens))
      }

      for (const runtimeItem of runtimePrinters) {
        const runtimeName = normalizeName(pick(runtimeItem, ['name', 'printerName', 'Name']))
        if (!runtimeName) continue
        const runtimeDriverName = String(pick(runtimeItem, ['driverName', 'DriverName']))
        const runtimePortName = String(pick(runtimeItem, ['portName', 'PortName']))
        if (isVirtualPrinterRecord({ printerName: runtimeName, driverName: runtimeDriverName, portName: runtimePortName })) continue

        const runtimeRecord = mergeIdentityFields({
          printerName: runtimeName,
          installed: true,
          backup: false,
          portName: runtimePortName,
          portHostAddress: String(pick(runtimeItem, ['portHostAddress', 'PortHostAddress'])),
          driverName: runtimeDriverName,
          manufacturer: '',
          driverVersion: '',
          systemInfPath: '',
          infRelativePath: '',
          printerStatus: pick(runtimeItem, ['printerStatus', 'PrinterStatus'], ''),
          workOffline: toBool(pick(runtimeItem, ['workOffline', 'WorkOffline'], false)),
          runtimeAvailability: String(pick(runtimeItem, ['availability', 'Availability'], '')),
          pnpDeviceId: normalizeName(pick(runtimeItem, ['pnpDeviceId', 'PnpDeviceId'])),
          hardwareIds: normalizeStringArray(pick(runtimeItem, ['hardwareIds', 'HardwareIds', 'hardwareIdList'], [])),
          usbVid: normalizeName(pick(runtimeItem, ['usbVid', 'UsbVid'])),
          usbPid: normalizeName(pick(runtimeItem, ['usbPid', 'UsbPid'])),
          usbVidPid: normalizeName(pick(runtimeItem, ['usbVidPid', 'UsbVidPid'])) || normalizeUsbVidPid(runtimeItem),
          deviceSerial: normalizeName(pick(runtimeItem, ['deviceSerial', 'DeviceSerial'])),
        }, {})

        const matchIndex = findMatchIndex(runtimeRecord)
        if (matchIndex >= 0) {
          const existing = nextPrinters[matchIndex]
          nextPrinters[matchIndex] = withDerivedAvailability(mergeIdentityFields({
            ...existing,
            printerName: runtimeName,
            installed: true,
            printerStatus: runtimeRecord.printerStatus,
            workOffline: runtimeRecord.workOffline,
            portName: existing.portName || runtimeRecord.portName,
            portHostAddress: existing.portHostAddress || runtimeRecord.portHostAddress,
            driverName: existing.driverName || runtimeRecord.driverName,
            runtimeAvailability: runtimeRecord.runtimeAvailability || existing.runtimeAvailability || '',
          }, pickIdentityPatch(runtimeRecord)))
        } else {
          nextPrinters.push(withDerivedAvailability(runtimeRecord))
        }
      }

      const removed = Array.isArray(state?.changes?.removedPrinters) ? state.changes.removedPrinters : []
      for (const removedNameRaw of removed) {
        const removedName = normalizeName(removedNameRaw)
        if (!removedName) continue
        const index = nextPrinters.findIndex((item) => normalizeName(item?.printerName) === removedName)
        if (index < 0) continue
        const existing = nextPrinters[index]
        if (existing.backup) {
          nextPrinters[index] = withDerivedAvailability({
            ...existing,
            installed: false,
            printerStatus: '',
            workOffline: false,
            runtimeAvailability: '',
          })
        } else {
          // Avoid deleting rows on transient runtime misses; snapshot refresh will reconcile hard deletions.
          nextPrinters[index] = withDerivedAvailability({
            ...existing,
            runtimeAvailability: 'offline',
            workOffline: true,
          })
        }
      }

      this.PrinterServerManage = {
        spooler: String(state?.spooler || this.PrinterServerManage?.spooler || 'unknown'),
        ports: Array.isArray(state?.ports) ? state.ports : this.PrinterServerManage?.ports || [],
        changes: {
          ...createEmptyChanges(),
          ...(this.PrinterServerManage?.changes || {}),
          ...(state?.changes || {}),
        },
        printers: sortPrinters(nextPrinters.map((row) => withDerivedAvailability(row))),
      }
      this.lastSyncAt = new Date().toISOString()
    },
    applyOptimisticUninstall(payload = {}) {
      const key = normalizeName(payload?.printerName)
      if (!key) return
      const keepBackup = Boolean(payload?.keepBackup)
      const currentPrinters = Array.isArray(this.PrinterServerManage?.printers) ? this.PrinterServerManage.printers : []
      const map = new Map(currentPrinters.map((item) => [normalizeName(item?.printerName), { ...item }]))
      const existing = map.get(key)
      if (!existing) return

      if (keepBackup || existing.backup) {
        map.set(key, withDerivedAvailability({
          ...existing,
          installed: false,
          printerStatus: '',
          workOffline: false,
          runtimeAvailability: '',
        }))
      } else {
        map.delete(key)
      }

      this.PrinterServerManage = {
        ...this.PrinterServerManage,
        printers: sortPrinters([...map.values()]),
      }
      this.lastSyncAt = new Date().toISOString()
    },
    applyOptimisticBackup(payload = {}) {
      const key = normalizeName(payload?.printerName)
      if (!key) return
      const currentPrinters = Array.isArray(this.PrinterServerManage?.printers) ? this.PrinterServerManage.printers : []
      const map = new Map(currentPrinters.map((item) => [normalizeName(item?.printerName), { ...item }]))
      const existing = map.get(key)
      if (!existing) return

      map.set(key, withDerivedAvailability({
        ...existing,
        backup: true,
        backupPrinterName: existing.backupPrinterName || existing.printerName,
      }))

      this.PrinterServerManage = {
        ...this.PrinterServerManage,
        printers: sortPrinters([...map.values()]),
      }
      this.lastSyncAt = new Date().toISOString()
    },
    setUsbPorts(list = []) {
      this.usbPorts = Array.isArray(list) ? list : []
      this.lastSyncAt = new Date().toISOString()
    },
    setBusy(key, value) {
      if (!Object.prototype.hasOwnProperty.call(this.busy, key)) return
      this.busy[key] = Boolean(value)
    },
    patchWizard(patch = {}) {
      this.wizard = {
        ...this.wizard,
        ...patch,
      }
    },
    resetRuntimeCollections() {
      this.PrinterServerManage = createEmptyPrinterServerManage()
      this.usbPorts = []
      this.lastSyncAt = ''
    },
  },
})
