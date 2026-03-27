import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('eleDrive', {
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
})
