import { defineStore } from 'pinia'

const DEFAULT_THEME_MODE = 'system'

export const useRuntimeStore = defineStore('runtime', {
  state: () => ({
    settingsLoaded: false,
    settings: {
      backupDir: '',
      themeMode: DEFAULT_THEME_MODE,
    },
    installedPrinters: [],
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
    setInstalledPrinters(list = []) {
      this.installedPrinters = Array.isArray(list) ? list : []
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
      this.installedPrinters = []
      this.usbPorts = []
      this.lastSyncAt = ''
    },
  },
})
