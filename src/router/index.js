import { createRouter, createWebHashHistory } from 'vue-router'
import HomeView from '../views/HomeView.vue'
import DriverInstallView from '../views/DriverInstallView.vue'

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
]

const router = createRouter({
  history: createWebHashHistory(),
  routes,
})

export default router
