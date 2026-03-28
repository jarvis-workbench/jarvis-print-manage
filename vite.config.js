import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

// https://vite.dev/config/
export default defineConfig({
  base: './',
  plugins: [vue(), vueDevTools()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
})
