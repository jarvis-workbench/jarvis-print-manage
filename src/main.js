import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import router from './router'
import { applyThemeMode, bindSystemTheme } from './theme'

const defaultThemeMode = 'system'

if (window.eleDrive?.getSettings) {
  window.eleDrive
    .getSettings()
    .then((settings) => {
      const mode = settings?.themeMode || defaultThemeMode
      applyThemeMode(mode)
      bindSystemTheme(mode)
    })
    .catch(() => {
      applyThemeMode(defaultThemeMode)
      bindSystemTheme(defaultThemeMode)
    })
} else {
  applyThemeMode(defaultThemeMode)
  bindSystemTheme(defaultThemeMode)
}

createApp(App).use(router).mount('#app')
