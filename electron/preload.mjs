import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('eleDrive', {
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setBackupDir: (backupDir) => ipcRenderer.invoke('settings:set-backup-dir', backupDir),
  setThemeMode: (themeMode) => ipcRenderer.invoke('settings:set-theme-mode', themeMode),
  chooseBackupDir: () => ipcRenderer.invoke('settings:choose-backup-dir'),
  listInstalledPrinters: () => ipcRenderer.invoke('printers:list-installed'),
  backupPrinterDriver: (payload) => ipcRenderer.invoke('printers:backup-driver', payload),
  installPrinter: (payload) => ipcRenderer.invoke('printers:install', payload),
  uninstallPrinter: (payload) => ipcRenderer.invoke('printers:uninstall', payload),
  getDriverIndex: () => ipcRenderer.invoke('drivers:index:get'),
})
