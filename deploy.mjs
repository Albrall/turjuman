#!/usr/bin/env node
// Puts cloudflare/_worker.js on Cloudflare as a Worker, with a KV namespace bound as CACHE, through Cloudflare's API.
//
//   CLOUDFLARE_API_TOKEN=… node deploy.mjs
//
// The token is read from the environment and is written nowhere. It needs: Workers Scripts (edit) and Workers KV Storage (edit).
// Optional: CLOUDFLARE_ACCOUNT_ID (when the token sees several accounts), WORKER_NAME (default "tarjuman"), KV_TITLE.
//
// It creates one Worker and one KV namespace and touches nothing else. A Worker of the same name that this script did
// not put there is left alone.

import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const API = 'https://api.cloudflare.com/client/v4'
const TAG = 'tarjuman-addon'   // how the script knows a Worker as its own
const token = process.env.CLOUDFLARE_API_TOKEN
const name = process.env.WORKER_NAME || 'tarjuman'
const kvTitle = process.env.KV_TITLE || 'tarjuman-cache'

const fail = message => {
  console.error(`✗ ${message}`)
  process.exit(1)
}
if (!token) fail('set CLOUDFLARE_API_TOKEN')
if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) fail('WORKER_NAME: lower-case letters, digits and dashes')

// Cloudflare's answer, or null where the thing asked for is not there
const call = async (path, { missing = false, ...init } = {}) => {
  const response = await fetch(`${API}${path}`, { ...init, headers: { authorization: `Bearer ${token}`, ...init.headers }, signal: AbortSignal.timeout(60_000) })
  const data = await response.json().catch(() => ({}))
  if (missing && response.status === 404) return null
  if (!response.ok || data.success === false) fail(`${init.method || 'GET'} ${path.replace(/[0-9a-f]{32}/g, '…')} → ${response.status}: ${(data.errors || []).map(error => error.message).join('; ') || 'no reason given'}`)
  return data.result
}
const json = (method, body) => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

const accounts = await call('/accounts?per_page=50')
const account = process.env.CLOUDFLARE_ACCOUNT_ID ? accounts.find(entry => entry.id === process.env.CLOUDFLARE_ACCOUNT_ID) : accounts.length === 1 ? accounts[0] : null
if (!account) fail(accounts.length ? 'this token sees several accounts: set CLOUDFLARE_ACCOUNT_ID' : 'this token sees no account')
const base = `/accounts/${account.id}`

// A Worker of this name that is someone else's is not overwritten
const existing = (await call(`${base}/workers/scripts`)).find(script => script.id === name)
if (existing && !(existing.tags || []).includes(TAG)) fail(`a Worker named "${name}" is already there and was not made by this script: pick another WORKER_NAME`)

let namespace = (await call(`${base}/storage/kv/namespaces?per_page=100`)).find(entry => entry.title === kvTitle)
if (namespace) console.log(`· KV namespace "${kvTitle}": already there`)
else {
  namespace = await call(`${base}/storage/kv/namespaces`, json('POST', { title: kvTitle }))
  console.log(`· KV namespace "${kvTitle}": created`)
}

const script = await readFile(join(HERE, 'cloudflare', '_worker.js'))
const form = new FormData()
form.set('metadata', JSON.stringify({
  main_module: '_worker.js',
  compatibility_date: '2026-01-20',   // the date the tests run it under
  bindings: [{ type: 'kv_namespace', name: 'CACHE', namespace_id: namespace.id }],
  tags: [TAG],
}))
form.set('_worker.js', new Blob([script], { type: 'application/javascript+module' }), '_worker.js')
await call(`${base}/workers/scripts/${name}`, { method: 'PUT', body: form })
console.log(`· Worker "${name}": ${existing ? 'updated' : 'created'} (${(script.length / 1024).toFixed(0)} KB)`)

// Its address under the account's workers.dev name
await call(`${base}/workers/scripts/${name}/subdomain`, json('POST', { enabled: true, previews_enabled: false }))
const { subdomain } = (await call(`${base}/workers/subdomain`, { missing: true })) || {}
if (!subdomain) fail('the account has no workers.dev name yet: open Workers & Pages once in the dashboard to choose one, then run this again')
const url = `https://${name}.${subdomain}.workers.dev`

// A new address takes some seconds to answer
let status
for (let attempt = 0; attempt < 30 && !status; attempt++) {
  try {
    const response = await fetch(`${url}/api/status`, { signal: AbortSignal.timeout(15_000) })
    if (response.ok) status = await response.json()
  } catch {}
  if (!status) await new Promise(resolve => setTimeout(resolve, 3000))
}
if (!status) fail(`deployed, but ${url} does not answer yet: try it in a minute`)
console.log(`· answers: version ${status.version}, runtime ${status.runtime}, storage ${status.storage}, subtitles source ${status.source.ok ? 'reachable' : `NOT reachable (${status.source.status || status.source.error})`}`)
console.log(`\n${url}`)
