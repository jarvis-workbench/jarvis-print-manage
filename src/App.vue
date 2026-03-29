<script setup>
import { computed, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { Home, Printer, SettingConfig } from '@icon-park/vue-next'

const route = useRoute()
const router = useRouter()
let removeTrayNavigateListener = null

const activePath = computed(() => route.path)

function handleMenuSelect(path) {
  if (path !== route.path) router.push(path)
}

onMounted(() => {
  if (!window.eleDrive?.onTrayNavigate) return
  removeTrayNavigateListener = window.eleDrive.onTrayNavigate((payload) => {
    const targetPath = String(payload?.path || '/')
    if (targetPath !== route.path) {
      router.push(targetPath)
    }
  })
})

onUnmounted(() => {
  if (typeof removeTrayNavigateListener === 'function') {
    removeTrayNavigateListener()
  }
  removeTrayNavigateListener = null
})
</script>

<template>
  <el-container class="shell">
    <el-aside class="sidebar" width="172px">
      <div class="brand">虹色图文助手</div>
      <div class="brand-subtitle">图文行业-计算机一站式解决方案</div>

      <el-menu class="nav-menu" :default-active="activePath" @select="handleMenuSelect">
        <el-menu-item index="/">
          <div class="nav-item-content">
            <span class="menu-icon"><home theme="outline" size="16" /></span>
            <span class="menu-label">首页</span>
          </div>
        </el-menu-item>
        <el-menu-item index="/printers">
          <div class="nav-item-content">
            <span class="menu-icon"><printer theme="outline" size="16" /></span>
            <span class="menu-label">打印机管理</span>
          </div>
        </el-menu-item>
        <el-menu-item index="/settings">
          <div class="nav-item-content">
            <span class="menu-icon"><setting-config theme="outline" size="16" /></span>
            <span class="menu-label">系统设置</span>
          </div>
        </el-menu-item>
      </el-menu>
    </el-aside>

    <el-main class="content-wrap">
      <router-view v-slot="{ Component, route }">
        <keep-alive>
          <component
            :is="Component"
            v-if="route.name === 'printers'"
            :key="route.name || route.path"
          />
        </keep-alive>
        <component
          :is="Component"
          v-if="route.name !== 'printers'"
          :key="route.name || route.path"
        />
      </router-view>
    </el-main>
  </el-container>
</template>
