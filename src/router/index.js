import { createRouter, createWebHashHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'
import DriverInstallView from '../views/DriverInstallView.vue'
import SettingsView from '../views/SettingsView.vue'
import PrintersView from '../views/PrintersView.vue'

const routes = [
  {
    path: '/',
    name: 'home',
    component: HomeView,
  },
  {
    path: '/driver-install',
    name: 'driver-install',
    component: DriverInstallView,
  },
  {
    path: '/settings',
    name: 'settings',
    component: SettingsView,
  },
  {
    path: '/printers',
    name: 'printers',
    component: PrintersView,
  },
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

export default router
