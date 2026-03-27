import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const SIGN_FILE = path.join(__dirname, 'sign.json')
const PLACEHOLDER_PATTERN = /\{\{([A-Z0-9_]+)\}\}/g

const scriptCache = new Map()
let signManifestPromise = null

function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

async function getSignManifest() {
  if (!signManifestPromise) {
    signManifestPromise = fs.readFile(SIGN_FILE, 'utf8').then((text) => JSON.parse(text))
  }
  return signManifestPromise
}

function renderTemplate(template, replacements = {}) {
  const rendered = template.replace(PLACEHOLDER_PATTERN, (_, key) => {
    if (!Object.prototype.hasOwnProperty.call(replacements, key)) {
      throw new Error(`Missing PowerShell placeholder value: ${key}`)
    }
    const value = replacements[key]
    return value == null ? '' : String(value)
  })

  const unresolved = rendered.match(PLACEHOLDER_PATTERN)
  if (unresolved) {
    throw new Error(`Unresolved PowerShell placeholders: ${unresolved.join(', ')}`)
  }

  return rendered
}

async function readScriptTemplate(name) {
  const scriptName = String(name || '').trim()
  if (!scriptName) {
    throw new Error('PowerShell script name is required.')
  }
  if (scriptCache.has(scriptName)) {
    return scriptCache.get(scriptName)
  }

  const fileName = scriptName.endsWith('.scps1') ? scriptName : `${scriptName}.scps1`
  const absPath = path.join(__dirname, fileName)
  const text = await fs.readFile(absPath, 'utf8')
  scriptCache.set(scriptName, text)
  return text
}

async function verifyScriptIntegrity(name, template) {
  const manifest = await getSignManifest()
  const entry = manifest?.scripts?.[name]
  if (!entry) {
    throw new Error(`Missing sign entry for script: ${name}`)
  }

  const hash = sha256(template)
  if (hash !== entry.hash) {
    throw new Error(`PowerShell script hash mismatch: ${name}`)
  }

  const appHash = sha256(`${manifest.appId}:${hash}`)
  if (appHash !== entry.appHash) {
    throw new Error(`PowerShell script app hash mismatch: ${name}`)
  }
}

export async function loadPsScript(name, replacements = {}) {
  const scriptName = String(name || '').trim()
  const template = await readScriptTemplate(scriptName)
  await verifyScriptIntegrity(scriptName, template)
  return renderTemplate(template, replacements)
}
