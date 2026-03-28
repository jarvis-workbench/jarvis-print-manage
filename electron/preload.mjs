import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('eleDrive', {
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setBackupDir: (backupDir) => ipcRenderer.invoke('settings:set-backup-dir', backupDir),
  setThemeMode: (themeMode) => ipcRenderer.invoke('settings:set-theme-mode', themeMode),
  chooseBackupDir: () => ipcRenderer.invoke('settings:choose-backup-dir'),
  openBackupDir: () => ipcRenderer.invoke('settings:open-backup-dir'),
  getLanState: () => ipcRenderer.invoke('lan:get-state'),
  setLanEnabled: (payload) => ipcRenderer.invoke('lan:set-enabled', payload),
  listLanNodes: () => ipcRenderer.invoke('lan:list-nodes'),
  listLanOffers: () => ipcRenderer.invoke('lan:list-offers'),
  requestLanInstall: (payload) => ipcRenderer.invoke('lan:request-install', payload),
  getLanTask: (payload) => ipcRenderer.invoke('lan:get-task', payload),
  cancelLanTask: (payload) => ipcRenderer.invoke('lan:cancel-task', payload),
  listInstalledPrinters: () => ipcRenderer.invoke('printers:list-installed'),
  getPrinterSnapshot: () => ipcRenderer.invoke('printers:snapshot:get'),
  listUsbPrinterPorts: () => ipcRenderer.invoke('printers:list-usb-ports'),
  getPrinterRuntimeState: () => ipcRenderer.invoke('printers:state:get'),
  openSystemAddPrinterWizard: () => ipcRenderer.invoke('printers:open-system-add-wizard'),
  openPrinterProperties: (payload) => ipcRenderer.invoke('printers:open-properties', payload),
  openPrinterPreferences: (payload) => ipcRenderer.invoke('printers:open-preferences', payload),
  backupPrinterDriver: (payload) => ipcRenderer.invoke('printers:backup-driver', payload),
  installPrinter: (payload) => ipcRenderer.invoke('printers:install', payload),
  pingHost: (payload) => ipcRenderer.invoke('printers:ping-host', payload),
  uninstallPrinter: (payload) => ipcRenderer.invoke('printers:uninstall', payload),
  printTestPage: (payload) => ipcRenderer.invoke('printers:print-test-page', payload),
  deleteBackupDriver: (payload) => ipcRenderer.invoke('printers:backup-delete', payload),
  getDriverIndex: () => ipcRenderer.invoke('drivers:index:get'),
  onTrayNavigate: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_, payload) => handler(payload)
    ipcRenderer.on('app:navigate', listener)
    return () => ipcRenderer.removeListener('app:navigate', listener)
  },
  onPrinterStateUpdated: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_, payload) => handler(payload)
    ipcRenderer.on('printers:state-updated', listener)
    return () => ipcRenderer.removeListener('printers:state-updated', listener)
  },
  onPrinterSnapshotUpdated: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_, payload) => handler(payload)
    ipcRenderer.on('printers:snapshot-updated', listener)
    return () => ipcRenderer.removeListener('printers:snapshot-updated', listener)
  },
  onLanStateUpdated: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_, payload) => handler(payload)
    ipcRenderer.on('lan:state-updated', listener)
    return () => ipcRenderer.removeListener('lan:state-updated', listener)
  },
})
