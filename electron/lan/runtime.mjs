import dgram from 'node:dgram'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import http from 'node:http'
import { randomUUID } from 'node:crypto'

const LAN_PROTOCOL_VERSION = '1'
const DRIVER_ARCHIVE_VERSION = '1'
const DISCOVERY_PORT = 24821
const SERVICE_PORT = 24822
const HEARTBEAT_INTERVAL_MS = 5_000
const NODE_STALE_MS = 16_000
const PRUNE_INTERVAL_MS = 2_500
const OFFER_SYNC_INTERVAL_MS = 5_000
const OFFER_LOCAL_REFRESH_INTERVAL_MS = 15_000
const HTTP_CLIENT_TIMEOUT_MS = 8_000
const MAX_TASKS = 200
const OFFER_LIST_PATH = '/lan/v1/offers'
const OFFER_ARCHIVE_PATH_PREFIX = '/lan/v1/archive/'

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

function sortOffers(list = []) {
  return [...list].sort((a, b) => {
    const nodeCmp = String(a.nodeId || '').localeCompare(String(b.nodeId || ''))
    if (nodeCmp !== 0) return nodeCmp
    const printerCmp = String(a.printerName || '').localeCompare(String(b.printerName || ''))
    if (printerCmp !== 0) return printerCmp
    return String(a.offerId || '').localeCompare(String(b.offerId || ''))
  })
}

function sortTasks(list = []) {
  return [...list].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
}

function parseIpv4ToInt(ip) {
  const text = String(ip || '').trim()
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(text)) return null
  const parts = text.split('.').map((item) => Number(item))
  if (parts.some((num) => !Number.isInteger(num) || num < 0 || num > 255)) return null
  return ((((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]) >>> 0)
}

function formatIpv4FromInt(value) {
  const num = Number(value >>> 0)
  return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`
}

function buildBroadcastTargets() {
  const targets = new Set(['255.255.255.255'])
  const netMap = os.networkInterfaces()
  for (const entries of Object.values(netMap || {})) {
    if (!Array.isArray(entries)) continue
    for (const entry of entries) {
      const family = String(entry?.family || '')
      if (!(family === 'IPv4' || family === '4')) continue
      if (entry?.internal) continue
      const ipInt = parseIpv4ToInt(entry?.address)
      const maskInt = parseIpv4ToInt(entry?.netmask)
      if (ipInt == null || maskInt == null) continue
      const broadcast = (ipInt | ((~maskInt) >>> 0)) >>> 0
      targets.add(formatIpv4FromInt(broadcast))
    }
  }
  return [...targets]
}

function normalizeOffer(rawOffer = {}, node = {}) {
  const offerId = String(rawOffer.offerId || '').trim()
  if (!offerId) return null
  return {
    offerId,
    nodeId: String(node.nodeId || rawOffer.nodeId || '').trim(),
    printerName: String(rawOffer.printerName || ''),
    driverName: String(rawOffer.driverName || ''),
    driverVersion: String(rawOffer.driverVersion || ''),
    manufacturer: String(rawOffer.manufacturer || ''),
    environment: String(rawOffer.environment || ''),
    portName: String(rawOffer.portName || ''),
    portHostAddress: String(rawOffer.portHostAddress || ''),
    portNumber: String(rawOffer.portNumber || ''),
    identityKey: String(rawOffer.identityKey || ''),
    archiveFileName: String(rawOffer.archiveFileName || ''),
    archiveRelativePath: String(rawOffer.archiveRelativePath || ''),
    archiveFormat: String(rawOffer.archiveFormat || ''),
    archiveSha256: String(rawOffer.archiveSha256 || '').toLowerCase(),
    archiveSize: Number(rawOffer.archiveSize) || 0,
    infRelativePath: String(rawOffer.infRelativePath || ''),
    backupAt: String(rawOffer.backupAt || ''),
    pnpDeviceId: String(rawOffer.pnpDeviceId || ''),
    hardwareIds: Array.isArray(rawOffer.hardwareIds)
      ? rawOffer.hardwareIds.map((item) => String(item || '')).filter(Boolean)
      : [],
    usbVid: String(rawOffer.usbVid || ''),
    usbPid: String(rawOffer.usbPid || ''),
    usbVidPid: String(rawOffer.usbVidPid || ''),
    deviceSerial: String(rawOffer.deviceSerial || ''),
    host: String(node.host || ''),
    servicePort: Number(node.servicePort) || 0,
  }
}

function buildOfferMapKey(nodeId = '', offerId = '') {
  return `${String(nodeId || '').trim()}::${String(offerId || '').trim()}`
}

function areOffersEqual(a = {}, b = {}) {
  const keys = [
    'offerId',
    'nodeId',
    'printerName',
    'driverName',
    'driverVersion',
    'manufacturer',
    'environment',
    'portName',
    'portHostAddress',
    'portNumber',
    'identityKey',
    'archiveFileName',
    'archiveRelativePath',
    'archiveFormat',
    'archiveSha256',
    'archiveSize',
    'infRelativePath',
    'backupAt',
    'pnpDeviceId',
    'usbVid',
    'usbPid',
    'usbVidPid',
    'deviceSerial',
    'host',
    'servicePort',
  ]
  for (const key of keys) {
    if (String(a?.[key] ?? '') !== String(b?.[key] ?? '')) {
      return false
    }
  }
  const leftHardware = Array.isArray(a?.hardwareIds) ? a.hardwareIds : []
  const rightHardware = Array.isArray(b?.hardwareIds) ? b.hardwareIds : []
  if (leftHardware.length !== rightHardware.length) return false
  for (let i = 0; i < leftHardware.length; i += 1) {
    if (String(leftHardware[i]) !== String(rightHardware[i])) return false
  }
  return true
}

function clampProgress(value, min = 0, max = 100) {
  const num = Number(value)
  if (!Number.isFinite(num)) return min
  return Math.min(Math.max(Math.round(num), min), max)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function createLanRuntime({
  configDir,
  appVersion,
  onStateChanged,
  onError,
  onListLocalOffers,
  onResolveOfferArchive,
  onRequestInstall,
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
    localOffers: [],
    prepared: false,
    udpSocket: null,
    httpServer: null,
    heartbeatTimer: null,
    pruneTimer: null,
    offerSyncTimer: null,
    localOfferRefreshTimer: null,
    isOfferSyncRunning: false,
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
    if (!existing || existing.host !== next.host || existing.servicePort !== next.servicePort) {
      void syncRemoteOffers({ reason: 'node-updated' })
    }
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
        runtime.udpSocket = null
        try {
          socket.close()
        } catch {}
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
    const targets = buildBroadcastTargets()
    for (const host of targets) {
      try {
        runtime.udpSocket.send(buffer, runtime.discoveryPort, host)
      } catch (error) {
        emitError(error)
      }
    }
  }

  function respondJson(res, statusCode, payload) {
    const body = JSON.stringify(payload ?? null)
    res.statusCode = statusCode
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader('Content-Length', Buffer.byteLength(body))
    res.end(body)
  }

  async function handleOfferListRequest(res) {
    await refreshLocalOffers()
    respondJson(res, 200, {
      kind: 'lan-offers',
      protocolVersion: runtime.protocolVersion,
      archiveVersion: runtime.archiveVersion,
      nodeId: runtime.nodeId,
      machineName: runtime.machineName,
      appVersion: runtime.appVersion,
      arch: runtime.arch,
      offers: runtime.localOffers,
      updatedAt: nowIso(),
    })
  }

  async function handleArchiveRequest(res, offerId) {
    if (!offerId) {
      respondJson(res, 400, {
        code: 'LAN_OFFER_INVALID',
        message: 'Missing offerId.',
      })
      return
    }
    if (typeof onResolveOfferArchive !== 'function') {
      respondJson(res, 503, {
        code: 'LAN_ARCHIVE_DISABLED',
        message: 'Archive resolve callback is unavailable.',
      })
      return
    }

    const resolved = await onResolveOfferArchive({
      offerId,
      nodeId: runtime.nodeId,
    })
    const archivePath = String(resolved?.archivePath || '').trim()
    if (!archivePath) {
      respondJson(res, 404, {
        code: 'LAN_OFFER_NOT_FOUND',
        message: `Offer not found: ${offerId}`,
      })
      return
    }

    let stat = null
    try {
      stat = await fs.stat(archivePath)
    } catch {}
    if (!stat?.isFile?.()) {
      respondJson(res, 404, {
        code: 'LAN_ARCHIVE_NOT_FOUND',
        message: `Archive not found: ${offerId}`,
      })
      return
    }

    res.statusCode = 200
    res.setHeader('Content-Type', 'application/octet-stream')
    res.setHeader('Content-Length', String(stat.size))
    res.setHeader('Cache-Control', 'no-store')
    const readStream = createReadStream(archivePath)
    readStream.on('error', (error) => {
      if (!res.headersSent) {
        respondJson(res, 500, {
          code: 'LAN_ARCHIVE_STREAM_ERROR',
          message: String(error?.message || error),
        })
        return
      }
      try {
        res.destroy(error)
      } catch {}
    })
    res.on('close', () => {
      try {
        readStream.destroy()
      } catch {}
    })
    readStream.pipe(res)
  }

  async function handleHttpRequest(req, res) {
    const method = String(req?.method || '').toUpperCase()
    const host = String(req?.headers?.host || `127.0.0.1:${runtime.servicePort}`)
    let requestUrl = null
    try {
      requestUrl = new URL(String(req?.url || '/'), `http://${host}`)
    } catch {
      respondJson(res, 400, {
        code: 'LAN_REQUEST_INVALID',
        message: 'Invalid URL.',
      })
      return
    }
    const pathname = requestUrl.pathname || '/'

    try {
      if (method === 'GET' && pathname === OFFER_LIST_PATH) {
        await handleOfferListRequest(res)
        return
      }
      if (method === 'GET' && pathname.startsWith(OFFER_ARCHIVE_PATH_PREFIX)) {
        const offerIdRaw = pathname.slice(OFFER_ARCHIVE_PATH_PREFIX.length)
        const offerId = decodeURIComponent(String(offerIdRaw || ''))
        await handleArchiveRequest(res, offerId)
        return
      }

      respondJson(res, 404, {
        code: 'LAN_ROUTE_NOT_FOUND',
        message: 'Route not found.',
      })
    } catch (error) {
      emitError(error)
      if (!res.headersSent) {
        respondJson(res, 500, {
          code: 'LAN_SERVER_ERROR',
          message: String(error?.message || error),
        })
      } else {
        try {
          res.destroy(error)
        } catch {}
      }
    }
  }

  async function startHttpServer() {
    if (runtime.httpServer) return
    await new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        void handleHttpRequest(req, res)
      })
      runtime.httpServer = server
      server.once('error', (error) => {
        runtime.httpServer = null
        try {
          server.close()
        } catch {}
        reject(error)
      })
      server.listen(runtime.servicePort, '0.0.0.0', () => {
        server.removeAllListeners('error')
        server.on('error', (error) => emitError(error))
        resolve()
      })
    })
  }

  async function stopHttpServer() {
    if (!runtime.httpServer) return
    const server = runtime.httpServer
    runtime.httpServer = null
    await new Promise((resolve) => server.close(() => resolve()))
  }

  async function refreshLocalOffers() {
    if (typeof onListLocalOffers !== 'function') {
      runtime.localOffers = []
      return runtime.localOffers
    }
    let offers = []
    try {
      const value = await onListLocalOffers({ nodeId: runtime.nodeId })
      offers = Array.isArray(value) ? value : []
    } catch (error) {
      emitError(error)
      offers = []
    }
    runtime.localOffers = sortOffers(
      offers
        .map((raw) => normalizeOffer(raw, { nodeId: runtime.nodeId, host: '', servicePort: runtime.servicePort }))
        .filter(Boolean),
    )
    return runtime.localOffers
  }

  async function fetchRemoteOffers(node) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        method: 'GET',
        hostname: node.host,
        port: node.servicePort,
        path: OFFER_LIST_PATH,
        timeout: HTTP_CLIENT_TIMEOUT_MS,
      }, (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8')
          if (res.statusCode !== 200) {
            reject(createLanError('LAN_OFFER_FETCH_FAILED', `node=${node.nodeId} status=${res.statusCode || 0}`))
            return
          }
          let payload = null
          try {
            payload = JSON.parse(body)
          } catch (error) {
            reject(createLanError('LAN_OFFER_INVALID', `node=${node.nodeId} invalid json: ${error?.message || error}`))
            return
          }
          const remoteProtocolVersion = String(payload?.protocolVersion || '')
          if (remoteProtocolVersion && remoteProtocolVersion !== runtime.protocolVersion) {
            reject(createLanError(
              'LAN_PROTOCOL_MISMATCH',
              `node=${node.nodeId} protocol mismatch local=${runtime.protocolVersion}, remote=${remoteProtocolVersion}`,
            ))
            return
          }
          const list = Array.isArray(payload?.offers) ? payload.offers : []
          const offers = list
            .map((raw) => normalizeOffer(raw, node))
            .filter(Boolean)
          resolve(offers)
        })
      })
      req.on('timeout', () => {
        req.destroy(createLanError('LAN_OFFER_FETCH_TIMEOUT', `node=${node.nodeId} timeout`))
      })
      req.on('error', (error) => reject(error))
      req.end()
    })
  }

  function applyOfferMap(nextMap) {
    let changed = false
    if (nextMap.size !== runtime.offerMap.size) {
      changed = true
    } else {
      for (const [key, offer] of nextMap.entries()) {
        const previous = runtime.offerMap.get(key)
        if (!previous || !areOffersEqual(previous, offer)) {
          changed = true
          break
        }
      }
    }
    if (!changed) return false
    runtime.offerMap = nextMap
    emitState()
    return true
  }

  async function syncRemoteOffers({ reason = '' } = {}) {
    if (!runtime.enabled) return []
    if (runtime.isOfferSyncRunning) return []
    runtime.isOfferSyncRunning = true
    try {
      const nodes = getNodes()
      const nextMap = new Map()
      await Promise.all(nodes.map(async (node) => {
        try {
          const offers = await fetchRemoteOffers(node)
          for (const offer of offers) {
            const key = buildOfferMapKey(node.nodeId, offer.offerId)
            nextMap.set(key, offer)
          }
        } catch (error) {
          if (reason !== 'timer') {
            emitError(error)
          } else {
            safeWarn(`[lan-runtime] offer sync failed: ${error?.message || error}`)
          }
        }
      }))
      applyOfferMap(nextMap)
      return sortOffers([...nextMap.values()])
    } finally {
      runtime.isOfferSyncRunning = false
    }
  }

  function pruneNodes() {
    if (!runtime.enabled) return
    const now = Date.now()
    let changed = false
    const removedNodeIds = []
    for (const [nodeId, node] of runtime.nodeMap.entries()) {
      const lastSeen = new Date(node.lastSeenAt || 0).getTime()
      if (!lastSeen || now - lastSeen <= NODE_STALE_MS) continue
      runtime.nodeMap.delete(nodeId)
      removedNodeIds.push(nodeId)
      changed = true
    }
    if (removedNodeIds.length > 0) {
      const nextMap = new Map()
      for (const [key, offer] of runtime.offerMap.entries()) {
        if (!removedNodeIds.includes(String(offer.nodeId || ''))) {
          nextMap.set(key, offer)
        }
      }
      if (nextMap.size !== runtime.offerMap.size) {
        runtime.offerMap = nextMap
        changed = true
      }
    }
    if (changed) emitState()
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

  async function updateTask(taskId, patch = {}, action = 'task-updated') {
    const existing = runtime.taskMap.get(taskId)
    if (!existing) return null
    const next = {
      ...existing,
      ...patch,
      updatedAt: nowIso(),
    }
    runtime.taskMap.set(taskId, next)
    await appendTaskLog(next, action)
    emitState()
    return next
  }

  async function createTask({
    type = 'install',
    status = 'QUEUED',
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
      progress: clampProgress(progress),
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

  function getNodeAndOffer(nodeId, offerId) {
    const node = runtime.nodeMap.get(nodeId)
    if (!node) {
      throw createLanError('LAN_NODE_NOT_FOUND', `Node not found: ${nodeId}`)
    }
    const offer = runtime.offerMap.get(buildOfferMapKey(nodeId, offerId))
    if (!offer) {
      throw createLanError('LAN_OFFER_NOT_FOUND', `Offer not found: ${offerId}`)
    }
    return { node, offer }
  }

  async function performInstallTask(taskId, payload = {}) {
    const nodeId = String(payload?.nodeId || '').trim()
    const offerId = String(payload?.offerId || '').trim()
    const targetPrinterName = String(payload?.targetPrinterName || '').trim()
    try {
      await updateTask(taskId, {
        status: 'DISCOVERING',
        progress: 5,
      }, 'task-discovering')
      await syncRemoteOffers({ reason: 'install-request' })
      const { node, offer } = getNodeAndOffer(nodeId, offerId)

      const currentTask = runtime.taskMap.get(taskId)
      if (currentTask?.status === 'CANCELED') return

      await updateTask(taskId, {
        status: 'OFFER_READY',
        progress: 12,
      }, 'task-offer-ready')

      if (typeof onRequestInstall !== 'function') {
        throw createLanError('LAN_TRANSFER_DISABLED', 'Install callback is unavailable.')
      }

      const result = await onRequestInstall({
        node,
        offer,
        targetPrinterName,
        onProgress: (progress) => {
          const task = runtime.taskMap.get(taskId)
          if (!task || task.status === 'CANCELED') return
          const normalized = clampProgress(progress, 12, 99)
          const status = normalized >= 70 ? 'INSTALLING' : 'TRANSFERRING'
          void updateTask(taskId, {
            status,
            progress: normalized,
          }, 'task-progress')
        },
      })

      const latest = runtime.taskMap.get(taskId)
      if (!latest || latest.status === 'CANCELED') return

      await updateTask(taskId, {
        status: 'DONE',
        progress: 100,
        errorCode: '',
        errorMessage: '',
        result: result || null,
      }, 'task-done')
    } catch (error) {
      const latest = runtime.taskMap.get(taskId)
      if (!latest || latest.status === 'CANCELED') {
        return
      }
      emitError(createLanError(
        String(error?.code || 'LAN_INSTALL_FAILED'),
        `[lan-task] install failed taskId=${taskId} nodeId=${nodeId} offerId=${offerId}: ${String(error?.message || error)}`,
      ))
      await updateTask(taskId, {
        status: 'FAILED',
        progress: Math.min(clampProgress(latest.progress, 0, 100), 99),
        errorCode: String(error?.code || 'LAN_INSTALL_FAILED'),
        errorMessage: String(error?.message || error || 'install failed'),
      }, 'task-failed')
    }
  }

  async function requestInstall(payload = {}) {
    await bootstrap()
    if (!runtime.enabled) {
      return createTask({
        status: 'FAILED',
        errorCode: 'LAN_RUNTIME_DISABLED',
        errorMessage: 'LAN runtime is not enabled.',
      })
    }
    const nodeId = String(payload?.nodeId || '').trim()
    const offerId = String(payload?.offerId || '').trim()
    if (!nodeId || !offerId) {
      throw createLanError('LAN_PAYLOAD_INVALID', 'Missing nodeId or offerId.')
    }
    const task = await createTask({
      status: 'QUEUED',
      progress: 0,
      nodeId,
      offerId,
    })
    void performInstallTask(task.taskId, payload)
    return task
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
    const next = await updateTask(normalizedTaskId, {
      status: 'CANCELED',
      errorCode: '',
      errorMessage: '',
    }, 'task-canceled')
    return next || task
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
    return sortOffers([...runtime.offerMap.values()])
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

  async function start() {
    if (runtime.enabled) return getState()
    try {
      await bootstrap()
      await bindSocket()
      await startHttpServer()
      await refreshLocalOffers()
      runtime.enabled = true
      runtime.startedAt = nowIso()

      runtime.heartbeatTimer = setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS)
      runtime.pruneTimer = setInterval(pruneNodes, PRUNE_INTERVAL_MS)
      runtime.offerSyncTimer = setInterval(() => {
        void syncRemoteOffers({ reason: 'timer' })
      }, OFFER_SYNC_INTERVAL_MS)
      runtime.localOfferRefreshTimer = setInterval(() => {
        void refreshLocalOffers()
      }, OFFER_LOCAL_REFRESH_INTERVAL_MS)

      sendHeartbeat()
      await sleep(120)
      await syncRemoteOffers({ reason: 'startup' })
      emitState()
      return getState()
    } catch (error) {
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
      if (runtime.offerSyncTimer) {
        clearInterval(runtime.offerSyncTimer)
        runtime.offerSyncTimer = null
      }
      if (runtime.localOfferRefreshTimer) {
        clearInterval(runtime.localOfferRefreshTimer)
        runtime.localOfferRefreshTimer = null
      }
      await stopHttpServer()
      await closeSocket()
      throw error
    }
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
    if (runtime.offerSyncTimer) {
      clearInterval(runtime.offerSyncTimer)
      runtime.offerSyncTimer = null
    }
    if (runtime.localOfferRefreshTimer) {
      clearInterval(runtime.localOfferRefreshTimer)
      runtime.localOfferRefreshTimer = null
    }
    runtime.nodeMap.clear()
    runtime.offerMap.clear()
    await closeSocket()
    await stopHttpServer()
    emitState()
    return getState()
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
    await refreshLocalOffers()
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
    syncOffers: () => syncRemoteOffers({ reason: 'manual' }),
    listNodes: getNodes,
    listOffers: getOffers,
    listTasks: getTasks,
    requestInstall,
    getTask,
    cancelTask,
  }
}
