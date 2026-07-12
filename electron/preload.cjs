const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('eleDrive', {
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  getVirtualPrinterConfig: () => ipcRenderer.invoke('settings:get-virtual-printer-config'),
  setVirtualPrinterConfig: (payload) => ipcRenderer.invoke('settings:set-virtual-printer-config', payload),
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
  getPrintServiceState: () => ipcRenderer.invoke('print:service:get-state'),
  setPrintServiceEnabled: (payload) => ipcRenderer.invoke('print:service:set-enabled', payload),
  getPrintClientInfo: () => ipcRenderer.invoke('print:service:get-client-info'),
  getPrintPrinterList: () => ipcRenderer.invoke('print:service:get-printer-list'),
  listPrintJobs: () => ipcRenderer.invoke('print:service:list-jobs'),
  getPrintJob: (payload) => ipcRenderer.invoke('print:service:get-job', payload),
  submitPrintJob: (payload) => ipcRenderer.invoke('print:service:submit-job', payload),
  reprintJob: (payload) => ipcRenderer.invoke('print:service:reprint', payload),
  listInstalledPrinters: () => ipcRenderer.invoke('printers:list-installed'),
  getPrinterSnapshot: () => ipcRenderer.invoke('printers:snapshot:get'),
  listUsbPrinterPorts: () => ipcRenderer.invoke('printers:list-usb-ports'),
  getPrinterRuntimeState: () => ipcRenderer.invoke('printers:state:get'),
  openSystemAddPrinterWizard: () => ipcRenderer.invoke('printers:open-system-add-wizard'),
  openPrinterProperties: (payload) => ipcRenderer.invoke('printers:open-properties', payload),
  openPrinterPreferences: (payload) => ipcRenderer.invoke('printers:open-preferences', payload),
  renamePrinter: (payload) => ipcRenderer.invoke('printers:rename', payload),
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
  onPrintServiceStateUpdated: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_, payload) => handler(payload)
    ipcRenderer.on('print:service:state-updated', listener)
    return () => ipcRenderer.removeListener('print:service:state-updated', listener)
  },
  onPrintJobUpdated: (handler) => {
    if (typeof handler !== 'function') return () => {}
    const listener = (_, payload) => handler(payload)
    ipcRenderer.on('print:job-updated', listener)
    return () => ipcRenderer.removeListener('print:job-updated', listener)
  },
})
