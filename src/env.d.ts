/// <reference types="vite/client" />

interface EleDriveSettings {
  backupDir: string
  themeMode: ThemeMode
}
type ThemeMode = 'light' | 'dark' | 'system'

interface InstalledPrinter {
  name: string
  driverName: string
  portName: string
  shared: boolean
  shareName?: string
  driver?: {
    name: string
    manufacturer?: string
    majorVersion?: number
    driverVersion?: string
    infPath?: string
    environment?: string
  } | null
}

interface DriverBackupResult {
  printerName: string
  driverName: string
  infPath?: string
  backupDir: string
  method: string
}

interface Window {
  eleDrive?: {
    getAppVersion: () => Promise<string>
    getSettings: () => Promise<EleDriveSettings>
    setBackupDir: (backupDir: string) => Promise<EleDriveSettings>
    setThemeMode: (themeMode: ThemeMode) => Promise<EleDriveSettings>
    chooseBackupDir: () => Promise<string | null>
    listInstalledPrinters: () => Promise<InstalledPrinter[]>
    backupPrinterDriver: (payload: {
      printerName: string
      backupDir?: string
    }) => Promise<DriverBackupResult>
  }
}
