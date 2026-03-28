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
  archiveFileName?: string
  archiveRelativePath?: string
  archiveSha256?: string
  archiveSize?: number
  archiveFormat?: string
  extractPolicy?: 'cleanup-on-success' | 'keep-on-fail'
}

interface DriverIndexEntry {
  printerName: string
  driverName: string
  driverVersion: string
  manufacturer: string
  infRelativePath: string
  backupAt: string
  portName: string
  portHostAddress: string
  portNumber: string
  environment: string
  archiveFileName: string
  archiveRelativePath: string
  archiveSha256: string
  archiveSize: number
  archiveFormat: 'pdrv.zip' | ''
  extractPolicy: 'cleanup-on-success' | 'keep-on-fail'
}

interface PrinterSnapshotPayload {
  updatedAt: string
  backupDir: string
  installedPrinters: InstalledPrinter[]
  driverIndexEntries: DriverIndexEntry[]
}

interface PrinterRuntimeItem {
  name: string
  driverName: string
  portName: string
  printerStatus?: string | number
  workOffline?: boolean
  shared?: boolean
  shareName?: string
  availability?: 'ready' | 'offline'
}

interface PrinterPortRuntimeItem {
  name: string
  printerHostAddress?: string
  portNumber?: string
}

interface PrinterRuntimeState {
  seq: number
  changedAt: string
  spooler: string
  printers: PrinterRuntimeItem[]
  ports: PrinterPortRuntimeItem[]
  changes?: {
    addedPrinters?: string[]
    removedPrinters?: string[]
    changedPrinters?: string[]
    addedPorts?: string[]
    removedPorts?: string[]
  }
}

interface Window {
  eleDrive?: {
    getAppVersion: () => Promise<string>
    getSettings: () => Promise<EleDriveSettings>
    setBackupDir: (backupDir: string) => Promise<EleDriveSettings>
    setThemeMode: (themeMode: ThemeMode) => Promise<EleDriveSettings>
    chooseBackupDir: () => Promise<string | null>
    openBackupDir: () => Promise<{
      path: string
      opened: boolean
    }>
    listInstalledPrinters: () => Promise<InstalledPrinter[]>
    getPrinterSnapshot: () => Promise<PrinterSnapshotPayload>
    listUsbPrinterPorts: () => Promise<string[]>
    getPrinterRuntimeState: () => Promise<PrinterRuntimeState>
    openSystemAddPrinterWizard: () => Promise<{ status: string }>
    openPrinterProperties: (payload: { printerName: string }) => Promise<{
      status: string
      printerName: string
      dialog?: string
    }>
    openPrinterPreferences: (payload: { printerName: string }) => Promise<{
      status: string
      printerName: string
      dialog?: string
    }>
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
    printTestPage: (payload: { printerName: string }) => Promise<{
      status: string
      printerName: string
      returnValue?: number | null
    }>
    deleteBackupDriver: (payload: { printerName: string }) => Promise<{
      status: string
      printerName: string
      archiveRelativePath?: string
      archiveDeleted?: boolean
    }>
    getDriverIndex: () => Promise<{
      backupDir: string
      index: {
        version: number
        updatedAt: string
        entries: DriverIndexEntry[]
      }
    }>
    onTrayNavigate: (handler: (payload: { path?: string } | null) => void) => () => void
    onPrinterStateUpdated: (handler: (payload: PrinterRuntimeState | null) => void) => () => void
    onPrinterSnapshotUpdated: (handler: (payload: PrinterSnapshotPayload | null) => void) => () => void
  }
}
