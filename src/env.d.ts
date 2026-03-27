/// <reference types="vite/client" />

interface Window {
  eleDrive?: {
    getAppVersion: () => Promise<string>
  }
}
