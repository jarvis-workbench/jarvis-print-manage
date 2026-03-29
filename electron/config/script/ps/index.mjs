import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const PLACEHOLDER_PATTERN = /\{\{([A-Z0-9_]+)\}\}/g

const scriptCache = new Map()
let scriptRootPromise = null
let signManifestRoot = ''
let signManifestPromise = null

function uniq(values = []) {
  return [...new Set(values.filter(Boolean))]
}

function buildScriptRootCandidates() {
  const resourcesPath = String(process.resourcesPath || '').trim()
  const candidates = [
    __dirname,
  ]

  if (resourcesPath) {
    candidates.push(path.join(resourcesPath, 'app.asar', 'electron', 'config', 'script', 'ps'))
    candidates.push(path.join(resourcesPath, 'app.asar.unpacked', 'electron', 'config', 'script', 'ps'))
  }

  return uniq(candidates)
}

async function resolveScriptRoot() {
  if (!scriptRootPromise) {
    scriptRootPromise = (async () => {
      const candidates = buildScriptRootCandidates()
      for (const root of candidates) {
        const signFile = path.join(root, 'sign.json')
        try {
          const stat = await fs.stat(signFile)
          if (stat.isFile()) {
            return root
          }
        } catch {}
      }
      throw new Error(`PowerShell script root not found. Tried: ${candidates.join(' | ')}`)
    })()
  }
  return scriptRootPromise
}

function sha256(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex')
}

async function getSignManifest() {
  const root = await resolveScriptRoot()
  if (!signManifestPromise || signManifestRoot !== root) {
    signManifestRoot = root
    signManifestPromise = fs.readFile(path.join(root, 'sign.json'), 'utf8').then((text) => JSON.parse(text))
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
  const root = await resolveScriptRoot()
  const cacheKey = `${root}::${scriptName}`
  if (scriptCache.has(cacheKey)) {
    return scriptCache.get(cacheKey)
  }

  const fileName = scriptName.endsWith('.scps1') ? scriptName : `${scriptName}.scps1`
  const absPath = path.join(root, fileName)
  const text = await fs.readFile(absPath, 'utf8')
  scriptCache.set(cacheKey, text)
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
