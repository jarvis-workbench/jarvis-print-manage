import { app, dialog, ipcMain, shell } from 'electron'

export class AppIpcRouter {
  constructor(context) {
    this.context = context
  }

  register() {
    const {
      appShell,
      applyLanSettings,
      applyPrintServiceSettings,
      backupPrinterDriver,
      broadcastLanState,
      deleteBackupDriver,
      ensureBackupIndex,
      ensureLanRuntime,
      ensurePrintSocketService,
      ensureUpdateManager,
      ensureWritableBackupDir,
      filterVirtualOffersFromLanState,
      filterVirtualPrinterRows,
      getInstalledPrinters,
      getPrinterRuntimeState,
      getPrinterSnapshotState,
      getVirtualPrinterConfigCache,
      installPrinterFromBackup,
      listUsbPrinterPorts,
      openPrinterPreferencesDialog,
      openPrinterPropertiesDialog,
      openSystemAddPrinterWizard,
      pingHost,
      printPrinterTestPage,
      readSettings,
      refreshPrinterSnapshot,
      renameInstalledPrinter,
      requestPrinterStateRefresh,
      setVirtualPrinterConfigCache,
      themeModes,
      toBool,
      uninstallPrinter,
      updatePrinterStateWorkerConfig,
      writeSettings,
      writeVirtualPrinterConfig,
    } = this.context
    const upsertIpcHandler = (channel, handler) => this.upsertIpcHandler(channel, handler)

    upsertIpcHandler('app:get-version', () => app.getVersion())
    upsertIpcHandler('updates:get-status', async () => ensureUpdateManager().getStatus())
    upsertIpcHandler('updates:check-for-updates', async () => ensureUpdateManager().checkForUpdates())
    upsertIpcHandler('updates:download-update', async () => ensureUpdateManager().downloadUpdate())
    upsertIpcHandler('updates:quit-and-install', async () => {
      const manager = ensureUpdateManager()
      if (manager.getStatus()?.phase !== 'downloaded') {
        return manager.quitAndInstall()
      }
      appShell.markQuitting()
      return manager.quitAndInstall()
    })

    upsertIpcHandler('settings:get', async () => readSettings())
    upsertIpcHandler('settings:get-virtual-printer-config', async () => ({
      ...getVirtualPrinterConfigCache(),
    }))
    upsertIpcHandler('settings:set-backup-dir', async (_, backupDir) => {
      if (!backupDir || typeof backupDir !== 'string') {
        throw new Error('Invalid backup directory path.')
      }
      const writableBackupDir = await ensureWritableBackupDir(backupDir)
      const saved = await writeSettings({ backupDir: writableBackupDir })
      await ensureBackupIndex(saved.backupDir)
      updatePrinterStateWorkerConfig({ backupDir: saved.backupDir })
      requestPrinterStateRefresh()
      await refreshPrinterSnapshot({ broadcast: true })
      return saved
    })
    upsertIpcHandler('settings:set-virtual-printer-config', async (_, payload) => {
      const savedConfig = await writeVirtualPrinterConfig(payload || {})
      setVirtualPrinterConfigCache(savedConfig)
      updatePrinterStateWorkerConfig({
        backupDir: getPrinterSnapshotState().backupDir,
        virtualPrinterConfig: savedConfig,
      })
      requestPrinterStateRefresh()
      await refreshPrinterSnapshot({ broadcast: true })
      broadcastLanState()
      return {
        ...savedConfig,
      }
    })
    upsertIpcHandler('settings:set-theme-mode', async (_, themeMode) => {
      if (!themeModes.has(themeMode)) {
        throw new Error('Invalid theme mode.')
      }
      return writeSettings({ themeMode })
    })
    upsertIpcHandler('settings:choose-backup-dir', async () => {
      const result = await dialog.showOpenDialog({
        title: '选择打印机驱动备份目录',
        properties: ['openDirectory', 'createDirectory'],
      })
      if (result.canceled || !result.filePaths?.[0]) {
        return null
      }
      return result.filePaths[0]
    })
    upsertIpcHandler('settings:open-backup-dir', async () => {
      const settings = await readSettings()
      const backupDir = await ensureWritableBackupDir(settings?.backupDir)
      if (!backupDir) {
        throw new Error('备份目录未配置')
      }
      const openResult = await shell.openPath(backupDir)
      if (openResult) {
        throw new Error(openResult)
      }
      return {
        path: backupDir,
        opened: true,
      }
    })

    upsertIpcHandler('lan:get-state', async () => {
      const runtime = ensureLanRuntime()
      return filterVirtualOffersFromLanState(runtime.getState(), getVirtualPrinterConfigCache())
    })
    upsertIpcHandler('lan:set-enabled', async (_, payload) => {
      const enabled = toBool(payload?.enabled, false)
      const saved = await writeSettings({ lanEnabled: enabled })
      const state = await applyLanSettings(saved)
      return {
        enabled: state.enabled,
        startedAt: state.startedAt,
      }
    })
    upsertIpcHandler('lan:list-nodes', async () => {
      const runtime = ensureLanRuntime()
      return runtime.listNodes()
    })
    upsertIpcHandler('lan:list-offers', async () => {
      const runtime = ensureLanRuntime()
      if (typeof runtime.syncOffers === 'function') {
        await runtime.syncOffers()
      }
      return filterVirtualPrinterRows(runtime.listOffers(), getVirtualPrinterConfigCache())
    })
    upsertIpcHandler('lan:request-install', async (_, payload) => {
      const runtime = ensureLanRuntime()
      const task = await runtime.requestInstall(payload || {})
      return {
        taskId: task.taskId,
        status: task.status,
      }
    })
    upsertIpcHandler('lan:get-task', async (_, payload) => {
      const runtime = ensureLanRuntime()
      return runtime.getTask(payload?.taskId)
    })
    upsertIpcHandler('lan:cancel-task', async (_, payload) => {
      const runtime = ensureLanRuntime()
      return runtime.cancelTask(payload?.taskId)
    })

    upsertIpcHandler('print:service:get-state', async () => {
      const runtime = ensurePrintSocketService()
      return runtime.getState()
    })
    upsertIpcHandler('print:service:set-enabled', async (_, payload) => {
      const enabled = toBool(payload?.enabled, false)
      const saved = await writeSettings({
        printServiceEnabled: enabled,
        printServicePort: payload?.port,
        printServiceAuthToken: payload?.authToken,
      })
      return applyPrintServiceSettings(saved)
    })
    upsertIpcHandler('print:service:get-client-info', async () => {
      const runtime = ensurePrintSocketService()
      return runtime.getClientInfo()
    })
    upsertIpcHandler('print:service:get-printer-list', async () => {
      const runtime = ensurePrintSocketService()
      return runtime.getPrinterList()
    })
    upsertIpcHandler('print:service:list-jobs', async () => {
      const runtime = ensurePrintSocketService()
      return runtime.listJobs()
    })
    upsertIpcHandler('print:service:get-job', async (_, payload) => {
      const runtime = ensurePrintSocketService()
      return runtime.getJob(payload?.taskId)
    })
    upsertIpcHandler('print:service:submit-job', async (_, payload) => {
      const runtime = ensurePrintSocketService()
      return runtime.submitJob(payload || {})
    })
    upsertIpcHandler('print:service:reprint', async (_, payload) => {
      const runtime = ensurePrintSocketService()
      return runtime.reprint(payload?.taskId)
    })

    upsertIpcHandler('printers:list-installed', async () => getInstalledPrinters())
    upsertIpcHandler('printers:snapshot:get', async () => {
      if (!getPrinterSnapshotState().updatedAt) {
        await refreshPrinterSnapshot({ broadcast: false })
      }
      return {
        ...getPrinterSnapshotState(),
      }
    })
    upsertIpcHandler('printers:list-usb-ports', async () => listUsbPrinterPorts())
    upsertIpcHandler('printers:state:get', async () => ({ ...getPrinterRuntimeState() }))
    upsertIpcHandler('printers:open-system-add-wizard', async () => openSystemAddPrinterWizard())
    upsertIpcHandler('printers:open-properties', async (_, payload) => {
      if (!payload?.printerName || typeof payload.printerName !== 'string') {
        throw new Error('Invalid printer name.')
      }
      return openPrinterPropertiesDialog({
        printerName: payload.printerName,
      })
    })
    upsertIpcHandler('printers:open-preferences', async (_, payload) => {
      if (!payload?.printerName || typeof payload.printerName !== 'string') {
        throw new Error('Invalid printer name.')
      }
      return openPrinterPreferencesDialog({
        printerName: payload.printerName,
      })
    })
    upsertIpcHandler('printers:rename', async (_, payload) => {
      if (!payload?.printerName || typeof payload.printerName !== 'string') {
        throw new Error('Invalid printer name.')
      }
      if (!payload?.newPrinterName || typeof payload.newPrinterName !== 'string') {
        throw new Error('Invalid new printer name.')
      }
      const result = await renameInstalledPrinter({
        printerName: payload.printerName,
        newPrinterName: payload.newPrinterName,
      })
      requestPrinterStateRefresh()
      await refreshPrinterSnapshot({ broadcast: true })
      return result
    })
    upsertIpcHandler('printers:backup-driver', async (_, payload) => {
      if (!payload?.printerName || typeof payload.printerName !== 'string') {
        throw new Error('Invalid printer name.')
      }
      const settings = await readSettings()
      const result = await backupPrinterDriver({
        printerName: payload.printerName,
        backupDir: payload.backupDir || settings.backupDir,
      })
      await refreshPrinterSnapshot({ broadcast: true })
      return result
    })
    upsertIpcHandler('printers:install', async (_, payload) => {
      if (!payload?.printerName || typeof payload.printerName !== 'string') {
        throw new Error('Invalid printer name.')
      }
      const settings = await readSettings()
      const result = await installPrinterFromBackup({
        printerName: payload.printerName,
        backupDir: settings.backupDir,
        targetPrinterName: payload.targetPrinterName || '',
        portHostAddressOverride: payload.portHostAddressOverride || '',
      })
      requestPrinterStateRefresh()
      await refreshPrinterSnapshot({ broadcast: true })
      return result
    })
    upsertIpcHandler('printers:ping-host', async (_, payload) => {
      const host = String(payload?.host || '').trim()
      if (!host) {
        throw new Error('Invalid host.')
      }
      return pingHost(host)
    })
    upsertIpcHandler('printers:uninstall', async (_, payload) => {
      if (!payload?.printerName || typeof payload.printerName !== 'string') {
        throw new Error('Invalid printer name.')
      }
      const result = await uninstallPrinter({
        printerName: payload.printerName,
      })
      requestPrinterStateRefresh()
      await refreshPrinterSnapshot({ broadcast: true })
      return result
    })
    upsertIpcHandler('printers:print-test-page', async (_, payload) => {
      if (!payload?.printerName || typeof payload.printerName !== 'string') {
        throw new Error('Invalid printer name.')
      }
      return printPrinterTestPage({
        printerName: payload.printerName,
      })
    })
    upsertIpcHandler('printers:backup-delete', async (_, payload) => {
      if (!payload?.printerName || typeof payload.printerName !== 'string') {
        throw new Error('Invalid printer name.')
      }
      const settings = await readSettings()
      const result = await deleteBackupDriver({
        printerName: payload.printerName,
        backupDir: settings.backupDir,
      })
      await refreshPrinterSnapshot({ broadcast: true })
      return result
    })

    upsertIpcHandler('drivers:index:get', async () => {
      if (!getPrinterSnapshotState().updatedAt) {
        await refreshPrinterSnapshot({ broadcast: false })
      }
      return {
        backupDir: getPrinterSnapshotState().backupDir,
        index: {
          version: 1,
          updatedAt: getPrinterSnapshotState().updatedAt,
          entries: printerSnapshotState.driverIndexEntries,
        },
      }
    })


  }

  upsertIpcHandler(channel, handler) {
    try {
      ipcMain.removeHandler(channel)
    } catch {}
    ipcMain.handle(channel, handler)
  }
}
