<script setup>
import { onMounted, ref } from 'vue'

const version = ref('loading...')

onMounted(async () => {
  if (window.eleDrive?.getAppVersion) {
    version.value = await window.eleDrive.getAppVersion()
  } else {
    version.value = 'web-preview'
  }
})
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <h1>项目概览</h1>
      <span class="badge">v{{ version }}</span>
    </div>
    <p>当前已完成 Electron + Vue 3 + Vite 框架集成，并可读取本机打印机与驱动信息。</p>
    <p class="hint">建议流程：先到“系统设置”配置备份目录，再到“打印机管理”执行单项备份。</p>

    <div class="metric-grid">
      <article class="metric-card">
        <h3>系统设置</h3>
        <p>集中配置驱动备份目录，统一输出位置。</p>
      </article>
      <article class="metric-card">
        <h3>打印机管理</h3>
        <p>列出已安装打印机并一键备份对应驱动。</p>
      </article>
    </div>
  </section>
</template>
