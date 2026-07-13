/// <reference types="vite/client" />

interface EleDriveSettings {
  backupDir: string
  themeMode: ThemeMode
  lanEnabled?: boolean
  printServiceEnabled?: boolean
  printServicePort?: number
  feature?: {
    backup?: {
      archiveEnabled?: boolean
    }
    lan?: {
      discoveryEnabled?: boolean
      transferEnabled?: boolean
      autoInstallEnabled?: boolean
    }
  }
}
type ThemeMode = 'light' | 'dark' | 'system'

interface LanNode {
  nodeId: string
  machineName: string
  appVersion: string
  arch: string
  host: string
  servicePort: number
  online: boolean
  lastSeenAt: string
}

interface RemotePrinterOffer {
  offerId: string
  nodeId: string
  printerName: string
  driverName: string
  driverVersion: string
  environment: string
  identityKey: string
  archiveFormat: string
  archiveSha256: string
  archiveSize: number
}

interface LanTask {
  taskId: string
  type: string
  status: string
  progress: number
  nodeId: string
  offerId: string
  errorCode: string
  errorMessage: string
  updatedAt: string
}

interface LanPairState {
  trustedCount: number
  blockedCount: number
  pendingCount: number
}

interface LanRuntimeState {
  enabled: boolean
  startedAt: string
  nodeId: string
  machineName: string
  appVersion: string
  arch: string
  protocolVersion: string
  archiveVersion: string
  discoveryPort: number
  servicePort: number
  feature?: {
    backup?: {
      archiveEnabled?: boolean
    }
    lan?: {
      discoveryEnabled?: boolean
      transferEnabled?: boolean
      autoInstallEnabled?: boolean
    }
  }
  nodes: LanNode[]
  offers: RemotePrinterOffer[]
  tasks: LanTask[]
  pairState: LanPairState
  updatedAt: string
}

interface PrintServiceState {
  enabled: boolean
  port: number
  socketProtocolVersion: number
  running: boolean
  clients: number
  updatedAt: string
}

interface PrintJob {
  taskId: string
  templateId: string
  type: 'html' | 'pdf' | 'url_pdf' | 'blob_pdf' | 'render-jpeg' | 'render-pdf' | 'render-print'
  status: 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'CANCELED'
  printer: string
  errorCode: string
  errorMessage: string
  createdAt: string
  updatedAt: string
}

type AppUpdatePhase =
  | 'idle'
  | 'unsupported'
  | 'checking'
  | 'available'
  | 'not-available'
  | 'downloading'
  | 'downloaded'
  | 'installing'
  | 'error'

interface AppUpdateProgress {
  percent: number
  transferred: number
  total: number
  bytesPerSecond: number
}

interface AppUpdateStatus {
  phase: AppUpdatePhase
  currentVersion: string
  availableVersion?: string
  releaseDate?: string
  releaseName?: string
  releaseNotes?: string
  progress?: AppUpdateProgress | null
  errorText?: string
  isPackaged: boolean
  platform: string
  updatedAt: string
}

interface VirtualPrinterConfig {
  keywords: string[]
  exactPorts: string[]
  prefixPorts: string[]
  containsPorts: string[]
}

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
    getUpdateStatus: () => Promise<AppUpdateStatus>
    checkForUpdates: () => Promise<AppUpdateStatus>
    downloadUpdate: () => Promise<AppUpdateStatus>
    quitAndInstallUpdate: () => Promise<AppUpdateStatus>
    getSettings: () => Promise<EleDriveSettings>
    getVirtualPrinterConfig: () => Promise<VirtualPrinterConfig>
    setVirtualPrinterConfig: (payload: Partial<VirtualPrinterConfig>) => Promise<VirtualPrinterConfig>
    setBackupDir: (backupDir: string) => Promise<EleDriveSettings>
    setThemeMode: (themeMode: ThemeMode) => Promise<EleDriveSettings>
    chooseBackupDir: () => Promise<string | null>
    openBackupDir: () => Promise<{
      path: string
      opened: boolean
    }>
    getLanState: () => Promise<LanRuntimeState>
    setLanEnabled: (payload: { enabled: boolean }) => Promise<{
      enabled: boolean
      startedAt?: string
    }>
    listLanNodes: () => Promise<LanNode[]>
    listLanOffers: () => Promise<RemotePrinterOffer[]>
    requestLanInstall: (payload: {
      nodeId: string
      offerId: string
      targetPrinterName?: string
    }) => Promise<{
      taskId: string
      status: string
    }>
    getLanTask: (payload: { taskId: string }) => Promise<LanTask>
    cancelLanTask: (payload: { taskId: string }) => Promise<LanTask>
    getPrintServiceState: () => Promise<PrintServiceState>
    setPrintServiceEnabled: (payload: {
      enabled: boolean
      port?: number
      authToken?: string
    }) => Promise<PrintServiceState>
    getPrintClientInfo: () => Promise<{
      machineName: string
      appVersion: string
      arch: string
      socketProtocolVersion: number
      running: boolean
      port: number
      updatedAt: string
    }>
    getPrintPrinterList: () => Promise<Array<{
      name: string
      driverName: string
      portName: string
      printerStatus?: string | number
      workOffline?: boolean
      shared?: boolean
      shareName?: string
    }>>
    listPrintJobs: () => Promise<PrintJob[]>
    getPrintJob: (payload: { taskId: string }) => Promise<PrintJob>
    submitPrintJob: (payload: {
      templateId?: string
      type: PrintJob['type']
      printer?: string
      options?: Record<string, unknown>
    }) => Promise<PrintJob>
    reprintJob: (payload: { taskId: string }) => Promise<PrintJob>
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
    renamePrinter: (payload: { printerName: string, newPrinterName: string }) => Promise<{
      status: string
      printerName: string
      newPrinterName: string
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
    onUpdateStatusChanged: (handler: (payload: AppUpdateStatus | null) => void) => () => void
    onPrinterStateUpdated: (handler: (payload: PrinterRuntimeState | null) => void) => () => void
    onPrinterSnapshotUpdated: (handler: (payload: PrinterSnapshotPayload | null) => void) => () => void
    onLanStateUpdated: (handler: (payload: LanRuntimeState | null) => void) => () => void
    onPrintServiceStateUpdated: (handler: (payload: PrintServiceState | null) => void) => () => void
    onPrintJobUpdated: (handler: (payload: PrintJob | null) => void) => () => void
  }
}
