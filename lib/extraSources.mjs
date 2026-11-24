// مصادر ترجمة إضافية (فكرة 25): SubDL و Jimaku — جنب المصدر الحالي (OpenSubtitles عبر Stremio).
//
// لماذا؟ المصدر الحالي ممتاز مع tt<imdb> لكن: (1) كتالوجات الأنمي تسلّم kitsu:<id> أو معرّف مال/أنيلست بدل IMDb،
// فيحصل صفر نتائج؛ (2) المصدر الواحد يغطي المسلسلات الغربية والأفلام غالبًا، وندرة في الفانساب.
// SubDL: قاعدة عامة ضخمة (مجاني: 2000 بحث و50 تنزيل في اليوم). Jimaku: أفضل متخصص بالترجمة اليابانية للأنمي،
// ويفهم معرّف AniList مباشرة. كل واحد بمفتاح المستخدم نفسه — بدون مفتاح يُتخطى صامتًا ولا يظهر أثره.
//
// الشكل المعاد { url, lang, movieReleaseName, subtitleFileName } متوافق مع rank() و حارس الحلقة الغلط في app.mjs.
// ملفات Jimaku تُنزَّل بترويسة التصريح (المفاتيح لا تُلصق في الروابط)، وروابط SubDL تحمل المفتاح نفسه لأنها
// داخل رابط الإضافة أصلًا — أي أن المفتاح لا يغادر عند من يملك الرابط، كما كل إعدادات المستخدم.

import { unzipSync } from 'fflate'
import { parseAnimeId, animeMeta } from './anime.mjs'
import { searchAnime } from './anilist.mjs'
import { parseVideoId } from './episode.mjs'
import { isPrivateHost, safeFetch, readLimited, readTextLimited, MAX_SUBTITLE_BYTES, MAX_ZIP_BYTES, MAX_UNZIPPED_BYTES } from './config.mjs'

const AGENT = { 'user-agent': 'tarjuman-addon/0.8' }
export const SUBDL_HOST = 'api.subdl.com'
export const SUBDL_DL = 'dl.subdl.com'
export const JIMAKU_HOST = 'jimaku.cc'

// تحويل اسم/رمز اللغة من حروف مختلفة إلى رموز ISO 639-2 التي يستعملها الجدول
const LANG2 = {
  en: 'eng', fr: 'fre', es: 'spa', de: 'ger', it: 'ita', pt: 'por', 'pt-br': 'pob', ptbr: 'pob',
  ru: 'rus', tr: 'tur', nl: 'dut', pl: 'pol', ja: 'jpn', ko: 'kor', zh: 'chi', hi: 'hin',
  sv: 'swe', da: 'dan', no: 'nor', nb: 'nor', fi: 'fin', el: 'gre', he: 'heb', fa: 'per', id: 'ind',
  ar: 'ara', cs: 'cze', uk: 'ukr', vi: 'vie', th: 'tha', hu: 'hun', ro: 'rum', bg: 'bul', sr: 'srp',
  fra: 'fre', deu: 'ger', fra_t: 'fre', fas: 'per', ces: 'cze', ron: 'rum', ell: 'gre',
}
const LANG3 = new Set(['eng', 'fre', 'spa', 'ger', 'ita', 'por', 'pob', 'rus', 'tur', 'dut', 'pol', 'jpn', 'kor', 'chi', 'hin', 'swe', 'dan', 'nor', 'fin', 'gre', 'heb', 'per', 'ind', 'ara', 'cze', 'ukr', 'vie', 'tha', 'hun', 'rum', 'bul', 'srp'])
const LANGNAME = {
  english: 'eng', french: 'fre', spanish: 'spa', german: 'ger', italian: 'ita', portuguese: 'por',
  russian: 'rus', turkish: 'tur', dutch: 'dut', polish: 'pol', japanese: 'jpn', korean: 'kor', chinese: 'chi',
  hindi: 'hin', swedish: 'swe', danish: 'dan', norwegian: 'nor', finnish: 'fin', greek: 'gre', hebrew: 'heb',
  persian: 'per', farsi: 'per', indonesian: 'ind', arabic: 'ara', vietnamese: 'vie', czech: 'cze', ukrainian: 'ukr',
}
export const toLang3 = value => {
  const raw = String(value || '').trim().toLowerCase()
  if (!raw) return null
  if (LANG3.has(raw)) return raw
  const name = LANGNAME[raw.replace(/[\s_-]+$/, '').replace(/[\s_]/g, ' ')] || LANGNAME[raw]
  if (name) return name
  const short = raw.replace(/_/g, '-')
  return LANG2[short] || LANG2[short.split('-')[0]] || (/^[a-z]{3}$/.test(short) ? short : null)
}

const TIMEOUT = 10_000
const cache = new Map()   // مفتاح الاستعلام → النتيجة، حتى لا يتكرر النداء مع كل فتح للقائمة
const CACHE_TTL = 10 * 60_000
const cached = async (key, make) => {
  const kept = cache.get(key)
  if (kept && Date.now() - kept.at < CACHE_TTL) return kept.value
  const value = await make()
  if (cache.size > 200) cache.delete(cache.keys().next().value)
  cache.set(key, { at: Date.now(), value })
  return value
}

// cinemeta يعطي اسم العمل وسنته وأنواعه — لأعمال IMDb اللي ما نعرف أنو أنمي إلا منها (نوعها Animation)
const metaForImdb = async (type, imdb, urls = {}) => cached(`meta:${type}:${imdb}`, async () => {
  const metaBase = (urls.meta || 'https://v3-cinemeta.strem.io').replace(/\/+$/, '')
  const body = await getJson(`${metaBase}/meta/${type}/${imdb}.json`, {})
  const meta = body?.meta || {}
  const name = String(meta.name || '').trim()
  if (!name) return null
  const year = Number(String(meta.releaseInfo || meta.year || '').match(/\d{4}/)?.[0]) || 0
  const genres = (meta.genres || meta.genre || []).map(g => String(g).toLowerCase())
  return { name, year, genres }
})

// أنيلست يبحث باسم العمل — لازم لأنمd IMDb (Jimaku يفهم أرقام anilist فقط)
const anilistByName = async (name, year, urls = {}) => cached(`anilist-search:${name}:${year}`, async () => {
  const media = await searchAnime({ name, year }, urls.anilist || '').catch(() => null)
  return media?.id || null
})

const getJson = async (url, headers) => {
  const response = await fetch(url, { headers: { ...AGENT, ...headers }, signal: AbortSignal.timeout(TIMEOUT) })
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`)
  return JSON.parse(await readTextLimited(response))
}

// ── SubDL ──
const subdlSearch = async ({ id, type, title, year, episode }, apiKey, urls = {}) => cached(`subdl:${id}:${type}:${episode ?? ''}:${title ? `n:${title}` : 'imdb'}:${apiKey.slice(-8)}`, async () => {
  const apiBase = (urls.subdl || `https://${SUBDL_HOST}`).replace(/\/+$/, '')
  const dlBase = (urls.subdlDl || urls.subdl || `https://${SUBDL_DL}`).replace(/\/+$/, '')
  const params = new URLSearchParams({ api_key: apiKey, type: type === 'series' ? 'tv' : 'movie' })
  const plainImdb = /^tt\d{5,10}(?::\d{1,4}:\d{1,4})?$/.test(id) ? String(id).split(':')[0] : null
  if (title) { params.set('film_name', title); if (year) params.set('year', String(year)) }   // التدوير الثاني: بالاسم والسنة
  else if (plainImdb) params.set('imdb_id', plainImdb)
  else return []
  if (episode) params.set('episode_number', String(episode))
  const body = await getJson(`${apiBase}/api/v1/subtitles?${params}`, {})
  const rows = Array.isArray(body?.subtitles) ? body.subtitles : Array.isArray(body?.results) ? body.results : []
  const out = []
  for (const row of rows) {
    const lang = toLang3(row?.lang || row?.language || row?.lang_code)
    let url = String(row?.url || row?.download_url || row?.link || '')
    if (!lang || !url) continue
    if (url.startsWith('/')) url = `${dlBase}${url}`
    else if (!/^https:/i.test(url)) continue
    // رابط التنزيل: SubDL يخدم ملف مضغوط (zip) يحمل api_key بداخله وقت الفتح
    const dl = new URL(url)
    if (!dl.searchParams.has('api_key')) dl.searchParams.set('api_key', apiKey)
    const release = String(row?.release_name || row?.name || row?.file || '').slice(0, 200)
    out.push({ url: dl.toString(), lang, movieReleaseName: release, subtitleFileName: String(row?.file || row?.name || '') })
  }
  return out
})

// ── Jimaku ── (دليل الترجمات اليابانية للأنمي؛ مفتاح مجاني من jimaku.cc/account)
const jimakuSearch = async ({ id, episode, anilistId: knownAnilistId }, apiKey, urls = {}) => cached(`jimaku:${id ?? knownAnilistId}:${episode ?? ''}`, async () => {
  const parsed = id ? parseAnimeId(id) : null
  const anilistId = knownAnilistId ?? (parsed?.family === 'anilist' ? parsed.id : null)
  let target = null
  if (anilistId) target = anilistId
  else if (parsed?.family === 'mal') {
    // مال غائب من أوامر Jimaku؛ نمر على أنيلست بوسيط MAL→AniList (مجاني)
    const meta = await animeMeta(`mal:${parsed.id}`, urls)
    target = meta?.anilistId || null
  } else if (parsed?.family === 'kitsu') {
    const meta = await animeMeta(`kitsu:${parsed.id}`, urls)
    target = meta?.anilistId || null
  }
  if (!target) return []
  const headers = { authorization: apiKey }
  const jimakuBase = (urls.jimaku || `https://${JIMAKU_HOST}`).replace(/\/+$/, '')
  const found = await getJson(`${jimakuBase}/api/entries/search?anime=true&anilist_id=${target}`, headers)
  const entries = Array.isArray(found) ? found : found?.entries || found?.results || []
  const entry = entries.find(e => Number(e?.anilist_id) === target) || entries[0]
  if (!entry?.id) return []
  const filesUrl = `${jimakuBase}/api/entries/${entry.id}/files${episode ? `?episode=${encodeURIComponent(episode)}` : ''}`
  const files = await getJson(filesUrl, headers)
  const list = Array.isArray(files) ? files : files?.files || files?.results || []
  const out = []
  for (const file of list) {
    let url = String(file?.url || '')
    if (!url) continue
    if (url.startsWith('/')) url = `${jimakuBase}${url}`
    else if (!/^https:/i.test(url)) continue
    const name = String(file?.name || '').slice(0, 200)
    if (!/\.(srt|vtt|ass|ssa|sub)$/i.test(name) && !/\.(srt|vtt|ass|ssa|sub)(\?|$)/i.test(url)) continue
    out.push({ url, lang: 'eng', movieReleaseName: name, subtitleFileName: name })   // فانساب: غالبًا إنجليزية
  }
  return out
})

// ── Popcorn Notes / Subtitles: Extended ── (16 مصدر، أفضل توافق أولًا — مفتاح غير مطلوب)
// الرابط الافتراضي: https://popcorn-notes.lsoares.workers.dev
const popcornNotesSearch = async ({ id, type, title, year, episode }, baseUrl, urls = {}) => cached(`pn:${id}:${type}:${episode ?? ''}:${title ? `n:${title}` : 'imdb'}`, async () => {
  const apiBase = (baseUrl || urls.popcorn || `https://popcorn-notes.lsoares.workers.dev`).replace(/\/+$/, '')
  const plainImdb = /^tt\d{5,10}(?::\d{1,4}:\d{1,4})?$/.test(id) ? String(id).split(':')[0] : null
  if (!plainImdb) return []
  const params = new URLSearchParams({ type: type === 'series' ? 'tv' : 'movie' })
  if (title) { params.set('film_name', title); if (year) params.set('year', String(year)) }
  else params.set('imdb_id', plainImdb)
  if (episode) params.set('episode_number', String(episode))
  const body = await getJson(`${apiBase}/subtitles/${type}/${plainImdb}.json?${params}`, {})
  const rows = Array.isArray(body?.subtitles) ? body.subtitles : []
  const out = []
  for (const row of rows) {
    const lang = toLang3(row?.lang || row?.language || row?.lang_code)
    let url = String(row?.url || '')
    if (!lang || !url) continue
    if (!/^https:/i.test(url)) continue
    const release = String(row?.release_name || row?.name || row?.file || '').slice(0, 200)
    out.push({ url, lang, movieReleaseName: release, subtitleFileName: String(row?.file || row?.name || '') })
  }
  return out
})

// القائمة من المصادر الإضافية؛ ترجع [] عند غياب المفتاح أو أي فشل — فشل مصدر إضافي يجب ألا يُسقط الرئيسي
// urls: { kitsu, anilist, subdl, subdlDl, jimaku, meta, popcorn } لبيئات الاختبار والنشر الذاتي
// empty: المصدر الرئيسي رجع فاضي (ما فيه أي ترجمة مطابقة) — إشارة لتجربة الاسم والسنة والأنمي/أنيلست، فقط وقتها
export const extraSubtitles = async ({ type, id, title, year, episode, empty = false }, cfg, urls = {}) => {
  const sd = String(cfg?.sd || '').trim()
  const jm = String(cfg?.jm || '').trim()
  const pn = String(cfg?.ex || '').trim()   // رابط source إضافي (اكستندد/بوب كورن نوتس) — اختياري، افتراضيًا المضيف الرسمي
  if (!sd && !jm && !pn) return []
  const anime = parseAnimeId(id)
  const imdb = parseVideoId(id)   // { season, episode } لأعمال IMDb أو null
  let resolved = { title, year, episode: episode ?? imdb?.episode ?? null }
  if (anime) {
    const meta = await animeMeta(id, urls).catch(() => null)
    resolved = {
      title: resolved.title ?? meta?.title ?? '',
      year: resolved.year ?? meta?.year ?? 0,
      episode: resolved.episode ?? meta?.episode ?? null,
    }
  }
  const jobs = []
  if (sd) {
    jobs.push((async () => {
      const first = await subdlSearch({ id, type, ...resolved }, sd, urls)
      if (first.length) return first
      // SubDL ما يعرف imdb لكل أنمي — جرّب بالاسم والسنة من cinemeta (فقط هذي الحالة)
      if (!empty) return first
      const imdbOnly = /^tt\d{5,10}/.exec(id)?.[0]
      const meta = imdbOnly ? await metaForImdb(type, imdbOnly, urls).catch(() => null) : null
      if (!meta?.name) return first
      return subdlSearch({ id, type, title: meta.name, year: meta.year, episode: resolved.episode }, sd, urls)
    })())
  }
  if (jm) {
    jobs.push((async () => {
      if (anime) return jimakuSearch({ id, episode: resolved.episode }, jm, urls)
      // أنمي بمعرّف IMDb (مثل Anik/AniList Pro في Nuvio): Jimaku يفهم anilist فقط — نبحث بالاسم عبر cinemeta→أنيلست
      if (!imdb || type !== 'series' || resolved.episode == null || !empty) return []
      const imdbOnly = /^tt\d{5,10}/.exec(id)?.[0]
      const meta = imdbOnly ? await metaForImdb(type, imdbOnly, urls).catch(() => null) : null
      if (!meta?.name || !meta.genres.includes('animation')) return []   // أنمي فقط (نوع Animation)
      const anilistId = await anilistByName(meta.name, meta.year, urls)
      if (!anilistId) return []
      return jimakuSearch({ episode: resolved.episode, anilistId }, jm, urls)
    })())
  }
  // اكستندد/بوب كورن نوتس — دائمًا يُضاف، إن لم يدخل المستخدم رابطًا يُستخدم الرابط الرسمي
  let popcornBase = pn || `https://popcorn-notes.lsoares.workers.dev`
  if (!isPopcornUrlAllowed(popcornBase)) popcornBase = `https://popcorn-notes.lsoares.workers.dev`
  jobs.push((async () => {
    return popcornNotesSearch({ id, type, title: resolved.title, year: resolved.year, episode: resolved.episode }, popcornBase, urls)
  })())
  if (!jobs.length) return []
  const settled = await Promise.allSettled(jobs)
  return settled.flatMap(result => (result.status === 'fulfilled' ? result.value : []))
}

const POP_IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/
export const isPopcornUrlAllowed = base => {
  let url
  try { url = new URL(base) } catch { return false }
  if (url.protocol !== 'https:') return false
  const host = url.hostname.replace(/^\[|\]$/g, '')
  return !isPrivateHost(host)
}

const SUB_EXT = /\.(srt|vtt|ass|ssa|sub)$/i
const PICK = ['.srt', '.ass', '.ssa', '.vtt', '.sub']

// فتح حزمة SubDL: نختار ملف الترجمة الأنسب (الأولوية: srt ثم ass ثم vtt…) — الحزمة قد تحمل ملفًا لكل لغة
export const unzipSubtitle = (buffer, preferLang3 = '') => {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer)
  // fflate يستدعي filter قبل فك أي ملف، فنرفض الملفات التي تُعلن حجماً خادعاً ولا نضخّها في الذاكرة
  const entries = unzipSync(bytes, {
    filter: info => info.originalSize <= MAX_UNZIPPED_BYTES && info.size <= MAX_ZIP_BYTES
  })
  const inflated = Object.values(entries).reduce((sum, data) => sum + data.byteLength, 0)
  if (inflated > MAX_UNZIPPED_BYTES) throw new Error('حزمة الترجمة أكبر من الحد المسموح')
  const best = Object.entries(entries)
    .filter(([name]) => SUB_EXT.test(name))
    .sort(([a], [b]) => {
      const extA = PICK.findIndex(ext => a.toLowerCase().endsWith(ext)), extB = PICK.findIndex(ext => b.toLowerCase().endsWith(ext))
      const rankA = extA < 0 ? 99 : extA, rankB = extB < 0 ? 99 : extB
      const langA = preferLang3 && new RegExp(`(^|[^a-z])${preferLang3.slice(0, 2)}([^a-z]|$)`, 'i').test(a) ? 0 : 1
      const langB = preferLang3 && new RegExp(`(^|[^a-z])${preferLang3.slice(0, 2)}([^a-z]|$)`, 'i').test(b) ? 0 : 1
      return langA - langB || rankA - rankB || a.localeCompare(b)
    })[0]
  if (!best) throw new Error('الحزمة ما تحتوي ملف ترجمة مدعوم')
  return new TextDecoder('utf-8').decode(best[1])
}

// تنزيل محتوى الترجمة لرابط إضافي؛ يعطي نصًا جاهزًا لـ parseSubtitle
// urls: { subdl, subdlDl, jimaku } — عميل الاختبار/النشر الذاتي؛ وبدونها تُطابق المضيفون الرسميون بالاسم
export const fetchExtraSubtitle = async (url, cfg, settings, urls = {}) => {
  if (!settings.allow.test(url)) throw new Error('subtitle address not allowed')
  const host = new URL(url).hostname
  const subdlBase = urls.subdlDl || urls.subdl
  const jimakuBase = urls.jimaku
  if ((subdlBase && url.startsWith(subdlBase.replace(/\/+$/, ''))) || host === SUBDL_DL || /(^|\.)subdl\.com$/.test(host)) {
    const response = await safeFetch(url, { headers: AGENT, signal: AbortSignal.timeout(25_000) })
    if (!response.ok) throw new Error(`${response.status} from ${host}`)
    const buffer = await readLimited(response, MAX_ZIP_BYTES)
    const text = unzipSubtitle(buffer)
    if (text.length > 3_000_000) throw new Error('subtitle file too large')
    return text
  }
  if ((jimakuBase && url.startsWith(jimakuBase.replace(/\/+$/, ''))) || host === JIMAKU_HOST || host.endsWith(`.${JIMAKU_HOST}`)) {
    const headers = String(cfg?.jm || '').trim() ? { authorization: String(cfg.jm).trim() } : {}
    const response = await safeFetch(url, { headers: { ...AGENT, ...headers }, signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(`${response.status} from ${host}`)
    const text = await readTextLimited(response)
    if (text.length > 3_000_000) throw new Error('subtitle file too large')
    return text
  }
  // عنوان آخر: نعامله كأي ملف نصي (نفس سلوك المصدر الرئيسي)
  const response = await safeFetch(url, { headers: AGENT, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`${response.status} from ${host}`)
  const text = await readTextLimited(response)
  if (text.length > 3_000_000) throw new Error('subtitle file too large')
  return text
}
