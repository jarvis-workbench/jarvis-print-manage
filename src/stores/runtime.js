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

function sortPrinters(list) {
  return [...list].sort((a, b) => String(a.printerName || '').localeCompare(String(b.printerName || '')))
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

      const map = new Map()

      for (const item of installed) {
        const name = normalizeName(pick(item, ['name', 'printerName', 'Name']))
        if (!name) continue

        const driverName = String(pick(item, ['driverName', 'DriverName']))
        const portName = String(pick(item, ['portName', 'PortName']))
        if (isVirtualPrinterRecord({ printerName: name, driverName, portName })) continue

        const driverObj = item?.driver || item?.Driver || null
        const previous = previousMap.get(name)
        map.set(name, withDerivedAvailability({
          printerName: name,
          installed: true,
          backup: false,
          portName,
          portHostAddress: '',
          driverName,
          manufacturer: String(pick(driverObj, ['manufacturer', 'Manufacturer'])),
          driverVersion: String(pick(driverObj, ['driverVersion', 'DriverVersion'])),
          systemInfPath: String(pick(driverObj, ['infPath', 'InfPath'])),
          infRelativePath: '',
          printerStatus: pick(item, ['printerStatus', 'PrinterStatus'], ''),
          workOffline: toBool(pick(item, ['workOffline', 'WorkOffline'], false)),
          runtimeAvailability: String(previous?.runtimeAvailability || ''),
        }))
      }

      for (const entry of indexEntries) {
        const name = normalizeName(pick(entry, ['printerName', 'name', 'Name']))
        if (!name) continue

        const entryDriverName = String(pick(entry, ['driverName', 'DriverName']))
        const entryPortName = String(pick(entry, ['portName', 'PortName']))
        if (isVirtualPrinterRecord({ printerName: name, driverName: entryDriverName, portName: entryPortName })) continue

        const existing = map.get(name)
        if (existing) {
          map.set(name, withDerivedAvailability({
            ...existing,
            backup: true,
            driverName: existing.driverName || entryDriverName,
            portHostAddress: existing.portHostAddress || String(pick(entry, ['portHostAddress', 'PortHostAddress'])),
            manufacturer: existing.manufacturer || String(pick(entry, ['manufacturer', 'Manufacturer'])),
            driverVersion: existing.driverVersion || String(pick(entry, ['driverVersion', 'DriverVersion'])),
            systemInfPath: existing.systemInfPath || '',
            infRelativePath: String(pick(entry, ['infRelativePath', 'InfRelativePath'])),
          }))
        } else {
          const previous = previousMap.get(name)
          map.set(name, withDerivedAvailability({
            printerName: name,
            installed: false,
            backup: true,
            portName: entryPortName,
            portHostAddress: String(pick(entry, ['portHostAddress', 'PortHostAddress'])),
            driverName: entryDriverName,
            manufacturer: String(pick(entry, ['manufacturer', 'Manufacturer'])),
            driverVersion: String(pick(entry, ['driverVersion', 'DriverVersion'])),
            systemInfPath: '',
            infRelativePath: String(pick(entry, ['infRelativePath', 'InfRelativePath'])),
            printerStatus: '',
            workOffline: false,
            runtimeAvailability: String(previous?.runtimeAvailability || ''),
          }))
        }
      }

      this.settings = {
        ...this.settings,
        backupDir: String(payload?.backupDir || this.settings.backupDir || ''),
      }
      this.PrinterServerManage = {
        ...this.PrinterServerManage,
        printers: sortPrinters([...map.values()]),
      }
      this.lastSyncAt = new Date().toISOString()
    },
    setPrinterRuntimeState(state = {}) {
      const currentPrinters = Array.isArray(this.PrinterServerManage?.printers) ? this.PrinterServerManage.printers : []
      const runtimePrinters = Array.isArray(state?.printers) ? state.printers : []
      const map = new Map(currentPrinters.map((item) => [normalizeName(item?.printerName), { ...item }]))

      for (const runtimeItem of runtimePrinters) {
        const name = normalizeName(pick(runtimeItem, ['name', 'printerName', 'Name']))
        if (!name) continue

        const runtimeDriverName = String(pick(runtimeItem, ['driverName', 'DriverName']))
        const runtimePortName = String(pick(runtimeItem, ['portName', 'PortName']))
        if (isVirtualPrinterRecord({ printerName: name, driverName: runtimeDriverName, portName: runtimePortName })) continue

        const existing = map.get(name)
        if (existing) {
          map.set(name, withDerivedAvailability({
            ...existing,
            installed: true,
            printerStatus: pick(runtimeItem, ['printerStatus', 'PrinterStatus'], existing.printerStatus),
            workOffline: toBool(pick(runtimeItem, ['workOffline', 'WorkOffline'], existing.workOffline)),
            portName: existing.portName || runtimePortName,
            driverName: existing.driverName || runtimeDriverName,
            runtimeAvailability: String(pick(runtimeItem, ['availability', 'Availability'], existing.runtimeAvailability || '')),
          }))
        } else {
          map.set(name, withDerivedAvailability({
            printerName: name,
            installed: true,
            backup: false,
            portName: runtimePortName,
            portHostAddress: '',
            driverName: runtimeDriverName,
            manufacturer: '',
            driverVersion: '',
            systemInfPath: '',
            infRelativePath: '',
            printerStatus: pick(runtimeItem, ['printerStatus', 'PrinterStatus'], ''),
            workOffline: toBool(pick(runtimeItem, ['workOffline', 'WorkOffline'], false)),
            runtimeAvailability: String(pick(runtimeItem, ['availability', 'Availability'], '')),
          }))
        }
      }

      const removed = Array.isArray(state?.changes?.removedPrinters) ? state.changes.removedPrinters : []
      for (const removedNameRaw of removed) {
        const removedName = normalizeName(removedNameRaw)
        if (!removedName) continue
        const existing = map.get(removedName)
        if (!existing) continue
        if (existing.backup) {
          map.set(removedName, withDerivedAvailability({
            ...existing,
            installed: false,
            printerStatus: '',
            workOffline: false,
            runtimeAvailability: '',
          }))
        } else {
          map.delete(removedName)
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
        printers: sortPrinters([...map.values()]),
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
