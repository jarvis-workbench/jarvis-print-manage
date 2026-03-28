const path = require('node:path')
const { pathToFileURL } = require('node:url')

const entryUrl = pathToFileURL(path.join(__dirname, 'main.mjs')).href

import(entryUrl).catch((error) => {
  console.error('[main-loader] Failed to load ESM main entry:', error)
  process.exit(1)
})
