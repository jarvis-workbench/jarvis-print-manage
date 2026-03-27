<script setup>
import { RouterLink, RouterView } from 'vue-router'
</script>

<template>
  <main class="page">
    <header class="topbar">
      <RouterLink to="/" class="brand">EleDrive</RouterLink>
      <nav class="nav">
        <RouterLink to="/" class="nav-link">首页</RouterLink>
        <RouterLink to="/driver-install" class="nav-link">驱动安装</RouterLink>
      </nav>
    </header>
    <RouterView />
  </main>
</template>
