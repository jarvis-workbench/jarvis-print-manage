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
  <section class="card">
    <h1>EleDrive</h1>
    <p>Electron + Vue 3 + Vite base framework is ready.</p>
    <p>App Version: {{ version }}</p>
    <p class="hint">Next step: build driver package download and install flow.</p>
  </section>
</template>
