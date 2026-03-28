import { execFileSync } from 'node:child_process'

const port = Number(process.env.ELE_DRIVE_DEV_PORT || 5173)

if (process.platform !== 'win32') {
  process.exit(0)
}

try {
  const output = execFileSync('cmd.exe', ['/d', '/s', '/c', 'netstat -ano -p tcp'], {
    encoding: 'utf8',
    windowsHide: true,
  })
  const pids = new Set()
  for (const line of String(output || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || !/^TCP\s+/i.test(trimmed)) continue
    const parts = trimmed.split(/\s+/)
    if (parts.length < 5) continue
    const localAddress = parts[1] || ''
    const state = (parts[3] || '').toLowerCase()
    const pidText = parts[4] || ''
    if (!(state.includes('listen') || state.includes('侦听'))) continue
    const portMatch = localAddress.match(/:(\d+)$/)
    if (!portMatch) continue
    if (Number(portMatch[1]) !== port) continue
    const pid = Number(pidText)
    if (Number.isFinite(pid) && pid > 0) {
      pids.add(pid)
    }
  }

  for (const pid of pids) {
    try {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
      console.log(`Freed port ${port} by stopping PID ${pid}`)
    } catch {}
  }
} catch (error) {
  console.warn('[dev:free-port] failed to ensure port availability:', error?.message || error)
}

try {
  // Small delay to avoid TIME_WAIT race with immediate Vite startup.
  execFileSync('cmd.exe', ['/d', '/s', '/c', 'timeout /t 1 /nobreak >NUL'], {
    stdio: 'ignore',
    windowsHide: true,
  })
} catch (error) {
  // ignore
}
