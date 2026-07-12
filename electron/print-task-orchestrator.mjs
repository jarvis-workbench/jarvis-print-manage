import { randomUUID } from 'node:crypto'

const MAX_JOBS = 200
const TERMINAL_JOB_STATUS = new Set(['DONE', 'FAILED', 'CANCELED'])
const VALID_JOB_TYPES = new Set([
  'html',
  'pdf',
  'url_pdf',
  'blob_pdf',
  'render-jpeg',
  'render-pdf',
  'render-print',
])

function nowIso() {
  return new Date().toISOString()
}

function toText(value) {
  return String(value ?? '').trim()
}

function normalizeJobType(type) {
  const value = toText(type)
  return VALID_JOB_TYPES.has(value) ? value : ''
}

function createPrintError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function isInvalidPayload(payload) {
  return !payload || typeof payload !== 'object' || Array.isArray(payload)
}

function patchJobStatus(job, status, {
  errorCode = '',
  errorMessage = '',
  patch = {},
} = {}) {
  const next = {
    ...job,
    ...patch,
    status,
    updatedAt: nowIso(),
  }

  if (status === 'DONE') {
    next.errorCode = ''
    next.errorMessage = ''
    return next
  }

  if (status === 'FAILED') {
    next.errorCode = toText(errorCode) || 'PRINT_EXEC_FAILED'
    next.errorMessage = toText(errorMessage) || 'Print execution failed.'
    return next
  }

  if (status === 'CANCELED') {
    next.errorCode = ''
    next.errorMessage = ''
    return next
  }

  next.errorCode = ''
  next.errorMessage = ''
  return next
}

export function createPrintTaskOrchestrator({
  onJobUpdated,
  maxJobs = MAX_JOBS,
} = {}) {
  const runtime = {
    jobMap: new Map(),
    waiters: new Map(),
    maxJobs: Math.max(Number(maxJobs) || 0, 50),
  }

  function emitJob(job) {
    if (typeof onJobUpdated === 'function') {
      onJobUpdated(job)
    }
    const waiters = runtime.waiters.get(job.taskId)
    if (waiters && TERMINAL_JOB_STATUS.has(job.status)) {
      runtime.waiters.delete(job.taskId)
      for (const resolve of waiters) {
        resolve(job)
      }
    }
  }

  function trimOverflow() {
    if (runtime.jobMap.size <= runtime.maxJobs) return
    const overflow = runtime.jobMap.size - runtime.maxJobs
    const keys = [...runtime.jobMap.keys()].slice(0, overflow)
    for (const key of keys) {
      runtime.jobMap.delete(key)
    }
  }

  function setJob(job) {
    runtime.jobMap.set(job.taskId, job)
    trimOverflow()
    emitJob(job)
    return job
  }

  function getJob(taskId) {
    const normalizedTaskId = toText(taskId)
    if (!normalizedTaskId) {
      throw createPrintError('PAYLOAD_INVALID', 'Task id is required.')
    }
    const job = runtime.jobMap.get(normalizedTaskId)
    if (!job) {
      throw createPrintError('PAYLOAD_INVALID', `Task not found: ${normalizedTaskId}`)
    }
    return job
  }

  function listJobs() {
    return [...runtime.jobMap.values()].sort((a, b) =>
      String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
  }

  function createJob(payload = {}) {
    if (isInvalidPayload(payload)) {
      throw createPrintError('PAYLOAD_INVALID', 'Job payload must be an object.')
    }

    const type = normalizeJobType(payload.type)
    if (!type) {
      throw createPrintError('PAYLOAD_INVALID', `Unsupported print type: ${payload?.type || ''}`)
    }

    const taskId = `print-task-${randomUUID()}`
    const createdAt = nowIso()
    const templateId = toText(payload.templateId) || taskId

    const job = {
      taskId,
      templateId,
      type,
      status: 'QUEUED',
      printer: toText(payload.printer),
      errorCode: '',
      errorMessage: '',
      createdAt,
      updatedAt: createdAt,
    }

    return setJob(job)
  }

  function updateJob(taskId, status, {
    errorCode = '',
    errorMessage = '',
    patch = {},
  } = {}) {
    const existing = getJob(taskId)
    if (TERMINAL_JOB_STATUS.has(existing.status)) {
      return existing
    }
    return setJob(patchJobStatus(existing, status, {
      errorCode,
      errorMessage,
      patch,
    }))
  }

  function submitJob(payload = {}, {
    run = null,
  } = {}) {
    const queued = createJob(payload)
    const running = updateJob(queued.taskId, 'RUNNING')

    if (typeof run !== 'function') {
      return updateJob(running.taskId, 'FAILED', {
        errorCode: 'PRINT_EXEC_FAILED',
        errorMessage: 'Print executor is not configured yet.',
      })
    }

    Promise.resolve()
      .then(async () => run({ ...running }, payload))
      .then((result) => {
        const latest = getJob(running.taskId)
        if (latest.status === 'CANCELED') return
        updateJob(running.taskId, 'DONE', {
          patch: {
            result: result ?? null,
          },
        })
      })
      .catch((error) => {
        const latest = getJob(running.taskId)
        if (latest.status === 'CANCELED') return
        updateJob(running.taskId, 'FAILED', {
          errorCode: toText(error?.code) || 'PRINT_EXEC_FAILED',
          errorMessage: toText(error?.message) || 'Print execution failed.',
        })
      })

    return running
  }

  function waitForJob(taskId) {
    const existing = getJob(taskId)
    if (TERMINAL_JOB_STATUS.has(existing.status)) {
      return Promise.resolve(existing)
    }

    return new Promise((resolve) => {
      const wrappedResolve = (job) => {
        clearTimeout(timeout)
        resolve(job)
      }

      const timeout = setTimeout(() => {
        const waiters = runtime.waiters.get(existing.taskId) || []
        const nextWaiters = waiters.filter((item) => item !== wrappedResolve)
        if (nextWaiters.length) {
          runtime.waiters.set(existing.taskId, nextWaiters)
        } else {
          runtime.waiters.delete(existing.taskId)
        }
        resolve(getJob(existing.taskId))
      }, 120_000)

      const waiters = runtime.waiters.get(existing.taskId) || []
      runtime.waiters.set(existing.taskId, [...waiters, wrappedResolve])
    })
  }

  function cancelJob(taskId) {
    const existing = getJob(taskId)
    if (TERMINAL_JOB_STATUS.has(existing.status)) {
      return existing
    }
    return setJob(patchJobStatus(existing, 'CANCELED'))
  }

  function reprint(taskId, {
    run = null,
  } = {}) {
    const source = getJob(taskId)
    const payload = {
      templateId: source.templateId,
      type: source.type,
      printer: source.printer,
    }
    return submitJob(payload, { run })
  }

  return {
    getJob,
    waitForJob,
    listJobs,
    submitJob,
    cancelJob,
    reprint,
  }
}
