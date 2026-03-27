import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_BUFFER = 20 * 1024 * 1024

function uniq(values) {
  return [...new Set(values.filter(Boolean))]
}

function resolvePowerShellCandidates() {
  const winDir = process.env.WINDIR || process.env.windir || 'C:\\Windows'
  return uniq([
    path.join(winDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(winDir, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell.exe',
    'pwsh.exe',
  ])
}

function wrapScript(script) {
  return `
    [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    ${script}
  `
}

function buildPowerShellArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrapScript(script)]
}

function toErrorMessage(stderr, stdout, fallback = '') {
  return String(stderr || stdout || fallback || '').trim()
}

async function execWithCandidates(script, options = {}) {
  const args = buildPowerShellArgs(script)
  const timeoutMs = Math.max(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, 1_000)
  const candidates = resolvePowerShellCandidates()
  let lastError = null

  for (const executable of candidates) {
    try {
      const result = await execFileAsync(executable, args, {
        windowsHide: true,
        maxBuffer: DEFAULT_MAX_BUFFER,
        timeout: timeoutMs,
      })
      return {
        stdout: String(result?.stdout || '').trim(),
        stderr: String(result?.stderr || '').trim(),
      }
    } catch (error) {
      const message = String(error?.message || '')
      const isNotFound = error?.code === 'ENOENT' || message.includes('ENOENT')
      if (isNotFound) {
        lastError = error
        continue
      }
      if (error?.killed && error?.signal === 'SIGTERM') {
        throw new Error(`PowerShell execution timed out after ${timeoutMs}ms.`)
      }
      const stderr = String(error?.stderr || '')
      const stdout = String(error?.stdout || '')
      throw new Error(toErrorMessage(stderr, stdout, message))
    }
  }

  throw new Error(`PowerShell executable not found. Tried: ${candidates.join(', ')}. ${lastError?.message || ''}`.trim())
}

export async function runPowerShell(script, options = {}) {
  return execWithCandidates(script, options)
}

export async function runPowerShellJson(script, options = {}) {
  const wrappedJsonScript = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $__codexResult = & {
      ${script}
    }
    if ($null -eq $__codexResult) {
      $__codexJson = 'null'
    } elseif ($__codexResult -is [string]) {
      $__codexJson = $__codexResult
    } else {
      $__codexJson = $__codexResult | ConvertTo-Json -Depth 12 -Compress
    }
    if ($null -eq $__codexJson -or $__codexJson -eq '') {
      $__codexJson = 'null'
    }
    [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($__codexJson))
  `

  const { stdout, stderr } = await runPowerShell(wrappedJsonScript, options)
  const base64Text = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || ''
  const jsonText = Buffer.from(base64Text, 'base64').toString('utf8').trim()
  if (!jsonText) {
    throw new Error(toErrorMessage(stderr, stdout, 'PowerShell returned empty output.'))
  }

  try {
    return JSON.parse(jsonText)
  } catch {
    throw new Error(toErrorMessage(stderr, stdout, `Failed to parse PowerShell JSON output: ${jsonText}`))
  }
}
