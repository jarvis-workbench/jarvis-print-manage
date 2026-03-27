<script setup>
import { onMounted, ref } from 'vue'
import { Success, SettingConfig, Printer } from '@icon-park/vue-next'

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
  <el-card class="panel-card" shadow="never">
    <template #header>
      <div class="panel-head">
        <div class="panel-title-wrap">
          <h1>项目概览</h1>
          <el-tag type="success" effect="dark">v{{ version }}</el-tag>
        </div>
      </div>
    </template>

    <el-space direction="vertical" :size="10" fill>
      <p>当前已完成 Electron + Vue 3 + Vite 基础框架与打印机管理能力。</p>
      <p class="hint">建议流程：先到系统设置配置备份目录，再到打印机管理执行驱动备份。</p>
    </el-space>

    <el-row :gutter="12" class="metric-row">
      <el-col :span="12">
        <el-card class="metric-card" shadow="hover">
          <div class="metric-title">
            <setting-config theme="outline" size="16" />
            <span>系统设置</span>
          </div>
          <p>配置主题与备份目录，支持自动保存。</p>
        </el-card>
      </el-col>
      <el-col :span="12">
        <el-card class="metric-card" shadow="hover">
          <div class="metric-title">
            <printer theme="outline" size="16" />
            <span>打印机管理</span>
          </div>
          <p>查看已安装打印机和驱动，并一键备份。</p>
        </el-card>
      </el-col>
    </el-row>

    <div class="status-line">
      <success theme="outline" size="16" />
      <span>当前运行状态正常</span>
    </div>
  </el-card>
</template>
