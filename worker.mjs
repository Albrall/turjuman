// Runs the addon on Cloudflare, either as a Worker or as the _worker.js of a Pages project.
// The addon itself is lib/app.mjs; this file gives it Cloudflare's storage and limits.
//
// Bind a KV namespace under the name CACHE to keep translations. Without it they live only as long as the
// isolate that made them, and every new viewing may translate again.

import { createApp } from './lib/app.mjs'
import page from './public/configure.html'
import logoBase64 from './public/logo.png'

let logo = null

const kvStore = kv => ({
  kind: 'kv',
  getFinal: key => kv.get(`f:${key}`, { cacheTtl: 30 }),
  putFinal: (key, vtt) => kv.put(`f:${key}`, vtt),
  // asked for every subtitle in a list: the value is not read, only whether it is there
  hasFinal: async key => {
    const body = await kv.get(`f:${key}`, { type: 'stream', cacheTtl: 30 })
    if (!body) return false
    await body.cancel().catch(() => {})
    return true
  },
  // When a subtitle was first picked. Kept here because the second pick may come to another isolate; forgotten after 15 minutes.
  getArmed: key => kv.get(`a:${key}`, { cacheTtl: 30 }),
  putArmed: (key, at) => kv.put(`a:${key}`, String(at), { expirationTtl: 900 }),
  // A translation cut off half-way is of no use after a day
  getProgress: key => kv.get(`p:${key}`, { type: 'json', cacheTtl: 30 }),
  putProgress: (key, data) => kv.put(`p:${key}`, JSON.stringify(data), { expirationTtl: 86_400 }),
  // The name dictionary of a show (ideas 14 + 17): one small JSON per show, kept indefinitely
  getNames: key => kv.get(`n:${key}`, { type: 'json', cacheTtl: 30 }),
  putNames: (key, data) => kv.put(`n:${key}`, JSON.stringify(data)),
  // The monthly ledger (idea 38): one small JSON per month, kept indefinitely
  getReport: key => kv.get(`r:${key}`, { type: 'json', cacheTtl: 30 }),
  putReport: (key, data) => kv.put(`r:${key}`, JSON.stringify(data)),
  probe: async () => {
    await kv.get('probe')
    return true
  },
})

const noStore = {
  kind: 'none',
  getFinal: async () => null,
  putFinal: async () => {},
  getProgress: async () => null,
  putProgress: async () => {},
  getNames: async () => null,
  putNames: async () => {},
  getReport: async () => null,
  putReport: async () => {},
  probe: async () => false,
}

const platformFor = env => {
  const setting = name => (typeof env[name] === 'string' ? env[name] : undefined)
  const number = (name, fallback) => (Number.isFinite(Number(setting(name))) && setting(name) !== '' && setting(name) !== undefined ? Number(setting(name)) : fallback)
  return {
    runtime: 'cloudflare',
    env: setting,
    page,
    hasLogo: true,
    logo: () => (logo ??= Uint8Array.from(atob(logoBase64), char => char.charCodeAt(0))),
    store: env.CACHE?.get ? kvStore(env.CACHE) : noStore,
    // Free plan: 50 subrequests/request and 30 s after the client leaves. 32 model calls leave a real
    // margin for the source list, the extra providers, the verification downloads and the KV writes.
    // On a paid plan HELPER_BUDGET can be raised again.
    limits: {
      budget: number('HELPER_BUDGET', 32),
      lingerMs: number('LINGER_MS', 18_000),
      progressEveryMs: number('PROGRESS_EVERY_MS', 15_000),
      maxBoards: 12,
      maxConcurrency: 5,   // of the 6 connections a request may have open at once, one is left for the store
    },
  }
}

let handle

export default {
  fetch(request, env, ctx) {
    handle ??= createApp(platformFor(env))
    return handle(request, ctx)
  },
}
