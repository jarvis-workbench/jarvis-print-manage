<script setup>
import { RouterLink, RouterView } from 'vue-router'
</script>

<template>
  <main class="shell">
    <aside class="sidebar">
      <RouterLink to="/" class="brand">虹色打印机助手</RouterLink>
      <p class="brand-subtitle">Printer Driver Toolkit</p>
      <nav class="nav">
        <RouterLink to="/" class="nav-link">概览</RouterLink>
        <RouterLink to="/printers" class="nav-link">打印机管理</RouterLink>
        <RouterLink to="/settings" class="nav-link">系统设置</RouterLink>
      </nav>
    </aside>
    <section class="content-wrap">
      <RouterView />
    </section>
  </main>
</template>
