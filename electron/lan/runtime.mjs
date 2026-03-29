import dgram from 'node:dgram'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

const LAN_PROTOCOL_VERSION = '1'
const DRIVER_ARCHIVE_VERSION = '1'
const DISCOVERY_PORT = 24821
const SERVICE_PORT = 24822
const HEARTBEAT_INTERVAL_MS = 5_000
const NODE_STALE_MS = 16_000
const PRUNE_INTERVAL_MS = 2_500
const MAX_TASKS = 200

const DEFAULT_FEATURE = {
  backup: {
    archiveEnabled: true,
  },
  lan: {
    discoveryEnabled: false,
    transferEnabled: false,
    autoInstallEnabled: false,
  },
}

function nowIso() {
  return new Date().toISOString()
}

function toBool(value, fallback = false) {
  if (value === true || value === false) return value
  if (typeof value === 'string') return value.toLowerCase() === 'true'
  if (value == null) return fallback
  return Boolean(value)
}

function normalizeFeatureSettings(feature = {}) {
  return {
    backup: {
      archiveEnabled: toBool(feature?.backup?.archiveEnabled, DEFAULT_FEATURE.backup.archiveEnabled),
    },
    lan: {
      discoveryEnabled: toBool(feature?.lan?.discoveryEnabled, DEFAULT_FEATURE.lan.discoveryEnabled),
      transferEnabled: toBool(feature?.lan?.transferEnabled, DEFAULT_FEATURE.lan.transferEnabled),
      autoInstallEnabled: toBool(feature?.lan?.autoInstallEnabled, DEFAULT_FEATURE.lan.autoInstallEnabled),
    },
  }
}

function createLanError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function isBrokenPipeError(error) {
  if (!error) return false
  if (String(error?.code || '').toUpperCase() === 'EPIPE') return true
  const message = String(error?.message || '').toLowerCase()
  return message.includes('broken pipe')
}

function safeWarn(...args) {
  try {
    console.warn(...args)
  } catch (error) {
    if (!isBrokenPipeError(error)) {
      // Ignore logging failures when stdio is detached.
    }
  }
}

function sortNodes(list = []) {
  return [...list].sort((a, b) => String(a.machineName || '').localeCompare(String(b.machineName || '')))
}

function sortTasks(list = []) {
  return [...list].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
}

export function createLanRuntime({
  configDir,
  appVersion,
  onStateChanged,
  onError,
} = {}) {
  const runtime = {
    enabled: false,
    startedAt: '',
    nodeId: '',
    machineName: os.hostname() || 'unknown-host',
    appVersion: String(appVersion || ''),
    arch: os.arch() === 'x64' ? 'x64' : 'x32',
    protocolVersion: LAN_PROTOCOL_VERSION,
    archiveVersion: DRIVER_ARCHIVE_VERSION,
    discoveryPort: DISCOVERY_PORT,
    servicePort: SERVICE_PORT,
    feature: normalizeFeatureSettings(),
    nodeMap: new Map(),
    offerMap: new Map(),
    taskMap: new Map(),
    prepared: false,
    udpSocket: null,
    heartbeatTimer: null,
    pruneTimer: null,
  }

  const nodeFilePath = path.join(configDir || '.', 'lan-node.json')
  const taskLogFilePath = path.join(configDir || '.', 'lan-task-log.jsonl')

  function emitState() {
    if (typeof onStateChanged !== 'function') return
    onStateChanged(getState())
  }

  function emitError(error) {
    if (typeof onError === 'function') {
      onError(error)
      return
    }
    // eslint-disable-next-line no-console
    safeWarn(`[lan-runtime] ${error?.message || error}`)
  }

  async function ensureConfigDir() {
    await fs.mkdir(configDir, { recursive: true })
  }

  async function loadNodeIdentity() {
    await ensureConfigDir()
    try {
      const rawText = await fs.readFile(nodeFilePath, 'utf-8')
      const parsed = JSON.parse(rawText)
      const nodeId = String(parsed?.nodeId || '').trim()
      if (nodeId) {
        runtime.nodeId = nodeId
        return
      }
    } catch {}

    runtime.nodeId = randomUUID()
    const payload = {
      nodeId: runtime.nodeId,
      createdAt: nowIso(),
    }
    await fs.writeFile(nodeFilePath, JSON.stringify(payload, null, 2), 'utf-8')
  }

  function buildHelloPayload() {
    return {
      kind: 'lan-hello',
      protocolVersion: runtime.protocolVersion,
      nodeId: runtime.nodeId,
      machineName: runtime.machineName,
      appVersion: runtime.appVersion,
      arch: runtime.arch,
      servicePort: runtime.servicePort,
      sentAt: nowIso(),
    }
  }

  function ingestHelloPacket(parsed, rinfo) {
    const nodeId = String(parsed?.nodeId || '').trim()
    if (!nodeId || nodeId === runtime.nodeId) return
    const machineName = String(parsed?.machineName || '').trim()
    const appVersionText = String(parsed?.appVersion || '').trim()
    const archText = String(parsed?.arch || '').trim() || 'x64'
    const servicePort = Number(parsed?.servicePort) || runtime.servicePort
    const host = String(rinfo?.address || '').trim()
    if (!host) return

    const existing = runtime.nodeMap.get(nodeId)
    const next = {
      nodeId,
      machineName: machineName || existing?.machineName || nodeId,
      appVersion: appVersionText || existing?.appVersion || '',
      arch: archText,
      host,
      servicePort,
      online: true,
      lastSeenAt: nowIso(),
    }
    runtime.nodeMap.set(nodeId, next)
    emitState()
  }

  async function bindSocket() {
    if (runtime.udpSocket) return

    await new Promise((resolve, reject) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      runtime.udpSocket = socket

      socket.on('error', (error) => {
        emitError(error)
      })

      socket.on('message', (message, rinfo) => {
        let parsed = null
        try {
          parsed = JSON.parse(String(message))
        } catch {
          return
        }
        if (String(parsed?.kind || '') !== 'lan-hello') return
        ingestHelloPacket(parsed, rinfo)
      })

      socket.once('listening', () => {
        try {
          socket.setBroadcast(true)
        } catch {}
        resolve()
      })

      socket.once('error', (error) => {
        reject(error)
      })

      socket.bind(runtime.discoveryPort)
    })
  }

  async function closeSocket() {
    if (!runtime.udpSocket) return
    const socket = runtime.udpSocket
    runtime.udpSocket = null
    await new Promise((resolve) => {
      socket.close(() => resolve())
    })
  }

  function sendHeartbeat() {
    if (!runtime.enabled || !runtime.udpSocket) return
    const payloadText = JSON.stringify(buildHelloPayload())
    const buffer = Buffer.from(payloadText, 'utf8')
    try {
      runtime.udpSocket.send(buffer, runtime.discoveryPort, '255.255.255.255')
    } catch (error) {
      emitError(error)
    }
  }

  function pruneNodes() {
    if (!runtime.enabled) return
    const now = Date.now()
    let changed = false
    for (const [nodeId, node] of runtime.nodeMap.entries()) {
      const lastSeen = new Date(node.lastSeenAt || 0).getTime()
      if (!lastSeen || now - lastSeen <= NODE_STALE_MS) continue
      runtime.nodeMap.delete(nodeId)
      changed = true
    }
    if (changed) emitState()
  }

  async function start() {
    if (runtime.enabled) return getState()
    await bootstrap()
    await bindSocket()
    runtime.enabled = true
    runtime.startedAt = nowIso()
    runtime.heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS)
    runtime.pruneTimer = setInterval(pruneNodes, PRUNE_INTERVAL_MS)
    sendHeartbeat()
    emitState()
    return getState()
  }

  async function stop() {
    if (!runtime.enabled) return getState()
    runtime.enabled = false
    runtime.startedAt = ''
    if (runtime.heartbeatTimer) {
      clearInterval(runtime.heartbeatTimer)
      runtime.heartbeatTimer = null
    }
    if (runtime.pruneTimer) {
      clearInterval(runtime.pruneTimer)
      runtime.pruneTimer = null
    }
    runtime.nodeMap.clear()
    await closeSocket()
    emitState()
    return getState()
  }

  async function appendTaskLog(task, action = 'task-updated') {
    await ensureConfigDir()
    const line = JSON.stringify({
      at: nowIso(),
      action,
      taskId: String(task?.taskId || ''),
      task,
    })
    await fs.appendFile(taskLogFilePath, `${line}\n`, 'utf-8')
  }

  async function createTask({
    type = 'install',
    status = 'FAILED',
    progress = 0,
    nodeId = '',
    offerId = '',
    errorCode = '',
    errorMessage = '',
  } = {}) {
    const taskId = `lan-task-${randomUUID()}`
    const task = {
      taskId,
      type,
      status,
      progress,
      nodeId,
      offerId,
      errorCode,
      errorMessage,
      updatedAt: nowIso(),
    }
    runtime.taskMap.set(taskId, task)
    if (runtime.taskMap.size > MAX_TASKS) {
      const overflow = runtime.taskMap.size - MAX_TASKS
      const keys = [...runtime.taskMap.keys()].slice(0, overflow)
      for (const key of keys) runtime.taskMap.delete(key)
    }
    await appendTaskLog(task, 'task-created')
    emitState()
    return task
  }

  async function requestInstall(payload = {}) {
    await bootstrap()
    const nodeId = String(payload?.nodeId || '').trim()
    const offerId = String(payload?.offerId || '').trim()
    if (!nodeId || !offerId) {
      throw createLanError('LAN_PROTOCOL_MISMATCH', 'Missing nodeId or offerId.')
    }
    if (!runtime.feature?.lan?.transferEnabled) {
      return createTask({
        status: 'FAILED',
        nodeId,
        offerId,
        errorCode: 'LAN_TRANSFER_DISABLED',
        errorMessage: 'LAN transfer feature is disabled.',
      })
    }
    return createTask({
      status: 'FAILED',
      nodeId,
      offerId,
      errorCode: 'LAN_OFFER_FETCH_FAILED',
      errorMessage: 'Remote offer transfer is not implemented yet.',
    })
  }

  async function cancelTask(taskId) {
    const normalizedTaskId = String(taskId || '').trim()
    if (!normalizedTaskId) {
      throw createLanError('LAN_TASK_INVALID', 'Task id is required.')
    }
    const task = runtime.taskMap.get(normalizedTaskId)
    if (!task) {
      throw createLanError('LAN_TASK_NOT_FOUND', `Task not found: ${normalizedTaskId}`)
    }
    if (['DONE', 'FAILED', 'CANCELED'].includes(task.status)) {
      return task
    }
    const next = {
      ...task,
      status: 'CANCELED',
      updatedAt: nowIso(),
    }
    runtime.taskMap.set(normalizedTaskId, next)
    await appendTaskLog(next, 'task-canceled')
    emitState()
    return next
  }

  function getTask(taskId) {
    const normalizedTaskId = String(taskId || '').trim()
    if (!normalizedTaskId) {
      throw createLanError('LAN_TASK_INVALID', 'Task id is required.')
    }
    const task = runtime.taskMap.get(normalizedTaskId)
    if (!task) {
      throw createLanError('LAN_TASK_NOT_FOUND', `Task not found: ${normalizedTaskId}`)
    }
    return task
  }

  function getPairState() {
    return {
      trustedCount: 0,
      blockedCount: 0,
      pendingCount: 0,
    }
  }

  function getNodes() {
    return sortNodes([...runtime.nodeMap.values()])
  }

  function getOffers() {
    return [...runtime.offerMap.values()]
  }

  function getTasks() {
    return sortTasks([...runtime.taskMap.values()])
  }

  function getState() {
    return {
      enabled: runtime.enabled,
      startedAt: runtime.startedAt,
      nodeId: runtime.nodeId,
      machineName: runtime.machineName,
      appVersion: runtime.appVersion,
      arch: runtime.arch,
      protocolVersion: runtime.protocolVersion,
      archiveVersion: runtime.archiveVersion,
      discoveryPort: runtime.discoveryPort,
      servicePort: runtime.servicePort,
      feature: runtime.feature,
      nodes: getNodes(),
      offers: getOffers(),
      tasks: getTasks(),
      pairState: getPairState(),
      updatedAt: nowIso(),
    }
  }

  function setFeature(feature = {}) {
    runtime.feature = normalizeFeatureSettings(feature)
    emitState()
  }

  async function dispose() {
    await stop()
  }

  async function bootstrap() {
    if (runtime.prepared) return getState()
    await loadNodeIdentity()
    runtime.prepared = true
    emitState()
    return getState()
  }

  return {
    bootstrap,
    start,
    stop,
    dispose,
    setFeature,
    getState,
    listNodes: getNodes,
    listOffers: getOffers,
    listTasks: getTasks,
    requestInstall,
    getTask,
    cancelTask,
  }
}
