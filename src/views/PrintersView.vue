<script setup>
import { computed, onMounted, ref } from 'vue'

const loading = ref(false)
const backingPrinter = ref('')
const error = ref('')
const message = ref('')
const printers = ref([])

const totalPrinters = computed(() => printers.value.length)

async function loadPrinters() {
  if (!window.eleDrive?.listInstalledPrinters) return
  loading.value = true
  error.value = ''
  message.value = ''
  try {
    printers.value = await window.eleDrive.listInstalledPrinters()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

async function backupDriver(printer) {
  if (!window.eleDrive?.backupPrinterDriver) return
  backingPrinter.value = printer.name
  error.value = ''
  message.value = ''
  try {
    const result = await window.eleDrive.backupPrinterDriver({ printerName: printer.name })
    message.value = `已备份驱动“${result.driverName}”至：${result.backupDir}`
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    backingPrinter.value = ''
  }
}

onMounted(loadPrinters)
</script>

<template>
  <section class="panel">
    <div class="panel-head">
      <h1>打印机管理</h1>
      <div class="row-actions">
        <span class="badge badge-soft">共 {{ totalPrinters }} 台</span>
        <button class="btn" type="button" :disabled="loading" @click="loadPrinters">
          {{ loading ? '刷新中...' : '刷新列表' }}
        </button>
      </div>
    </div>
    <p class="hint">列出已安装打印机与驱动，每一项可单独执行驱动备份。</p>

    <p v-if="message" class="ok-text">{{ message }}</p>
    <p v-if="error" class="error-text">{{ error }}</p>
    <div v-if="loading" class="state-text">正在读取已安装打印机...</div>

    <div v-else class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th class="col-printer">打印机</th>
            <th class="col-driver">驱动</th>
            <th class="col-inf">INF</th>
            <th class="col-action">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in printers" :key="item.name">
            <td>
              <div class="cell-title truncate" :title="item.name">{{ item.name }}</div>
              <div class="muted truncate" :title="item.portName || '-'">端口：{{ item.portName || '-' }}</div>
            </td>
            <td>
              <div class="cell-title truncate" :title="item.driverName || '-'">{{ item.driverName || '-' }}</div>
              <div class="muted truncate" :title="item.driver?.manufacturer || '-'">{{ item.driver?.manufacturer || '-' }}</div>
            </td>
            <td class="mono truncate" :title="item.driver?.infPath || '-'">{{ item.driver?.infPath || '-' }}</td>
            <td>
              <button
                class="btn btn-primary"
                type="button"
                :disabled="backingPrinter === item.name"
                @click="backupDriver(item)"
              >
                {{ backingPrinter === item.name ? '备份中...' : '备份驱动' }}
              </button>
            </td>
          </tr>
          <tr v-if="printers.length === 0">
            <td colspan="4" class="empty-cell">未读取到已安装打印机。</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
