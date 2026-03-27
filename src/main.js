import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import 'element-plus/theme-chalk/dark/css-vars.css'
import './style.css'
import App from './App.vue'
import router from './router'
import { applyThemeMode, bindSystemTheme } from './theme'
import { useRuntimeStore } from './stores/runtime'

const defaultThemeMode = 'system'
const app = createApp(App)
const pinia = createPinia()
const runtimeStore = useRuntimeStore(pinia)

if (window.eleDrive?.getSettings) {
  window.eleDrive
    .getSettings()
    .then((settings) => {
      const mode = settings?.themeMode || defaultThemeMode
      runtimeStore.setSettings(settings || {})
      applyThemeMode(mode)
      bindSystemTheme(mode)
    })
    .catch(() => {
      runtimeStore.setSettings({})
      applyThemeMode(defaultThemeMode)
      bindSystemTheme(defaultThemeMode)
    })
} else {
  runtimeStore.setSettings({})
  applyThemeMode(defaultThemeMode)
  bindSystemTheme(defaultThemeMode)
}

app.use(pinia).use(router).use(ElementPlus).mount('#app')
