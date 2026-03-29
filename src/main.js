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
let removePrintStateListener = null
let removePrintJobListener = null

function bindPrintServiceListeners() {
  if (typeof removePrintStateListener === 'function' || typeof removePrintJobListener === 'function') {
    return
  }
  if (window.eleDrive?.onPrintServiceStateUpdated) {
    removePrintStateListener = window.eleDrive.onPrintServiceStateUpdated((payload) => {
      runtimeStore.setPrintServiceState(payload || {})
    })
  }
  if (window.eleDrive?.onPrintJobUpdated) {
    removePrintJobListener = window.eleDrive.onPrintJobUpdated((payload) => {
      runtimeStore.upsertPrintJob(payload || {})
    })
  }
}

async function hydratePrintServiceRuntime() {
  if (window.eleDrive?.getPrintServiceState) {
    try {
      const state = await window.eleDrive.getPrintServiceState()
      runtimeStore.setPrintServiceState(state || {})
    } catch {}
  }
  if (window.eleDrive?.listPrintJobs) {
    try {
      const jobs = await window.eleDrive.listPrintJobs()
      runtimeStore.setPrintJobs(jobs || [])
    } catch {}
  }
}

if (window.eleDrive?.getSettings) {
  window.eleDrive
    .getSettings()
    .then((settings) => {
      const mode = settings?.themeMode || defaultThemeMode
      runtimeStore.setSettings(settings || {})
      applyThemeMode(mode)
      bindSystemTheme(mode)
      return hydratePrintServiceRuntime()
    })
    .catch(() => {
      runtimeStore.setSettings({})
      applyThemeMode(defaultThemeMode)
      bindSystemTheme(defaultThemeMode)
      return hydratePrintServiceRuntime()
    })
} else {
  runtimeStore.setSettings({})
  applyThemeMode(defaultThemeMode)
  bindSystemTheme(defaultThemeMode)
}

bindPrintServiceListeners()

app.use(pinia).use(router).use(ElementPlus).mount('#app')
