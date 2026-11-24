#!/usr/bin/env node
// Runs the addon as a plain Node server, with no dependencies: node server.mjs
// The addon itself is lib/app.mjs; this file gives it a port, the disk and the log.

import { lookup } from 'node:dns/promises'
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { VERSION, createApp as createHandler } from './lib/app.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const page = await readFile(join(HERE, 'public', 'configure.html'), 'utf8')
const logo = await readFile(join(HERE, 'public', 'logo.png')).catch(() => null)

const cacheDir = () => process.env.CACHE_DIR || join(process.cwd(), 'cache')
const MAX_FILES = 400

// Finished translations are kept as files, so that watching again costs nothing
const store = {
  kind: 'disk',
  getFinal: key => readFile(join(cacheDir(), `${key}.vtt`), 'utf8').catch(() => null),
  hasFinal: key => stat(join(cacheDir(), `${key}.vtt`)).then(() => true, () => false),
  async putFinal(key, vtt) {
    const dir = cacheDir()
    await mkdir(dir, { recursive: true })
    const file = join(dir, `${key}.vtt`)
    await writeFile(`${file}.tmp`, vtt)
    await rename(`${file}.tmp`, file)
    const files = (await readdir(dir)).filter(name => name.endsWith('.vtt'))
    if (files.length <= MAX_FILES) return
    const aged = await Promise.all(files.map(async name => ({ name, at: (await stat(join(dir, name))).mtimeMs })))
    for (const { name } of aged.sort((a, b) => a.at - b.at).slice(0, files.length - MAX_FILES)) await unlink(join(dir, name)).catch(() => {})
  },
  // One process holds a running translation in memory from its first line to its last: nothing to save half-way
  getProgress: async () => null,
  putProgress: async () => {},
  // The name dictionary of a show (ideas 14 + 17): one small JSON per show
  getNames: key => readFile(join(cacheDir(), `series-${key}.json`), 'utf8').then(JSON.parse, () => null),
  async putNames(key, data) {
    const dir = cacheDir()
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `series-${key}.json`), JSON.stringify(data))
  },
  // The monthly ledger (idea 38): one small JSON per month, kept next to the translations
  getReport: key => readFile(join(cacheDir(), `report-${key}.json`), 'utf8').then(JSON.parse, () => null),
  async putReport(key, data) {
    const dir = cacheDir()
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `report-${key}.json`), JSON.stringify(data))
  },
  probe: async () => true,
}

const platform = {
  runtime: 'node',
  env: name => process.env[name],
  page,
  hasLogo: Boolean(logo),
  logo: () => logo,
  store,
  lookup: async host => (await lookup(host, { all: true })).map(entry => entry.address),
  limits: { budget: Infinity, lingerMs: Infinity, progressEveryMs: 0, maxBoards: 40, maxConcurrency: 8 },
  log: line => console.error(`  ${line}`),
}

const MAX_BODY = 16 * 1024

const readBody = req => new Promise((resolve, reject) => {
  let body = ''
  req.setEncoding('utf8')
  req.on('data', chunk => {
    body += chunk
    if (body.length > MAX_BODY) reject(new RangeError('body too large'))
  })
  req.on('end', () => resolve(body))
  req.on('error', reject)
})

const toRequest = async req => {
  const host = /^[\w.:[\]-]+$/.test(req.headers.host || '') ? req.headers.host : '127.0.0.1'
  const headers = new Headers()
  for (const [name, value] of Object.entries(req.headers)) {
    try { if (typeof value === 'string') headers.set(name, value) } catch {}
  }
  const body = req.method === 'POST' ? await readBody(req) : undefined
  return new Request(`http://${host}${req.url}`, { method: req.method, headers, body })
}

// A held subtitle is sent piece by piece as the app writes it
const send = async (response, req, res) => {
  res.writeHead(response.status, Object.fromEntries(response.headers))
  if (!response.body || req.method === 'HEAD') {
    response.body?.cancel().catch(() => {})
    return res.end()
  }
  const reader = response.body.getReader()
  res.once('close', () => { if (!res.writableFinished) reader.cancel().catch(() => {}) })
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    res.write(value)
  }
  res.end()
}

// The settings in an address hold the API key: they are kept out of the log
const masked = url => url.split('?')[0].replace(/^\/[A-Za-z0-9_-]{40,}\//, '/<settings>/').replace(/\/t\/([A-Za-z0-9_-]{10})[A-Za-z0-9_-]+/, '/t/$1…').slice(0, 160)

export const createApp = () => {
  const handle = createHandler(platform)
  // A plain server has no deadline after it answers: work that outlives a request simply goes on
  const ctx = { waitUntil: promise => { Promise.resolve(promise).catch(error => console.error(`  ${error?.stack || error}`)) } }
  return createServer(async (req, res) => {
    const started = Date.now()
    try {
      if (!['GET', 'HEAD', 'POST', 'OPTIONS'].includes(req.method) || !req.url.startsWith('/')) {
        res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8', 'access-control-allow-origin': '*' })
        res.end('method not allowed')
      } else {
        await send(await handle(await toRequest(req), ctx), req, res)
      }
    } catch (error) {
      if (!(error instanceof RangeError)) console.error(`  ${error.stack || error}`)
      if (!res.headersSent) res.writeHead(error instanceof RangeError ? 413 : 500, { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' })
      res.end(res.writableEnded ? undefined : JSON.stringify({ error: error instanceof RangeError ? 'الطلب أكبر من المتوقع' : 'خطأ داخلي' }))
    }
    if (process.env.QUIET !== '1') console.log(`${req.method} ${masked(req.url || '/')} → ${res.statusCode} in ${Date.now() - started}ms`)
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 7000
  createApp().listen(port, '0.0.0.0', () => {
    console.log(`Tarjuman ${VERSION} is listening on port ${port}`)
    console.log(`Settings page: http://127.0.0.1:${port}/`)
  })
}
