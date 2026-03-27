let mediaQuery = null
let mediaQueryListener = null

function resolveTheme(mode) {
  if (mode === 'light' || mode === 'dark') return mode
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyResolvedTheme(mode) {
  const resolved = resolveTheme(mode)
  document.documentElement.setAttribute('data-theme', resolved)
  document.documentElement.setAttribute('data-theme-mode', mode)
  document.documentElement.classList.toggle('dark', resolved === 'dark')
}

export function applyThemeMode(mode = 'system') {
  applyResolvedTheme(mode)
}

export function bindSystemTheme(mode = 'system') {
  if (!mediaQuery) {
    mediaQuery = window.matchMedia('(prefers-color-scheme: dark)')
  }
  if (mediaQueryListener) {
    mediaQuery.removeEventListener('change', mediaQueryListener)
    mediaQueryListener = null
  }

  if (mode !== 'system') return

  mediaQueryListener = () => applyResolvedTheme('system')
  mediaQuery.addEventListener('change', mediaQueryListener)
}
