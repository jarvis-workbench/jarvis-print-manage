import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('eleDrive', {
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setBackupDir: (backupDir) => ipcRenderer.invoke('settings:set-backup-dir', backupDir),
  setThemeMode: (themeMode) => ipcRenderer.invoke('settings:set-theme-mode', themeMode),
  chooseBackupDir: () => ipcRenderer.invoke('settings:choose-backup-dir'),
  listInstalledPrinters: () => ipcRenderer.invoke('printers:list-installed'),
  listUsbPrinterPorts: () => ipcRenderer.invoke('printers:list-usb-ports'),
  openSystemAddPrinterWizard: () => ipcRenderer.invoke('printers:open-system-add-wizard'),
  backupPrinterDriver: (payload) => ipcRenderer.invoke('printers:backup-driver', payload),
  installPrinter: (payload) => ipcRenderer.invoke('printers:install', payload),
  pingHost: (payload) => ipcRenderer.invoke('printers:ping-host', payload),
  uninstallPrinter: (payload) => ipcRenderer.invoke('printers:uninstall', payload),
  getDriverIndex: () => ipcRenderer.invoke('drivers:index:get'),
})
