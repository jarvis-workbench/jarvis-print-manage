const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('eleDrive', {
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setBackupDir: (backupDir) => ipcRenderer.invoke('settings:set-backup-dir', backupDir),
  setThemeMode: (themeMode) => ipcRenderer.invoke('settings:set-theme-mode', themeMode),
  chooseBackupDir: () => ipcRenderer.invoke('settings:choose-backup-dir'),
  openBackupDir: () => ipcRenderer.invoke('settings:open-backup-dir'),
  listInstalledPrinters: () => ipcRenderer.invoke('printers:list-installed'),
  listUsbPrinterPorts: () => ipcRenderer.invoke('printers:list-usb-ports'),
  getPrinterRuntimeState: () => ipcRenderer.invoke('printers:state:get'),
  openSystemAddPrinterWizard: () => ipcRenderer.invoke('printers:open-system-add-wizard'),
  backupPrinterDriver: (payload) => ipcRenderer.invoke('printers:backup-driver', payload),
  installPrinter: (payload) => ipcRenderer.invoke('printers:install', payload),
  pingHost: (payload) => ipcRenderer.invoke('printers:ping-host', payload),
  uninstallPrinter: (payload) => ipcRenderer.invoke('printers:uninstall', payload),
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
})
