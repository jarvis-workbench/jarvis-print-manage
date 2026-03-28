const path = require('node:path')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const { app } = require('electron')

function toImportSpecifiers(filePath) {
  const normalizedPath = path.resolve(filePath)
  return [
    pathToFileURL(normalizedPath).href,
    `file:///${normalizedPath.replace(/\\/g, '/')}`,
  ]
}

async function loadMainEntry() {
  const specifiers = []

  if (app.isPackaged) {
    const unpackedEntryPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'electron', 'main.mjs')
    if (fs.existsSync(unpackedEntryPath)) {
      specifiers.push(...toImportSpecifiers(unpackedEntryPath))
    }
  }

  const entryPath = path.resolve(__dirname, 'main.mjs')
  specifiers.push('./main.mjs', ...toImportSpecifiers(entryPath))

  let lastError = null
  for (const specifier of new Set(specifiers)) {
    try {
      await import(specifier)
      return
    } catch (error) {
      lastError = error
    }
  }

  console.error('[main-loader] Failed to load ESM main entry:', lastError)
  process.exit(1)
}

void loadMainEntry()
