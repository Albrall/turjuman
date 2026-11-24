// The user's settings travel in the addon's address, as Stremio addons do: /<settings>/manifest.json
// They are JSON in base64url. The API key is among them, so the address is to be treated as a secret.
// Web APIs only: this file runs the same on Node and on Cloudflare.

export class ConfigError extends Error {}

const number = (value, fallback, min, max) => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.round(parsed))) : fallback
}
const flag = (value, fallback) => (value === undefined ? fallback : Boolean(Number(value) || value === true))

const EFFORTS = ['', 'minimal', 'low', 'medium', 'high']

export const encodeText = text => {
  let binary = ''
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
export const decodeText = segment => {
  const binary = atob(segment.replace(/-/g, '+').replace(/_/g, '/'))
  return new TextDecoder().decode(Uint8Array.from(binary, char => char.charCodeAt(0)))
}

// b: provider address · k: API key · m: model · r: reasoning effort · src: language to translate from · any: or any other language
// warm: start translating when the subtitles are listed · sdh: leave out sound descriptions · pn: prepare the next episode too (idea 10) · n: subtitles listed
// wait: seconds a subtitle request is held for the whole translation before a partial one is sent
// bs: lines per request to the model · cc: requests at once
// nm: read the whole subtitle once before translating, to know its names and recurring terms (one more request per title)
// nt: after the last line is in, write up to three fansub-style notes over the episode (one more request per video)
// fb/fk/fm: an optional backup provider — used at most once per translated episode, never unless the primary failed
// cf: a subtitle that was never translated is only translated once it is picked a second time. Players fetch subtitles on
//     their own (Nuvio downloads them when a video starts, to pick one and to check its timing), and each such download
//     would otherwise start a translation nobody asked for.
// na: do not offer AI translation when a ready-made Arabic subtitle exists — the ready Arabic is enough.
// ca: let the AI compare ready-made Arabic subtitles and pick the best one before showing them (spends a few tokens per video)
// gd: the wrong-episode guard. A subtitle whose release name (or opening lines) say it belongs to another episode is
//     never translated; the addon searches episodes next to the requested one for a matching file before giving up.
// pk: separate multi-episode packs (1-13) automatically and re-base the requested episode to zero. When off, a pack
//     is not served at all — never shown as a wrong episode.
export const normalize = input => {
  if (!input || typeof input !== 'object') throw new ConfigError('الإعدادات غير مقروءة')
  const base = String(input.b || '').trim().replace(/\/+$/, '')
  let url
  try { url = new URL(base) } catch { throw new ConfigError('رابط مزود الـAI غير صحيح') }
  if (!['https:', 'http:'].includes(url.protocol)) throw new ConfigError('رابط مزود الـAI غير صحيح')
  const model = String(input.m || '').trim()
  if (!model || model.length > 120) throw new ConfigError('اسم النموذج مطلوب')
  const key = String(input.k || '').trim()
  if (key.length > 400) throw new ConfigError('مفتاح الـAI أطول من المتوقع')
  const source = String(input.src || 'eng').toLowerCase()
  const fallbackBase = String(input.fb || '').trim().replace(/\/+$/, '')
  if (fallbackBase) {
    let fallbackUrl
    try { fallbackUrl = new URL(fallbackBase) } catch { throw new ConfigError('رابط المزوّد الاحتياطي غير صحيح') }
    if (!['https:', 'http:'].includes(fallbackUrl.protocol)) throw new ConfigError('رابط المزوّد الاحتياطي غير صحيح')
  }
  return {
    b: base, k: key, m: model,
    r: EFFORTS.includes(input.r) ? input.r : '',
    src: /^[a-z]{3}$/.test(source) ? source : 'eng',
    any: flag(input.any, true), warm: flag(input.warm, true), sdh: flag(input.sdh, true), nm: flag(input.nm, true), pn: flag(input.pn, true),
    nt: flag(input.nt, true),
    fb: fallbackBase, fk: String(input.fk || '').trim().slice(0, 400), fm: String(input.fm || '').trim().slice(0, 120),
    cf: flag(input.cf, true),
    // na: لا تُظهر خيار الترجمة إن وُجد ترجمة عربية جاهزة — يُكتفى بالعربي من المصادر
    na: flag(input.na, false),
    // ca: يقارن الذكاء الاصطناعي بين الترجمات العربية الجاهزة ويختار أفضلها قبل العرض (يصرف توكنز بسيطة لكل فيديو)
    ca: flag(input.ca, false),
    // ex: رابط مصدر إضافي للترجمات (مثل أوكستندد/بوب كورن نوتس) — اختياري، افتراضيًا المضيف الرسمي
    ex: String(input.ex || '').trim().slice(0, 200),
    // مفاتيح مصادر الترجمة الإضافية (فكرة 25) — كل مستخدم يدخل مفاتيحه؛ بغيابها المزود يُتخطى صامتًا
    sd: String(input.sd || '').trim().slice(0, 120), jm: String(input.jm || '').trim().slice(0, 120),
    n: number(input.n, 2, 1, 3), wait: number(input.wait, 50, 0, 120), bs: number(input.bs, 80, 5, 200), cc: number(input.cc, 4, 1, 8),
    gd: flag(input.gd, true),
    pk: flag(input.pk, true),
  }
}

export const encodeConfig = config => encodeText(JSON.stringify(config))

export const decodeConfig = segment => {
  if (!/^[A-Za-z0-9_-]{8,4000}$/.test(segment)) throw new ConfigError('الإعدادات غير مقروءة')
  let parsed
  try { parsed = JSON.parse(decodeText(segment)) } catch { throw new ConfigError('الإعدادات غير مقروءة') }
  return normalize(parsed)
}

// The server sends requests to whatever provider address the settings name. On a public server that must not reach the
// machine itself or its private network; allowLocal lifts this for a model running at home (Ollama, LM Studio).

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/

export const isPrivateAddress = address => {
  if (IPV4.test(address)) {
    const [a, b] = address.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  const v6 = address.toLowerCase()
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('::ffff:')
}

const LOCAL_NAME = /(^|\.)(localhost|local|internal|lan|home\.arpa)$/i

const checked = new Map()   // host → the time it was last found public

// lookup: host → its addresses, where the platform can resolve names (Node). Without it, the name itself is judged.
export const assertProviderAllowed = async (base, { allowLocal = false, lookup } = {}) => {
  if (allowLocal) return
  const url = new URL(base)
  if (url.protocol !== 'https:') throw new ConfigError('رابط مزود الـAI يجب أن يبدأ بـ https')
  if (Date.now() - (checked.get(url.hostname) ?? 0) < 10 * 60_000) return
  const host = url.hostname.replace(/^\[|\]$/g, '')
  const literal = IPV4.test(host) || host.includes(':')
  if (!literal && LOCAL_NAME.test(host)) throw new ConfigError('عنوان مزود الـAI غير مسموح (شبكة داخلية)')
  let addresses = [host]
  if (!literal && lookup) {
    try { addresses = await lookup(host) } catch { throw new ConfigError('تعذّر الوصول إلى عنوان مزود الـAI') }
  }
  if (!addresses.length || (literal || lookup ? addresses.some(isPrivateAddress) : false)) throw new ConfigError('عنوان مزود الـAI غير مسموح (شبكة داخلية)')
  if (checked.size > 200) checked.clear()
  checked.set(url.hostname, Date.now())
}

// One gate for every outgoing request: https only, no private hosts, no unbounded redirects.
// A 302 from an allowed host to an internal address must be checked again before it is followed.
export const MAX_REDIRECTS = 2
export const isPrivateHost = host => {
  if (IPV4.test(host)) {
    const [a, b] = host.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127)
  }
  const v6 = host.toLowerCase()
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe80') || v6.startsWith('::ffff:') || LOCAL_NAME.test(host)
}
export const safeFetch = async (input, init = {}) => {
  let url = typeof input === 'string' ? input : input.url || String(input)
  let redirects = 0
  for (;;) {
    const u = new URL(url)
    const host = u.hostname.replace(/^\[|\]$/g, '')
    const loopback = host === 'localhost' || host === '::1' || /^127\./.test(host)
    // http مسموح على الجهاز نفسه فقط (مزوّد محلي / اختبارات)؛ وكل ما عداه https وبعيد عن العناوين الخاصة
    if (u.protocol === 'http:' && loopback) { /* local only */ }
    else {
      if (u.protocol !== 'https:') throw new Error(`رابط غير آمن: ${url}`)
      if (isPrivateHost(host)) throw new Error(`عنوان داخلي غير مسموح: ${url}`)
    }
    const response = await fetch(url, { ...init, redirect: 'manual' })
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location')
      if (!location) return response
      if (redirects >= MAX_REDIRECTS) throw new Error(`تحويلات كثيرة جداً: ${url}`)
      redirects++
      url = new URL(location, u).toString()
      await response.body?.cancel?.()
      continue
    }
    return response
  }
}

// Ceilings for anything downloaded from a subtitle provider. On the Workers Free plan an isolate
// gets only 128 MB: a "zip bomb" must be refused BEFORE it is inflated, not after.
export const MAX_SUBTITLE_BYTES = 1_000_000      // نص الترجمة / رد JSON
export const MAX_ZIP_BYTES = 2_000_000          // الحزمة المضغوطة
export const MAX_UNZIPPED_BYTES = 4_000_000     // مجموع الملفات بعد الفك
export const MAX_MODEL_BYTES = 256_000          // رد مزوّد الذكاء

const tooLarge = max => new Error(`الملف أكبر من الحد المسموح (${max} بايت)`)

export const readLimited = async (response, max = MAX_SUBTITLE_BYTES) => {
  const declared = Number(response.headers.get('content-length') || 0)
  if (declared > max) {
    await response.body?.cancel?.()
    throw tooLarge(max)
  }
  const body = response.body
  if (!body || typeof body.getReader !== 'function') {
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.byteLength > max) throw tooLarge(max)
    return bytes
  }
  const reader = body.getReader()
  const chunks = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
      total += chunk.byteLength
      if (total > max) { await reader.cancel(); throw tooLarge(max) }
      chunks.push(chunk)
    }
  } catch (error) {
    try { await reader.cancel() } catch {}
    throw error
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const chunk of chunks) { out.set(chunk, at); at += chunk.byteLength }
  return out
}

export const readTextLimited = async (response, max = MAX_SUBTITLE_BYTES) =>
  new TextDecoder('utf-8').decode(await readLimited(response, max))
