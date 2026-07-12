import http from 'node:http'
import os from 'node:os'
import { Server as SocketIOServer } from 'socket.io'
import { createPrintTaskOrchestrator } from './print-task-orchestrator.mjs'

const SOCKET_PROTOCOL_VERSION = 1
const DEFAULT_PORT = 17521
const DEFAULT_MAX_HTTP_BUFFER_SIZE = 2 * 1024 * 1024
const MAX_PAYLOAD_SIZE = 1024 * 1024

function nowIso() {
  return new Date().toISOString()
}

function toText(value) {
  return String(value ?? '').trim()
}

function toPositiveInt(value, fallback = 0) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return fallback
  return Math.trunc(num)
}

function parseProtocolVersion(value) {
  if (value === undefined || value === null || value === '') return SOCKET_PROTOCOL_VERSION
  const num = Number(value)
  if (!Number.isFinite(num)) return NaN
  return Math.trunc(num)
}

function normalizePort(value, fallback = DEFAULT_PORT) {
  const port = toPositiveInt(value, fallback)
  if (port < 1 || port > 65535) return fallback
  return port
}

function createPrintError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function normalizePrinterRecord(item = {}) {
  const name = toText(item?.name || item?.printerName)
  if (!name) return null
  return {
    name,
    driverName: toText(item?.driverName),
    portName: toText(item?.portName),
    printerStatus: item?.printerStatus ?? '',
    workOffline: item?.workOffline ?? false,
    shared: item?.shared ?? false,
    shareName: toText(item?.shareName),
  }
}

function normalizeSocketPayload(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value
  }
  return {}
}

function extractAck(args = []) {
  if (!Array.isArray(args) || args.length === 0) {
    return {
      payload: {},
      ack: null,
    }
  }
  const maybeAck = args[args.length - 1]
  if (typeof maybeAck === 'function') {
    return {
      payload: normalizeSocketPayload(args[0]),
      ack: maybeAck,
    }
  }
  return {
    payload: normalizeSocketPayload(args[0]),
    ack: null,
  }
}

function estimatePayloadBytes(payload) {
  try {
    return Buffer.byteLength(JSON.stringify(payload ?? null))
  } catch {
    return Infinity
  }
}

export function createPrintSocketService({
  appVersion = '',
  onListPrinters,
  onExecuteJob,
  onStateChanged,
  onJobUpdated,
  onError,
  port = DEFAULT_PORT,
  authToken = '',
  maxHttpBufferSize = DEFAULT_MAX_HTTP_BUFFER_SIZE,
} = {}) {
  const runtime = {
    enabled: false,
    running: false,
    startedAt: '',
    port: normalizePort(port),
    authToken: toText(authToken),
    appVersion: toText(appVersion),
    machineName: os.hostname() || 'unknown-host',
    arch: os.arch() === 'x64' ? 'x64' : 'x32',
    clients: new Map(),
    server: null,
    io: null,
    updatedAt: nowIso(),
  }

  const orchestrator = createPrintTaskOrchestrator({
    onJobUpdated: (job) => {
      if (typeof onJobUpdated === 'function') {
        onJobUpdated(job)
      }
    },
  })

  function getState() {
    return {
      enabled: runtime.enabled,
      port: runtime.port,
      socketProtocolVersion: SOCKET_PROTOCOL_VERSION,
      running: runtime.running,
      clients: runtime.clients.size,
      updatedAt: runtime.updatedAt,
    }
  }

  function emitState() {
    runtime.updatedAt = nowIso()
    if (typeof onStateChanged === 'function') {
      onStateChanged(getState())
    }
  }

  function emitError(error) {
    if (typeof onError === 'function') {
      onError(error)
    }
  }

  function buildClientInfo() {
    return {
      machineName: runtime.machineName,
      appVersion: runtime.appVersion,
      arch: runtime.arch,
      socketProtocolVersion: SOCKET_PROTOCOL_VERSION,
      running: runtime.running,
      port: runtime.port,
      updatedAt: nowIso(),
    }
  }

  async function getPrinterList() {
    if (typeof onListPrinters !== 'function') {
      return []
    }
    let list = []
    try {
      const data = await onListPrinters()
      list = Array.isArray(data) ? data : data ? [data] : []
    } catch (error) {
      throw createPrintError(
        toText(error?.code) || 'PRINT_PRINTER_UNAVAILABLE',
        toText(error?.message) || 'Unable to query printer list.',
      )
    }
    return list
      .map((item) => normalizePrinterRecord(item))
      .filter(Boolean)
      .sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')))
  }

  function emitSocketEvent(socket, eventName, payload, ack = null) {
    socket.emit(eventName, payload)
    if (typeof ack === 'function') {
      ack(payload)
    }
  }

  function createSocketErrorPayload(code, message, extra = {}) {
    return {
      code: toText(code) || 'PRINT_EXEC_FAILED',
      msg: toText(message) || 'Print service error.',
      timestamp: nowIso(),
      ...extra,
    }
  }

  function emitSocketError(socket, code, message, extra = {}, {
    eventName = 'error',
    ack = null,
  } = {}) {
    const payload = createSocketErrorPayload(code, message, extra)
    emitSocketEvent(socket, eventName, payload, ack)
    return payload
  }

  function assertPayloadSize(payload) {
    const bytes = estimatePayloadBytes(payload)
    if (!Number.isFinite(bytes)) {
      throw createPrintError('PAYLOAD_INVALID', 'Payload is not serializable.')
    }
    if (bytes > MAX_PAYLOAD_SIZE) {
      throw createPrintError('PAYLOAD_TOO_LARGE', `Payload exceeds ${MAX_PAYLOAD_SIZE} bytes.`)
    }
  }

  async function handleGetClientInfo(socket, args = []) {
    const { ack } = extractAck(args)
    const payload = buildClientInfo()
    emitSocketEvent(socket, 'clientInfo', payload, ack)
    return payload
  }

  async function handleRefreshPrinterList(socket, args = []) {
    const { ack } = extractAck(args)
    const printers = await getPrinterList()
    const payload = {
      printers,
      updatedAt: nowIso(),
    }
    emitSocketEvent(socket, 'printerList', payload, ack)
    return payload
  }

  async function handleGetPaperSizeInfo(socket, args = []) {
    const { payload: rawPayload, ack } = extractAck(args)
    const payload = {
      printer: toText(rawPayload?.printer),
      paperSizes: [],
      updatedAt: nowIso(),
    }
    emitSocketEvent(socket, 'paperSizeInfo', payload, ack)
    return payload
  }

  function buildDefaultJobPayload(basePayload = {}, type = '') {
    const normalizedType = toText(type)
    return {
      templateId: toText(basePayload?.templateId),
      type: normalizedType,
      printer: toText(basePayload?.printer),
      options: normalizeSocketPayload(basePayload?.options),
    }
  }

  function executeJob(payload = {}) {
    if (typeof onExecuteJob === 'function') {
      return onExecuteJob(payload)
    }
    throw createPrintError('PRINT_EXEC_FAILED', 'Print executor is not configured yet.')
  }

  function emitNewsJobResult(socket, job, ack = null) {
    if (String(job?.status || '').toUpperCase() === 'DONE') {
      const successPayload = {
        templateId: toText(job?.templateId),
        msg: '打印成功',
        taskId: toText(job?.taskId),
      }
      emitSocketEvent(socket, 'success', successPayload, ack)
      return
    }
    emitSocketError(
      socket,
      toText(job?.errorCode) || 'PRINT_EXEC_FAILED',
      toText(job?.errorMessage) || '打印失败',
      {
        templateId: toText(job?.templateId),
        taskId: toText(job?.taskId),
      },
      { eventName: 'error', ack },
    )
  }

  async function submitJobAndEmitResult(socket, payload, emitResult, ack = null) {
    const job = orchestrator.submitJob(payload, { run: executeJob })
    const finalJob = await orchestrator.waitForJob(job.taskId)
    emitResult(socket, finalJob, ack)
    return finalJob
  }

  function emitRenderJobResult(socket, job, eventPrefix, ack = null) {
    if (String(job?.status || '').toUpperCase() === 'DONE') {
      emitSocketEvent(socket, `${eventPrefix}-success`, {
        taskId: toText(job?.taskId),
        templateId: toText(job?.templateId),
        msg: '渲染成功',
      }, ack)
      return
    }
    emitSocketError(
      socket,
      toText(job?.errorCode) || 'RENDER_TEMPLATE_INVALID',
      toText(job?.errorMessage) || '渲染失败',
      {
        taskId: toText(job?.taskId),
        templateId: toText(job?.templateId),
      },
      { eventName: `${eventPrefix}-error`, ack },
    )
  }

  async function handleNews(socket, args = []) {
    const { payload: rawPayload, ack } = extractAck(args)
    assertPayloadSize(rawPayload)
    const newsType = toText(rawPayload?.type || 'html')
    const payload = {
      ...buildDefaultJobPayload(rawPayload, newsType),
      html: toText(rawPayload?.html),
      pdf_path: toText(rawPayload?.pdf_path),
      pdf_blob: rawPayload?.pdf_blob,
      pageSize: normalizeSocketPayload(rawPayload?.pageSize),
      copies: Number(rawPayload?.copies) || 1,
      silent: rawPayload?.silent === true,
      rePrintAble: rawPayload?.rePrintAble !== false,
    }

    return submitJobAndEmitResult(socket, payload, emitNewsJobResult, ack)
  }

  async function handleRenderJob(socket, args = [], {
    type,
    eventPrefix,
  } = {}) {
    const { payload: rawPayload, ack } = extractAck(args)
    assertPayloadSize(rawPayload)
    const payload = {
      ...buildDefaultJobPayload(rawPayload, type),
      html: toText(rawPayload?.html),
      template: rawPayload?.template,
      pageSize: normalizeSocketPayload(rawPayload?.pageSize),
    }
    return submitJobAndEmitResult(
      socket,
      payload,
      (targetSocket, finalJob, finalAck) => emitRenderJobResult(targetSocket, finalJob, eventPrefix, finalAck),
      ack,
    )
  }

  function createConnectionMiddleware() {
    return (socket, next) => {
      const auth = normalizeSocketPayload(socket?.handshake?.auth)
      const inputVersion = parseProtocolVersion(auth?.socketProtocolVersion ?? auth?.protocolVersion)
      if (!Number.isFinite(inputVersion) || inputVersion !== SOCKET_PROTOCOL_VERSION) {
        const error = createPrintError('SOCKET_PROTOCOL_MISMATCH', 'Socket protocol version mismatch.')
        error.data = createSocketErrorPayload('SOCKET_PROTOCOL_MISMATCH', 'Socket protocol version mismatch.', {
          expected: SOCKET_PROTOCOL_VERSION,
          received: inputVersion,
        })
        next(error)
        return
      }

      const token = toText(auth?.token)
      if (runtime.authToken && token !== runtime.authToken) {
        const error = createPrintError('SOCKET_AUTH_FAILED', 'Socket auth token invalid.')
        error.data = createSocketErrorPayload('SOCKET_AUTH_FAILED', 'Socket auth token invalid.')
        next(error)
        return
      }

      next()
    }
  }

  async function setupSocketHandlers() {
    if (!runtime.io) return
    runtime.io.use(createConnectionMiddleware())

    runtime.io.on('connection', (socket) => {
      runtime.clients.set(socket.id, {
        id: socket.id,
        connectedAt: nowIso(),
      })
      emitState()

      void handleGetClientInfo(socket).catch((error) => {
        emitSocketError(socket, toText(error?.code), toText(error?.message))
      })
      void handleRefreshPrinterList(socket).catch((error) => {
        emitSocketError(socket, toText(error?.code), toText(error?.message))
      })

      socket.on('getClientInfo', (...args) => {
        void handleGetClientInfo(socket, args).catch((error) => {
          const { ack } = extractAck(args)
          emitSocketError(socket, toText(error?.code), toText(error?.message), {}, { ack })
        })
      })

      socket.on('refreshPrinterList', (...args) => {
        void handleRefreshPrinterList(socket, args).catch((error) => {
          const { ack } = extractAck(args)
          emitSocketError(socket, toText(error?.code), toText(error?.message), {}, { ack })
        })
      })

      socket.on('getPaperSizeInfo', (...args) => {
        void handleGetPaperSizeInfo(socket, args).catch((error) => {
          const { ack } = extractAck(args)
          emitSocketError(socket, toText(error?.code), toText(error?.message), {}, { ack })
        })
      })

      socket.on('news', (...args) => {
        void handleNews(socket, args).catch((error) => {
          const { payload, ack } = extractAck(args)
          emitSocketError(
            socket,
            toText(error?.code),
            toText(error?.message),
            {
              templateId: toText(payload?.templateId),
            },
            { eventName: 'error', ack },
          )
        })
      })

      socket.on('render-jpeg', (...args) => {
        void handleRenderJob(socket, args, {
          type: 'render-jpeg',
          eventPrefix: 'render-jpeg',
        }).catch((error) => {
          const { payload, ack } = extractAck(args)
          emitSocketError(
            socket,
            toText(error?.code),
            toText(error?.message),
            {
              templateId: toText(payload?.templateId),
            },
            { eventName: 'render-jpeg-error', ack },
          )
        })
      })

      socket.on('render-pdf', (...args) => {
        void handleRenderJob(socket, args, {
          type: 'render-pdf',
          eventPrefix: 'render-pdf',
        }).catch((error) => {
          const { payload, ack } = extractAck(args)
          emitSocketError(
            socket,
            toText(error?.code),
            toText(error?.message),
            {
              templateId: toText(payload?.templateId),
            },
            { eventName: 'render-pdf-error', ack },
          )
        })
      })

      socket.on('render-print', (...args) => {
        void handleRenderJob(socket, args, {
          type: 'render-print',
          eventPrefix: 'render-print',
        }).catch((error) => {
          const { payload, ack } = extractAck(args)
          emitSocketError(
            socket,
            toText(error?.code),
            toText(error?.message),
            {
              templateId: toText(payload?.templateId),
            },
            { eventName: 'render-print-error', ack },
          )
        })
      })

      socket.on('printByFragments', (...args) => {
        const { payload, ack } = extractAck(args)
        emitSocketError(
          socket,
          'PRINT_EXEC_FAILED',
          'printByFragments is not implemented yet.',
          {
            templateId: toText(payload?.templateId),
          },
          { eventName: 'error', ack },
        )
      })

      socket.on('disconnect', () => {
        runtime.clients.delete(socket.id)
        emitState()
      })
    })
  }

  async function start() {
    if (runtime.running) {
      runtime.enabled = true
      emitState()
      return getState()
    }

    runtime.server = http.createServer((req, res) => {
      res.statusCode = 404
      res.end('Not Found')
    })

    runtime.io = new SocketIOServer(runtime.server, {
      path: '/socket.io',
      transports: ['websocket', 'polling'],
      cors: {
        origin: '*',
      },
      serveClient: false,
      maxHttpBufferSize: toPositiveInt(maxHttpBufferSize, DEFAULT_MAX_HTTP_BUFFER_SIZE),
    })

    await setupSocketHandlers()

    await new Promise((resolve, reject) => {
      if (!runtime.server) {
        reject(createPrintError('PRINT_EXEC_FAILED', 'HTTP server not initialized.'))
        return
      }
      runtime.server.once('error', reject)
      runtime.server.listen(runtime.port, '127.0.0.1', () => {
        runtime.server?.removeListener('error', reject)
        resolve()
      })
    })

    runtime.running = true
    runtime.enabled = true
    runtime.startedAt = nowIso()
    emitState()
    return getState()
  }

  async function stop() {
    runtime.enabled = false

    if (runtime.io) {
      await new Promise((resolve) => {
        try {
          runtime.io.close(() => resolve())
        } catch {
          resolve()
        }
      })
      runtime.io = null
    }

    if (runtime.server) {
      await new Promise((resolve) => {
        try {
          runtime.server.close(() => resolve())
        } catch {
          resolve()
        }
      })
      runtime.server = null
    }

    runtime.running = false
    runtime.startedAt = ''
    runtime.clients.clear()
    emitState()
    return getState()
  }

  async function setEnabled(enabled) {
    if (enabled) {
      return start()
    }
    return stop()
  }

  function setConfig({
    port,
    authToken,
  } = {}) {
    const hasPort = port !== undefined
    const hasToken = authToken !== undefined
    const nextPort = hasPort ? normalizePort(port, runtime.port) : runtime.port
    const nextToken = hasToken ? toText(authToken) : runtime.authToken
    const changed = nextPort !== runtime.port || nextToken !== runtime.authToken
    runtime.port = nextPort
    runtime.authToken = nextToken
    return changed
  }

  async function applySettings(settings = {}) {
    const wasRunning = runtime.running
    const changed = setConfig(settings)
    if (!wasRunning) return getState()
    if (!changed) return getState()
    await stop()
    await start()
    return getState()
  }

  function getClientInfo() {
    return buildClientInfo()
  }

  function listJobs() {
    return orchestrator.listJobs()
  }

  function getJob(taskId) {
    return orchestrator.getJob(taskId)
  }

  function submitJob(payload = {}) {
    return orchestrator.submitJob(payload, {
      run: executeJob,
    })
  }

  function reprint(taskId) {
    return orchestrator.reprint(taskId, {
      run: executeJob,
    })
  }

  async function dispose() {
    await stop()
  }

  return {
    getState,
    getClientInfo,
    getPrinterList,
    listJobs,
    getJob,
    submitJob,
    reprint,
    start,
    stop,
    setEnabled,
    applySettings,
    dispose,
  }
}
