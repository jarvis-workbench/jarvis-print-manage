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
  printerStatus?: string | number
  workOffline?: boolean
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
  driverVersion?: string
  manufacturer?: string
  environment?: string
  portName?: string
  infRelativePath?: string
  backupAt?: string
  infPath?: string
  backupDir: string
  method: string
}

interface DriverIndexEntry {
  printerName: string
  driverName: string
  driverVersion: string
  manufacturer: string
  infRelativePath: string
  backupSubDir: string
  backupAt: string
  portName: string
  portHostAddress: string
  portNumber: string
  environment: string
}

interface Window {
  eleDrive?: {
    getAppVersion: () => Promise<string>
    getSettings: () => Promise<EleDriveSettings>
    setBackupDir: (backupDir: string) => Promise<EleDriveSettings>
    setThemeMode: (themeMode: ThemeMode) => Promise<EleDriveSettings>
    chooseBackupDir: () => Promise<string | null>
    listInstalledPrinters: () => Promise<InstalledPrinter[]>
    listUsbPrinterPorts: () => Promise<string[]>
    openSystemAddPrinterWizard: () => Promise<{ status: string }>
    backupPrinterDriver: (payload: {
      printerName: string
      backupDir?: string
    }) => Promise<DriverBackupResult>
    installPrinter: (payload: {
      printerName: string
      targetPrinterName?: string
      portHostAddressOverride?: string
    }) => Promise<{
      status: string
      printerName: string
      driverName?: string
      portName?: string
    }>
    pingHost: (payload: { host: string }) => Promise<{
      reachable: boolean
      output?: string
    }>
    uninstallPrinter: (payload: { printerName: string }) => Promise<{
      status: string
      printerName: string
      driverName?: string
      driverRemoved?: boolean
      driverRemoveError?: string
      portName?: string
      portRemoved?: boolean
      portRemoveError?: string
      fileRepoResidues?: string[]
      spoolResidues?: string[]
    }>
    getDriverIndex: () => Promise<{
      backupDir: string
      index: {
        version: number
        updatedAt: string
        entries: DriverIndexEntry[]
      }
    }>
  }
}
