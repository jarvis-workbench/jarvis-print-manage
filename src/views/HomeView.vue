<script setup>
import { computed, onMounted, ref } from 'vue'
import { Success, SettingConfig, Printer } from '@icon-park/vue-next'

const version = ref('loading...')
const versionLabel = computed(() => {
  const value = String(version.value || '').trim()
  if (!value || value === 'loading...') return '加载中'
  if (value === 'web-preview') return '预览'
  return value.startsWith('v') ? value : `v${value}`
})

onMounted(async () => {
  if (window.eleDrive?.getAppVersion) {
    version.value = await window.eleDrive.getAppVersion()
  } else {
    version.value = 'web-preview'
  }
})
</script>

<template>
  <el-card class="panel-card home-panel" shadow="never">
    <template #header>
      <div class="panel-head">
        <div class="panel-title-wrap">
          <h1>首页</h1>
          <el-tag type="success">{{ versionLabel }}</el-tag>
        </div>
      </div>
    </template>

    <section class="home-intro">
      <div class="home-kicker">打印机驱动维护工具</div>
      <h2>管理本机打印机、备份驱动，并从本地或局域网恢复驱动。</h2>
      <p>
        先维护驱动备份目录，再在打印机管理中查看设备状态、执行备份或安装。
        所有操作都围绕打印机驱动维护展开，不需要关注底层技术细节。
      </p>
    </section>

    <section class="home-section">
      <div class="home-section-title">核心能力</div>
      <div class="home-action-list">
        <div class="home-action-item">
          <div class="home-action-icon">
            <printer theme="outline" size="17" />
          </div>
          <div class="home-action-main">
            <div class="home-action-title">打印机管理</div>
            <div class="home-action-desc">查看已安装打印机、备份驱动、安装本地驱动或网络驱动。</div>
          </div>
        </div>

        <div class="home-action-item">
          <div class="home-action-icon">
            <setting-config theme="outline" size="16" />
          </div>
          <div class="home-action-main">
            <div class="home-action-title">系统设置</div>
            <div class="home-action-desc">设置驱动备份目录、主题模式、局域网组网和虚拟打印机过滤规则。</div>
          </div>
        </div>
      </div>
    </section>

    <section class="home-section">
      <div class="home-section-title">推荐流程</div>
      <div class="home-step-list">
        <div class="home-step-item">
          <span class="home-step-index">1</span>
          <span>在系统设置中确认驱动备份目录。</span>
        </div>
        <div class="home-step-item">
          <span class="home-step-index">2</span>
          <span>进入打印机管理，刷新并检查当前打印机状态。</span>
        </div>
        <div class="home-step-item">
          <span class="home-step-index">3</span>
          <span>按需执行驱动备份、恢复安装或局域网驱动安装。</span>
        </div>
      </div>
    </section>

    <section class="home-status">
      <success theme="outline" size="16" />
      <span>客户端运行正常</span>
    </section>
  </el-card>
</template>
