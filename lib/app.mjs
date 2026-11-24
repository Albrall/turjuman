// Tarjuman: a Stremio subtitles addon that translates a title's subtitle into Arabic with the user's own AI key.
//
//   the player lists subtitles  →  GET /<settings>/subtitles/<type>/<id>/<extra>.json   the matching subtitles, offered as Arabic
//   the viewer picks one        →  GET /<settings>/t/<link>.vtt                         that subtitle, translated
//
// This file is the whole addon as a function from a web Request to a web Response. It runs unchanged on Node (server.mjs)
// and on Cloudflare (worker.mjs); what differs between the two is handed in as `platform`:
//
//   env(name)      a setting of the deployment, or undefined
//   page, logo()   the settings page (text) and the logo (bytes, or null when there is none)
//   store          where finished and half-finished translations are kept: getFinal, putFinal, getProgress, putProgress, probe
//                  and, where it can do them cheaply or across processes: hasFinal (is there a finished one, without
//                  reading it), getArmed / putArmed (when a subtitle was first picked: see "picked twice" below)
//   lookup(host)   the addresses of a host name, where names can be resolved (Node)
//   limits         budget — requests to the model one request may send · lingerMs — how long a request may keep working
//                  after it answered · progressEveryMs — how often a translation in progress is saved (0: never)
//                  maxBoards — translations kept in memory · maxConcurrency — requests to the model at once

import { PROMPT_VERSION, alive, cacheKey, createBoard, resumeBoard, startHelper } from './board.mjs'
import { mergeReport, monthKey, reportHtml } from './report.mjs'
import { learnSeriesNames, seriesNames } from './series.mjs'
import { ConfigError, assertProviderAllowed, decodeConfig, decodeText, encodeText, normalize } from './config.mjs'
import { parseVideoId, byName, embeddedVerdict, openingCues, markersIn } from './episode.mjs'
import { sleep } from './llm.mjs'
import { safeFetch } from './config.mjs'
import { describeTitle, episodeTitle, languageName, listSubtitles, pickLanguage, probeSource, rank, sourceSettings } from './sources.mjs'
import { extraSubtitles, fetchExtraSubtitle } from './extraSources.mjs'
import { ID_OR_ANIME, isAnimeId } from './anime.mjs'
import { buildVtt, parseSubtitle, tidy } from './subs.mjs'

export const VERSION = '0.9.8.3'

// ───────────────────────── answers ─────────────────────────

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, HEAD, POST, OPTIONS' }
const VTT = 'text/vtt; charset=utf-8'
const HEADER = 'WEBVTT\n\n'
// Arabic letters live in the U+0600–U+06FF block
const HAS_ARABIC = /[\u0600-\u06FF]/
const isArabicText = text => HAS_ARABIC.test(text)
// A file holding several episodes: 150+ cues spanning more than 50 minutes
const isMultiEpisode = cues => {
  if (!cues || cues.length < 150) return false
  const last = cues[cues.length - 1]
  const spanMinutes = (last.end - cues[0].start) / 60
  return spanMinutes > 50
}

const respond = (status, headers, body = null) => new Response(body, { status, headers: { ...CORS, ...headers } })
const json = (status, data, headers = {}) => respond(status, { 'content-type': 'application/json; charset=utf-8', ...headers }, JSON.stringify(data))
const text = (status, message) => respond(status, { 'content-type': 'text/plain; charset=utf-8' }, message)
// A finished translation never changes; an unfinished one must be fetched again when the viewer picks the subtitle again
const vtt = (body, complete) => respond(200, { 'content-type': VTT, 'cache-control': complete ? 'public, max-age=86400' : 'no-store' }, body)

const escapeHtml = value => value.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`)

// The address the viewer's player reaches this server at, to build the links it is given
const originOf = (request, env) => {
  const fixed = env('PUBLIC_URL')
  if (fixed) return fixed.replace(/\/+$/, '')
  const first = value => String(value || '').split(',')[0].trim()
  const url = new URL(request.url)
  const trusted = env('TRUST_PROXY') === '1'
  const named = trusted ? first(request.headers.get('x-forwarded-host')) || url.host : url.host
  const host = /^[\w.:[\]-]+$/.test(named) ? named : url.hostname   // مضيف ملوث ⇒ نرجع لاسم المضيف بلا منفذ ولا ترويسة
  const localHost = /^(localhost|127\.|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)
  const rawScheme = trusted ? first(request.headers.get('x-forwarded-proto')) || (localHost ? 'http' : 'https') : url.protocol
  const scheme = rawScheme.replace(/:+$/, '')
  return `${scheme === 'http' || scheme === 'https' ? scheme : url.protocol.replace(/:+$/, '')}://${host}`
}

// configured: the address holds the viewer's settings. Players that take an addon from its bare address (Nuvio adds
// /manifest.json to whatever is pasted) install it all the same, so the name says what is missing.
const manifest = (origin, configured, hasLogo) => ({
  id: 'community.tarjuman.arabic-ai',
  version: VERSION,
  name: configured ? 'Tarjuman AI | ترجمان' : 'Tarjuman AI | ترجمان (بلا إعدادات)',
  description: configured
    ? 'ترجمة عربية بالذكاء الاصطناعي: تجلب الترجمة المطابقة لملفك وتترجمها إلى العربية بمفتاحك الخاص.'
    : 'هذه النسخة مثبّتة بلا إعدادات فلا تترجم. افتح صفحة الإعدادات، املأها، انسخ الرابط، وثبّته بدل هذه النسخة.',
  ...(hasLogo ? { logo: `${origin}/logo.png` } : {}),
  resources: ['subtitles'],
  types: ['movie', 'series'],
  idPrefixes: ['tt', 'kitsu', 'mal', 'anilist'],
  catalogs: [],
  behaviorHints: { configurable: true, configurationRequired: !configured },
})

// A message shown at the top of the screen. The viewer may be anywhere in the video, so it comes back every so often.
const messageTrack = message => buildVtt(Array.from({ length: 120 }, (_, i) => ({ start: 0.5 + i * 90, end: 8.5 + i * 90, text: message, rtl: true, top: true })))

// An addon that cannot work as it was installed used to answer with nothing, and nothing is what the viewer saw: no
// subtitle of ours in the list, and no reason. The list of subtitles is the one place the viewer looks, so the reason
// goes there, as an entry that says it in its name and again on screen when picked.
//  - setup: installed from the bare address, without the settings
//  - link: the settings in the address cannot be read (an address cut short when it was pasted)
const NOTICES = {
  setup: ['⚠️ ترجمان: ناقصها الإعدادات', '⚠️ ترجمان مثبّتة بلا إعدادات، فلا تترجم\nافتح صفحة الإضافة، املأ الإعدادات، انسخ الرابط، وثبّته بدل هذه النسخة'],
  link: ['⚠️ ترجمان: رابط الإضافة غير مقروء', '⚠️ رابط إضافة ترجمان غير مقروء\nافتح صفحة الإعدادات، انسخ الرابط من جديد، وثبّته بدل هذه النسخة'],
  // Every listed subtitle says it is for another episode (the wrong-episode guard, idea 22)
  wrong: ['⚠️ ترجمان: الترجمات المتاحة لحلقة ثانية', '⚠️ ما تُترجم هالمرة: كل ترجمات هذي الحلقة المتاحة الآن تطابق حلقات ثانية.\nترجمان يدوّر تلقائيًا في الحلقات المجاورة عن الملف الصح؛ وإن ما لقاه فلن تُترجم حتى تتوفر ترجمات أخرى.'],
  // ما لقي ترجمة عربية صالحة من أي مصدر (بعد التحقق من محتواها فعلاً)
  'no-arabic': ['⚠️ ترجمان: ما لقي ترجمة عربية', '⚠️ ترجمان ما لقي ترجمة عربية صالحة لهذا الفيلم أو الحلقة من أي مصدر.\nلترجم من لغة ثانية، فعّل خيار الترجمة من الإعدادات، أو جرّب مصدر ترجمات آخر.'],
}
// Shown instead of a translation the first time a subtitle is picked (see "picked twice" below). The viewer may be
// anywhere in the video and should see it within seconds, so it comes back every twenty seconds: often enough to be
// seen at once, and off the screen most of the time for a viewer who was given this subtitle without asking for it.
const ASK_AGAIN = '⏳ ترجمان: اختر هذه الترجمة مرة ثانية لتبدأ الترجمة، ثم انتظر نحو دقيقة'
let askAgainTrack = null
const askAgain = () => (askAgainTrack ??= buildVtt(Array.from({ length: 540 }, (_, i) => ({ start: 0.5 + i * 20, end: 6.5 + i * 20, text: ASK_AGAIN, rtl: true, top: true }))))

const noticeList = (origin, kind) => json(200, { subtitles: [{ id: NOTICES[kind][0], lang: 'ara', label: NOTICES[kind][0], url: `${origin}/notice/${kind}.vtt` }] }, { 'cache-control': 'no-cache' })

// A line that came out without a word of Arabic — a sound, a brand, a line the provider would not translate — is shown
// the way it was written: left to right
const ARABIC = /[\u0600-\u06FF]/

// What there is so far: translated lines in Arabic, the rest as they were, with a note saying so
const render = board => {
  if (board.state === 'done') {
    board.vtt ??= buildVtt([
      ...board.cues.map((cue, i) => ({ start: cue.start, end: cue.end, text: board.out[i], rtl: ARABIC.test(board.out[i]) })),
      ...(board.notes ?? []).map(note => ({ start: note.start, end: note.end, text: note.text, rtl: true, top: true })),
    ])
    return { body: board.vtt, complete: true }
  }
  const cues = board.cues.map((cue, i) => (board.out[i] === undefined ? cue : { start: cue.start, end: cue.end, text: board.out[i], rtl: ARABIC.test(board.out[i]) }))
  const percent = Math.floor((board.translated / board.cues.length) * 100)
  const message = board.state === 'failed'
    ? `⚠️ توقفت الترجمة عند ${percent}%: ${board.error}\nأعد اختيار الترجمة من القائمة للمحاولة من جديد`
    : `⏳ الترجمة العربية قيد التجهيز (${percent}%)\nأعد اختيار الترجمة من القائمة بعد قليل لتحميلها كاملة`
  const firstGap = board.cues.find((_, i) => board.out[i] === undefined)?.start ?? 0
  const starts = [0.5]
  for (let at = Math.max(firstGap - 1, 100); at < board.cues.at(-1).end; at += 120) starts.push(at)
  for (const start of starts) cues.push({ start, end: start + 8, text: message, rtl: true, top: true })
  return { body: buildVtt(cues), complete: false }
}

// The lines the settings page's test button sends. Hope, Hunter and Stone are names here: a model that follows the
// conversation writes them by sound (هوب، هنتر، ستون) and one that does not turns them into "أمل", "صياد" and "حجر".
const SAMPLE = ["Good evening, Hope. Sorry I'm late, the traffic was terrible.", '- Did you bring the keys?\n- I thought Hunter had them.', "Well, that's just great. Now what do we do, Mr. Stone?"]

const ID = ID_OR_ANIME

// المصدر الرئيسي (OpenSubtitles عبر Stremio) + الإضافي (SubDL وjimaku) مدموجين في قائمة واحدة.
// فشل الإضافي لا يُسقط الرئيسي أبدًا: يرجع قائمة الرئيسي فقط. base=null يعني الرئيسي فشل نفسه.
const mergedSubtitles = async ({ type, rawId, rawExtra }, cfg, sources, log) => {
  let base = null
  try {
    base = await listSubtitles({ type, rawId, rawExtra }, sources)
  } catch (error) {
    log?.(`subtitles source failed: ${error.message}`)
  }
  let id = rawId
  try { id = decodeURIComponent(rawId) } catch {}
  const empty = !base || base.length === 0   // المصدر الرئيسي رجع فاضي — نعطي الإضافي فرصة بمعلومات أكثر
  const extra = await extraSubtitles({ type, id, empty }, cfg, { kitsu: sources.kitsu || undefined, anilist: sources.anilist || undefined, subdl: sources.subdl || undefined, subdlDl: sources.subdlDl || undefined, jimaku: sources.jimaku || undefined, popcorn: sources.popcorn || undefined, meta: sources.meta || undefined }).catch(() => [])
  return { base, merged: [...(base || []), ...extra] }
}

// تنزيل أي ترجمة مدرجة: رابط stremio عادي أو SubDL (zip) أو Jimaku (مع التصريح) — بنفس القاعدة
const fetchAnySubtitle = (url, cfg, sources) => fetchExtraSubtitle(url, cfg, sources, sources)

export const createApp = platform => {
  const { env, limits, store } = platform
  const boards = new Map()   // key → a translation: being opened, running, stopped half-way, or finished
  const number = (name, fallback) => {
    const value = Number(env(name))
    return env(name) !== undefined && Number.isFinite(value) ? value : fallback
  }
  const allowLocal = () => env('ALLOW_LOCAL_AI') === '1'
  const fast = () => env('FAST_RETRIES') === '1'
  const llmOf = cfg => ({ baseUrl: cfg.b, apiKey: cfg.k, model: cfg.m, effort: cfg.r, concurrency: Math.min(cfg.cc, limits.maxConcurrency) })
  // فكرة 34: مزوّد احتياطي اختياري، يُستخدم مرة واحدة في الحلقة فقط، لا تتغير الترجمة بسببه
  const backupFor = cfg => (cfg.fb && cfg.fk && cfg.fm)
    ? { baseUrl: cfg.fb, apiKey: cfg.fk, model: cfg.fm, effort: cfg.r, concurrency: 1 }
    : null
  // get-then-put is not atomic: serialize the increments so two requests at once cannot
  // read the same old ledger and one of them lose its numbers.
  let reportQueue = Promise.resolve()
  const reportAdd = delta => {
    if (!store.getReport || !store.putReport) return Promise.resolve()
    reportQueue = reportQueue.then(async () => {
      const key = monthKey()
      try { await store.putReport(key, mergeReport(await store.getReport(key), delta)) } catch {}
    })
    return reportQueue
  }
  const countHit = () => reportAdd({ hits: 1 }).catch(() => {})

  const html = () => respond(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' },
    platform.page.replace('<!--NOTICE-->', env('NOTICE') ? `<p class="notice warn" role="alert">${escapeHtml(env('NOTICE'))}</p>` : ''))

  // ───────────────────────── translations ─────────────────────────

  const remember = (key, board) => {
    boards.delete(key)
    boards.set(key, board)
    for (const [old, kept] of boards) {
      if (boards.size <= limits.maxBoards) break
      if (kept.state !== 'running' && kept.state !== 'opening') boards.delete(old)
    }
    return board
  }

  const snapshot = board => ({
    from: board.from, about: board.about, brief: board.brief, cues: board.cues.map(cue => [cue.start, cue.end, cue.text]),
    out: Array.from(board.out, line => line ?? null), asWritten: [...board.asWritten],
    notes: board.notes ?? [], tokens: board.tokens ?? { p: 0, c: 0 },
  })

  // Saved now and then while a translation runs, so that a request cut off half-way costs seconds of work and not all of it
  const onProgress = async (board, leaving) => {
    const news = board.translated !== board.savedCount || (board.brief !== undefined) !== board.savedBrief   // a line more, or the brief
    if (!limits.progressEveryMs || !news) return
    if (!leaving && Date.now() - board.savedAt < limits.progressEveryMs) return
    Object.assign(board, { savedAt: Date.now(), savedCount: board.translated, savedBrief: board.brief !== undefined })
    await store.putProgress(board.key, snapshot(board))
  }
  const onDone = board => store.putFinal(board.key, render(board).body).then(() => {
    const tokens = board.tokens ?? { p: 0, c: 0 }
    return reportAdd({ episodes: 1, [board.kind === 'movie' ? 'film' : 'tv']: 1, lines: board.cues.length, requests: board.requests, tokensP: tokens.p, tokensC: tokens.c, withUsage: tokens.p ? 1 : 0 })
  })

  // The show's name dictionary (ideas 14 + 17): names taken from the show's catalogue entry once, then kept where the translations are kept
  const dictionaryOf = async (ref, cfg, sources) => {
    if (!cfg.nm || ref?.t !== 'series') return null
    const expected = parseVideoId(ref.i)
    if (!expected) return null
    const anilistUrl = env('ANILIST_URL') || ''
    const list = await seriesNames(ref, sources, store, anilistUrl)
    if (!list) return null
    return { list, learn: learned => learnSeriesNames(expected.imdb, learned, store) }
  }

  const open = async (key, cfg, ref, sources) => {
    const final = await store.getFinal(key)
    if (final) return { key, state: 'done', vtt: final }
    await assertProviderAllowed(cfg.b, { allowLocal: allowLocal(), lookup: platform.lookup })
    if (cfg.fb) await assertProviderAllowed(cfg.fb, { allowLocal: allowLocal(), lookup: platform.lookup })
    const saved = await store.getProgress(key)
    if (saved?.cues?.length) {
      const dict = saved.brief === undefined ? await dictionaryOf(ref, cfg, sources).catch(() => null) : null
      const board = createBoard({
        key, from: saved.from, about: saved.about, batchSize: cfg.bs, wantBrief: cfg.nm, brief: saved.brief ?? undefined,
        cues: saved.cues.map(([start, end, line]) => ({ start, end, text: line })),
        out: Array.from(saved.out, line => line ?? undefined),
        asWritten: Array.isArray(saved.asWritten) ? saved.asWritten : [],
        seriesNames: dict?.list, learnNames: dict?.learn, wantNotes: cfg.nt !== false,
      })
      if (saved.tokens && typeof saved.tokens.p === 'number') board.tokens = saved.tokens
      if (Array.isArray(saved.notes)) board.notes = saved.notes.filter(note => note && typeof note.start === 'number' && typeof note.text === 'string')
      return Object.assign(board, { savedAt: Date.now(), savedCount: board.translated, savedBrief: board.brief !== undefined, kind: ref?.t })
    }
    // حارس الحلقة الغلط (22) + يدوّر الترجمة الصح (23): ما يفتح الملف غلط قبل ما يحكم عليه
    const guarded = await resolveSubtitle(cfg, ref, sources)
    if (guarded.wrong) return { key, state: 'wrong', wanted: guarded.wrong.wanted, found: guarded.wrong.found, at: Date.now() }
    ref = guarded.ref
    const [raw, about] = await Promise.all([guarded.raw ? Promise.resolve(guarded.raw) : fetchAnySubtitle(ref.u, cfg, sources), describeTitle({ type: ref.t, id: ref.i }, sources)])
    const cues = tidy(parseSubtitle(raw), { dropSounds: cfg.sdh })
    if (!cues.length) throw new Error('الترجمة الأصلية فارغة أو بصيغة غير مدعومة')
    if (cues.length > 8000) throw new Error('الترجمة الأصلية أطول من المسموح')
    // ملف يحتوي على عدة حلقات (مثل 1–13) — التوقيت خاطئ للحلقة الثانية وما بعدها
    if (isMultiEpisode(cues)) throw new Error('multi-episode')
    const dict = await dictionaryOf(ref, cfg, sources).catch(() => null)
    const board = Object.assign(createBoard({ key, cues, from: languageName(ref.l), about, batchSize: cfg.bs, wantBrief: cfg.nm, seriesNames: dict?.list, learnNames: dict?.learn, wantNotes: cfg.nt !== false }), { savedAt: 0, savedCount: -1, savedBrief: false, kind: ref.t })
    // Reading the file is the costly step: it is saved at once, so that no later request has to read it again
    if (limits.progressEveryMs) await onProgress(board, true).catch(() => {})
    return board
  }

  // The name a translation is kept under: the subtitle, the provider and model, and what changes the outcome
  const keyOf = (cfg, ref) => cacheKey([ref.u, new URL(cfg.b).host, cfg.m, cfg.sdh, cfg.nm, cfg.nt, PROMPT_VERSION])

  // Whether the finished translation is there, to be served at once
  const ready = async key => {
    if (boards.get(key)?.state === 'done') return true
    try {
      return store.hasFinal ? await store.hasFinal(key) : Boolean(await store.getFinal(key))
    } catch {
      return false
    }
  }

  // ── picked twice ──
  // A player does not only fetch a subtitle when the viewer picks it. Nuvio lists the subtitles when a video starts,
  // attaches one in the viewer's language by itself, downloads others to compare their timing, and restores the choice
  // made for the last episode. Each of these is the same request as a deliberate pick, and each would start a
  // translation, paid for from the viewer's allowance, of something the viewer never asked for.
  // So a translation that was never begun is begun by the second pick. The first is answered at once with a line that
  // says so. The requests one pick brings with it (Nuvio asks, then hands the address to its player, which asks again)
  // come within a second or two and count as one; a pick is a second pick when it comes after that, and before the
  // first one is forgotten.
  const armed = new Map()   // key → when the subtitle was first picked
  const firstPickedAt = async key => {
    const here = armed.get(key)
    if (here) return here
    const kept = store.getArmed ? Number(await store.getArmed(key).catch(() => 0)) || 0 : 0
    if (kept) armed.set(key, kept)
    return kept
  }
  const markFirstPick = async (key, at) => {
    armed.delete(key)
    armed.set(key, at)
    if (armed.size > 500) armed.delete(armed.keys().next().value)
    if (store.putArmed) await store.putArmed(key, at).catch(() => {})
  }
  // Whether the translation was begun before: a board in memory, a finished translation, or work that was saved
  const begun = async key => {
    if (boards.has(key)) return true
    if (await ready(key)) return true
    try {
      return Boolean((await store.getProgress(key))?.cues?.length)
    } catch {
      return false
    }
  }
  // True when this request is to be answered with "pick it again" instead of a translation
  const asksAgain = async (cfg, key) => {
    if (!cfg.cf || await begun(key)) return false
    const now = Date.now()
    const first = await firstPickedAt(key)
    if (first && now - first <= number('CONFIRM_WINDOW_MS', 900_000)) return now - first < number('CONFIRM_GAP_MS', 3_000)
    await markFirstPick(key, now)
    return true
  }

  // ── حارس الحلقة الغلط (22) + يدوّر الترجمة الصح (23) ──
  // الترجمة تُحكم باسم ملفها قبل فتحها، فإن لم يحسم الاسم فبأسطرها الأولى. من ثبت أنه لحلقة ثانية لا يُترجم:
  // نبحث في الحلقات المجاورة (نفس الموسم ±3 حلقات) عن ملف يحمل نفس عنوان حلقة المستخدم ونستعمله بدلًا منه.
  const findRightSubtitle = async (cfg, ref, sources, expected, epName) => {
    let checks = 0
    for (const delta of [1, -1, 2, -2, 3, -3]) {
      const at = expected.episode + delta
      if (at < 1) continue   // لا نقارن الحلقات السابقة للحلقة الأولى
      const id = `${expected.imdb}:${expected.season}:${at}`
      let listed
      try { listed = (await mergedSubtitles({ type: 'series', rawId: encodeURIComponent(id), rawExtra: '' }, cfg, sources, platform.log)).merged } catch { continue }
      const good = rank(listed.filter(sub => sub.lang === ref.l), '')
        .filter(sub => byName(`${sub.movieReleaseName || ''} ${sub.subtitleFileName || ''}`, expected, epName) === 'same')
      for (const sub of good) {
        if (checks >= 4) return null   // سقف سعة التذوّق: ما نجرب أكثر من أربعة ملفات من حلقات أخرى
        checks++
        try {
          const raw = await fetchAnySubtitle(sub.url, cfg, sources)
          if (embeddedVerdict(openingCues(parseSubtitle(raw)), expected) !== 'wrong') return { url: sub.url, raw }
        } catch { /* ملف تعذر تحميله: الجرب التالي */ }
      }
    }
    return null
  }

  // يقرر أي ملف يترجم فعلًا. يرجع { ref } عند السلامة، { ref, raw } مع ملف محلول، أو { ref, wrong } حين لا يصلح أي ملف
  const resolveSubtitle = async (cfg, ref, sources) => {
    if (cfg.gd === false) return { ref }
    const expected = parseVideoId(ref.i)
    if (!expected || expected.season == null) return { ref }   // فيلم: لا حلقة تُقارن
    const wanted = `الموسم ${expected.season} الحلقة ${expected.episode}`
    const epName = await episodeTitle({ type: ref.t, id: ref.i }, sources).catch(() => '')
    const { merged: listed } = await mergedSubtitles({ type: ref.t, rawId: encodeURIComponent(ref.i), rawExtra: '' }, cfg, sources, platform.log).catch(() => ({ merged: [] }))
    const entry = listed.find(sub => sub.url === ref.u)
    const releaseVerdict = entry ? byName(`${entry.movieReleaseName || ''} ${entry.subtitleFileName || ''}`, expected, epName) : 'unknown'
    const markerLabel = sub => markersIn(`${sub?.movieReleaseName || ''} ${sub?.subtitleFileName || ''}`)[0]
    if (releaseVerdict === 'same') return { ref }
    if (releaseVerdict === 'wrong') {
      const right = await findRightSubtitle(cfg, ref, sources, expected, epName)
      if (right) return { ref: { ...ref, u: right.url }, raw: right.raw }
      const marker = markerLabel(entry)
      return { ref, wrong: { wanted, found: marker ? `الموسم ${marker.season} الحلقة ${marker.episode}` : 'حلقة أخرى' } }
    }
    // اسم الملف بلا شاهد: نحكم على أول أسطر الترجمة نفسها (الملف يُحمّل الآن أصلًا، ولا حجة لفتح ملف الحلقة الغلط)
    const raw = await fetchAnySubtitle(ref.u, cfg, sources)
    if (embeddedVerdict(openingCues(parseSubtitle(raw)), expected) === 'wrong') {
      const right = await findRightSubtitle(cfg, ref, sources, expected, epName)
      if (right) return { ref: { ...ref, u: right.url }, raw: right.raw }
      return { ref, wrong: { wanted, found: 'سطور داخل الترجمة' } }
    }
    return { ref, raw }
  }

  // ref: { u: address of the subtitle to translate, l: its language, t: movie|series, i: the title's id }
  const ensureBoard = async (cfg, ref, sources) => {
    const key = await keyOf(cfg, ref)
    for (;;) {
      const board = boards.get(key)
      if (!board) break
      if (board.state === 'opening') {
        // Another request is reading the subtitle: wait for it, unless it has been cut off
        if (Date.now() - board.at > 30_000) break
        await sleep(200)
        continue
      }
      if (board.state === 'error') {
        if (Date.now() - board.at < 5_000) return board
        break
      }
      if (board.state === 'failed' && Date.now() - board.finishedAt >= number('RETRY_COOLDOWN_MS', 10_000)) {
        resumeBoard(board, cfg.bs)
        board.partialAt = 0
      }
      return remember(key, board)
    }
    remember(key, { key, state: 'opening', at: Date.now() })
    try {
      return remember(key, await open(key, cfg, ref, sources))
    } catch (error) {
      let message = error.message
      if (message === 'multi-episode') message = 'هذا الملف يحتوي على ترجمات لعدة حلقات في ملف واحد، والتوقيت غير مطابق للحلقة المطلوبة. جرّب ترجمة أخرى أو مصدر ترجمات آخر.'
      return remember(key, { key, state: 'error', error: message, at: Date.now() })
    }
  }

  // The request joins the work on the board. waitMs: how long its answer may be held; it keeps helping for a while after that.
  const join = (board, cfg, ctx, waitMs) => {
    const helper = startHelper(board, llmOf(cfg), { budget: limits.budget, stopAt: Date.now() + waitMs + limits.lingerMs, fast: fast(), onProgress, onDone, backup: backupFor(cfg) })
    ctx.waitUntil(helper.finished)
    return helper
  }

  // ───────────────────────── routes ─────────────────────────

  const handleList = async (request, ctx, cfg, segment, type, rawId, rawExtra) => {
    const nothing = () => json(200, { subtitles: [] }, { 'cache-control': 'no-cache' })
    let id
    try { id = decodeURIComponent(rawId) } catch { return nothing() }
    if (!['movie', 'series'].includes(type) || !ID.test(id)) return nothing()
    const extra = /^[A-Za-z0-9%&=._~!*'()+,;:@$-]*$/.test(rawExtra) ? rawExtra : ''
    const sources = sourceSettings(env)
    const origin = originOf(request, env)
    const { base, merged } = await mergedSubtitles({ type, rawId: encodeURIComponent(id), rawExtra: extra }, cfg, sources, platform.log)
    if (!base && !isAnimeId(id) && !merged.length) return noticeList(origin, 'no-arabic')
    const all = merged
    const filename = new URLSearchParams(extra).get('filename') || ''

    // عربي جاهز من أي مصدر (أوبن سوبتايتلز، ساب دي إل، جيماكو…) — يظهر أولًا، بلا ترجمة
    const arabic = all.filter(sub => sub.lang === 'ara')
    const rankedArabic = rank(arabic, filename)
    let pickedArabic = rankedArabic
    if (cfg.gd !== false) {
      const expected = parseVideoId(id)
      if (expected && expected.season != null) {
        const epName = await episodeTitle({ type, id }, sources).catch(() => '')
        const clean = []
        const wrong = []
        for (const sub of rankedArabic) {
          const verdict = byName(`${sub.movieReleaseName || ''} ${sub.subtitleFileName || ''}`, expected, epName)
          if (verdict === 'wrong') wrong.push(sub)
          else clean.push(sub)
        }
        if (!clean.length && wrong.length) pickedArabic = []
        else pickedArabic = clean
      }
    }
    // تأكد أن المحتوى عربي فعليًا، لا نثق بتصنيف المصدر وحده (قد يضع ترجمة إنجليزية تحت «عربي»)
    const verifiedArabic = []
    const unreachableArabic = []   // تعذّر تنزيلها فقط؛ أما المحتوى غير العربي أو متعدد الحلقات فلا يُعاد
    for (const sub of pickedArabic) {
      let usable = false
      try {
        const text = await fetchExtraSubtitle(sub.url, cfg, sources, {
          subdl: sources.subdl, subdlDl: sources.subdlDl, jimaku: sources.jimaku
        })
        if (!isArabicText(text)) continue
        const cues = tidy(parseSubtitle(text))
        if (isMultiEpisode(cues)) continue
        usable = true
      } catch { unreachableArabic.push(sub); continue }
      if (usable) verifiedArabic.push(sub)
    }
    pickedArabic = verifiedArabic.slice(0, 2)

    // دع الذكاء الاصطناعي يقارن بين الترجمات العربية الجاهزة ويختار أفضل واحدة
    if (cfg.ca && pickedArabic.length > 1) {
      const best = await pickBestArabic(cfg, pickedArabic, sources)
      pickedArabic = [pickedArabic[best]]
    }

    // لغة المصدر للترجمة (لا تُختار العربية أبدًا)
    const lang = pickLanguage(all, cfg.src, cfg.any)
    const wantAI = !cfg.na || !pickedArabic.length
    let picked = []
    if (wantAI && lang) {
      const ranked = rank(all.filter(sub => sub.lang === lang), filename)
      // حارس الحلقة الغلط (22): ملفات الحلقات الثانية تُستبعد من القائمة أصلًا، بشهادة اسم ملفها
      if (cfg.gd !== false) {
        const expected = parseVideoId(id)
        if (expected && expected.season != null) {
          const epName = await episodeTitle({ type, id }, sources).catch(() => '')
          const clean = []
          const wrong = []
          for (const sub of ranked) {
            const verdict = byName(`${sub.movieReleaseName || ''} ${sub.subtitleFileName || ''}`, expected, epName)
            if (verdict === 'wrong') wrong.push(sub)
            else clean.push(sub)
          }
          if (!clean.length && wrong.length) return noticeList(origin, 'wrong')
          picked = clean
        } else {
          picked = ranked
        }
      } else {
        picked = ranked
      }
      // مسافة متبقية بعد أي ترجمات عربية جاهزة
      picked = picked.slice(0, Math.max(0, cfg.n - pickedArabic.length))
    }
    // لو ما لقي ترجمة جاهزة صالحة، أضف fallback الجاهز كخيار جاهز حتى لا يختفي تمامًا
    if (pickedArabic.length === 0 && unreachableArabic.length) {
      pickedArabic = unreachableArabic.slice(0, 2)
    }

    const allPicked = [...pickedArabic, ...picked]
    if (!allPicked.length) return noticeList(origin, 'no-arabic')

    const refs = allPicked.map(sub => ({ u: sub.url, l: sub.lang === 'ara' ? 'ara' : lang, t: type, i: id }))
    // الترجمة الجاهزة لا تحتاج لوحة ترجمة؛ المترجمة تحتاج
    const finished = await Promise.all(refs.map(async ref =>
      ref.l === 'ara' ? true : ready(await keyOf(cfg, ref))))
    const used = new Set()
    const subtitles = allPicked.map((sub, i) => {
      const release = String(sub.movieReleaseName || sub.subtitleFileName || '').replace(/\.(srt|vtt|ass|ssa|sub)$/i, '').trim().slice(0, 60)
      const isReady = sub.lang === 'ara'
      const mark = finished[i] ? '✓' : '⏳'
      const readyLabel = cfg.ca && isReady ? 'عربي جاهز · اختارته AI' : 'عربي جاهز'
      let name = `${isReady ? readyLabel : 'AI'} ${mark} · ${release || (isReady ? 'arabic' : lang)}`
      for (let copy = 2; used.has(name); copy++) name = `${isReady ? readyLabel : 'AI'} ${mark} · ${release || (isReady ? 'arabic' : lang)} #${copy}`
      used.add(name)
      const route = isReady ? 'r' : 't'
      return { id: name, lang: 'ara', label: name, url: `${origin}/${segment}/${route}/${encodeText(JSON.stringify(refs[i]))}.vtt` }
    })
    // Started now, while the viewer is still looking at the list, so that the translation is ready or well on its way when picked
    if (cfg.warm && refs[0] && refs[0].l !== 'ara' && request.method !== 'HEAD') {
      ctx.waitUntil((async () => {
        const board = await ensureBoard(cfg, refs[0], sources)
        if (board.state === 'running') await join(board, cfg, ctx, 0).finished
        // فكرة 10: الحلقة الجاية جاهزة — تُجهّز بعد انتهاء الحالية (وتستهلك كما لو اختارها المشاهد؛ للمسلسلات فقط)
        if (cfg.pn && type === 'series') {
          const expected = parseVideoId(id)
          if (expected?.season != null && expected?.episode != null) {
            const nextId = `${expected.imdb}:${expected.season}:${expected.episode + 1}`
            const nextList = await listSubtitles({ type: 'series', rawId: encodeURIComponent(nextId), rawExtra: '' }, sources).catch(() => [])
            const nextLang = pickLanguage(nextList, cfg.src, cfg.any)
            const nextPicked = nextLang ? rank(nextList.filter(sub => sub.lang === nextLang), filename) : []
            if (nextPicked.length) {
              const nextCfg = cfg, nextRef = { u: nextPicked[0].url, l: nextLang, t: 'series', i: nextId }
              const nextKey = keyOf(nextCfg, nextRef)
              if (!(await ready(nextKey))) {
                const next = await ensureBoard(nextCfg, nextRef, sources)
                if (next.state === 'running') await join(next, nextCfg, ctx, 0).finished
              }
            }
          }
        }
      })().catch(error => platform.log?.(`could not start translating: ${error.message}`)))
    }
    return json(200, { subtitles }, { 'cache-control': 'no-cache' })
  }

  // Holds the answer while the translation runs. The body starts at once and a blank line follows every few seconds, so
  // that players which give up on a silent connection (15 s for Nuvio's first download, 60 s for mpv) stay on the line.
  const hold = (board, helper, ctx, waitMs) => {
    const { readable, writable } = new TransformStream()
    const writer = writable.getWriter()
    const encoder = new TextEncoder()
    const write = part => writer.write(encoder.encode(part))
    ctx.waitUntil((async () => {
      try {
        await write(HEADER)
        const deadline = Date.now() + waitMs
        const quietMs = number('TRICKLE_MS', 5_000)
        let quietSince = Date.now()
        while (board.state === 'running' && Date.now() < deadline && alive(board)) {
          await sleep(Math.min(400, quietMs))
          if (Date.now() - quietSince >= quietMs) {
            await write('\n')
            quietSince = Date.now()
          }
        }
        const { body, complete } = render(board)
        if (!complete) board.partialAt = Date.now()
        await write(body.slice(HEADER.length))
        await writer.close()
      } catch {
        // The player hung up. Where requests are cut off 30 seconds after that (Cloudflare), this one soon takes no new batch.
        if (Number.isFinite(limits.lingerMs)) helper.stopAt = Math.min(helper.stopAt, Date.now() + 12_000)
        await writer.abort().catch(() => {})
      }
    })())
    return respond(200, { 'content-type': VTT, 'cache-control': 'no-store, no-transform' }, readable)
  }

  // يقارن الذكاء الاصطناعي بين الترجمات العربية الجاهزة ويختار أفضل واحدة
  const pickBestArabic = async (cfg, subs, sources) => {
    if (subs.length <= 1) return 0
    await assertProviderAllowed(cfg.b, { allowLocal: allowLocal(), lookup: platform.lookup })
    const texts = await Promise.all(subs.map(async (sub, idx) => {
      try {
        const text = await fetchExtraSubtitle(sub.url, cfg, sources, {
          subdl: sources.subdl, subdlDl: sources.subdlDl, jimaku: sources.jimaku
        })
        return `الترجمة ${idx + 1}:\n${text.slice(0, 6000)}\n`
      } catch { return `الترجمة ${idx + 1}: (لا يمكن قراءتها)` }
    }))
    const prompt = texts.join('\n---\n')
    try {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 15_000)
      const response = await safeFetch(`${cfg.b}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${cfg.k}`
        },
        body: JSON.stringify({
          model: cfg.m,
          messages: [
            { role: 'system', content: 'أنت تقارن بين ترجمات عربية جاهزة لفيلم أو حلقة. اختر أفضل ترجمة من حيث الدقة، وسلاسة اللغة، والتوقيت، واكتمال الحوار. رجع رقم الترجمة الأفضل فقط (مثلاً: 1 أو 2 أو 3).' },
            { role: 'user', content: prompt }
          ],
          max_tokens: 10,
          temperature: 0
        }),
        signal: controller.signal
      })
      clearTimeout(timeout)
      if (!response.ok) throw new Error(`رد المزوّد بحالة ${response.status}`)
      const result = await response.json()
      const choice = parseInt(String(result.choices?.[0]?.message?.content || '').trim(), 10)
      if (choice >= 1 && choice <= subs.length) return choice - 1
    } catch {}
    return 0
  }

  // ملف ترجمة عربي جاهز من أي مصدر — يُعاد توصيله كـ WebVTT من دون ترجمة
  const handleReady = async (request, ctx, cfg, link) => {
    let ref
    try { ref = JSON.parse(decodeText(link)) } catch {}
    const sources = sourceSettings(env)
    const valid = ref && typeof ref.u === 'string' && sources.allow.test(ref.u) && ['movie', 'series'].includes(ref.t) && ID.test(ref.i || '') && ref.l === 'ara'
    if (!valid) return text(400, 'bad subtitle link')
    const text = await fetchExtraSubtitle(ref.u, cfg, sources, {
      subdl: sources.subdl, subdlDl: sources.subdlDl, jimaku: sources.jimaku
    })
    const cues = parseSubtitle(text)
    if (isMultiEpisode(cues)) {
      return respond(200, { 'content-type': VTT, 'cache-control': 'no-store, no-transform' },
        buildVtt([{ start: 0, end: 10, text: '⚠️ هذا الملف يحتوي على ترجمات لعدة حلقات في ملف واحد، والتوقيت غير مطابق للحلقة المطلوبة. جرّب ترجمة أخرى أو مصدر ترجمات آخر.', rtl: true, top: true }]))
    }
    const vtt = buildVtt(cues)
    return respond(200, { 'content-type': VTT, 'cache-control': 'no-store, no-transform' }, vtt)
  }

  const handleTrack = async (request, ctx, cfg, link) => {
    let ref
    try { ref = JSON.parse(decodeText(link)) } catch {}
    const sources = sourceSettings(env)
    const valid = ref && typeof ref.u === 'string' && sources.allow.test(ref.u) && ['movie', 'series'].includes(ref.t) && ID.test(ref.i || '') && /^[a-z]{3}$/.test(ref.l || '')
    if (!valid) return text(400, 'bad subtitle link')
    if (request.method === 'HEAD') return vtt(null, false)
    if (await asksAgain(cfg, await keyOf(cfg, ref))) return vtt(askAgain(), false)
    const board = await ensureBoard(cfg, ref, sources)
    if (board.state === 'wrong') {
      platform.log?.(`refused to translate the wrong episode: ${board.wanted} vs ${board.found}`)
      const found = board.found || 'حلقة ثانية'
      const message = `⚠️ هالترجمة تطابق ${found}\nالحلقة المطلوبة: ${board.wanted}\nترجمان يدوّر في الحلقات المجاورة عن الملف الصح؛ ما تنترجم قبل ما يلقاه.`
      return vtt(messageTrack(message), false)
    }
    if (board.state === 'error') {
      platform.log?.(`could not prepare the translation: ${board.error}`)
      return vtt(messageTrack(`⚠️ تعذّر تجهيز الترجمة: ${board.error}`), false)
    }
    if (board.state === 'done') { const saved = countHit(); ctx?.waitUntil?.(saved); return vtt(render(board).body, true) }
    // A player that waited, was given a partial translation and asks again at once (Nuvio's second download) gets the same
    // without another wait. Only an answer that was waited for opens this window: answers given at once do not keep it open.
    const justWaited = board.partialAt && Date.now() - board.partialAt < number('REPICK_MS', 8_000)
    const waitMs = justWaited ? 0 : cfg.wait * 1000
    const helper = join(board, cfg, ctx, waitMs)
    if (board.state === 'running' && waitMs > 0) return hold(board, helper, ctx, waitMs)
    const { body, complete } = render(board)
    return vtt(body, complete)
  }

  // The settings page's "try it" button: three lines through the viewer's own provider, key and model
  const handleTest = async request => {
    let cfg
    try {
      const body = await request.text()
      if (body.length > 8000) throw new ConfigError('الطلب أكبر من المتوقع')
      cfg = normalize(JSON.parse(body))
      await assertProviderAllowed(cfg.b, { allowLocal: allowLocal(), lookup: platform.lookup })
    } catch (error) {
      return json(200, { ok: false, error: error instanceof ConfigError ? error.message : 'الإعدادات غير مقروءة' })
    }
    const started = Date.now()
    const cues = SAMPLE.map((line, i) => ({ start: i * 3, end: i * 3 + 2, text: line }))
    const board = createBoard({ key: 'test', cues, from: 'English', about: 'a short test', batchSize: 10 })
    const helper = startHelper(board, { ...llmOf(cfg), concurrency: 1 }, { budget: 8, fast: fast() })
    await Promise.race([helper.finished, sleep(number('TEST_TIMEOUT_MS', 75_000))])
    if (board.state !== 'done') {
      const reason = board.error || board.lastError || 'لم يرد النموذج في الوقت المحدد'
      if (board.state === 'running') Object.assign(board, { state: 'failed', error: reason })   // which also stops the helper
      return json(200, { ok: false, error: reason })
    }
    return json(200, { ok: true, seconds: +((Date.now() - started) / 1000).toFixed(1), lines: cues.map((cue, i) => ({ from: cue.text, to: board.out[i] })) })
  }

  // What the settings page shows about the server it runs on: whether translations are kept, and whether the subtitles source answers from here
  // فكرة 38: صفحة التقرير — كل الأرقام تُحسب هنا ولا تُرسل لأي طرف
  const handleReport = async () => {
    if (!store.getReport) return text(404, 'التقرير يحتاج مخزن الترجمات مفعّلًا')
    let data = null
    try { data = await store.getReport(monthKey()) } catch {}
    const label = new Intl.DateTimeFormat('ar', { month: 'long', year: 'numeric' }).format(new Date())
    return respond(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, reportHtml(data, label))
  }

  const handleStatus = async () => {
    const [stored, source] = await Promise.all([store.probe().catch(() => false), probeSource(sourceSettings(env))])
    return json(200, { ok: true, version: VERSION, runtime: platform.runtime, storage: stored ? store.kind : 'none', source }, { 'cache-control': 'no-store' })
  }

  return async (request, ctx) => {
    const { pathname } = new URL(request.url)
    const { method } = request
    if (method === 'OPTIONS') return respond(204, {})
    if (pathname === '/api/test' && method === 'POST') return handleTest(request)
    if (method !== 'GET' && method !== 'HEAD') return text(405, 'method not allowed')
    if (pathname === '/' || pathname === '/configure') return html()
    if (pathname === '/manifest.json') return json(200, manifest(originOf(request, env), false, platform.hasLogo))
    if (pathname === '/health') return json(200, { ok: true, version: VERSION })
    if (pathname === '/api/status') return handleStatus()
    if (pathname === '/logo.png' && platform.hasLogo) return respond(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' }, platform.logo())

    const [, segment, ...rest] = pathname.split('/')
    if (rest.length === 1 && rest[0] === 'configure') return html()
    if (segment === 'subtitles' && (rest.length === 2 || rest.length === 3) && rest.at(-1).endsWith('.json')) return noticeList(originOf(request, env), 'setup')
    if (segment === 'notice' && rest.length === 1 && rest[0].endsWith('.vtt') && Object.hasOwn(NOTICES, rest[0].slice(0, -4))) return vtt(messageTrack(NOTICES[rest[0].slice(0, -4)][1]), false)
    const isManifest = rest.length === 1 && rest[0] === 'manifest.json'
    const isList = rest[0] === 'subtitles' && (rest.length === 3 || rest.length === 4) && rest.at(-1).endsWith('.json')
    const isTrack = rest[0] === 't' && rest.length === 2 && rest[1].endsWith('.vtt')
    const isReady = rest[0] === 'r' && rest.length === 2 && rest[1].endsWith('.vtt')
    const isReport = rest.length === 1 && rest[0] === 'report'
    if (!isManifest && !isList && !isTrack && !isReady && !isReport) return text(404, 'not found')

    let cfg
    try {
      cfg = decodeConfig(segment)
    } catch (error) {
      const message = error instanceof ConfigError ? error.message : 'الإعدادات غير مقروءة'
      if (isTrack) return vtt(messageTrack(`⚠️ ${message}. افتح صفحة إعدادات الإضافة وثبّتها من جديد`), false)
      return isList ? noticeList(originOf(request, env), 'link') : json(400, { error: message })
    }
    if (isManifest) return json(200, manifest(originOf(request, env), true, platform.hasLogo))
    if (isReport) return handleReport()
    if (isReady) return handleReady(request, ctx, cfg, rest[1].slice(0, -4))
    if (isTrack) return handleTrack(request, ctx, cfg, rest[1].slice(0, -4))
    const last = rest.at(-1).slice(0, -5)
    return handleList(request, ctx, cfg, segment, rest[1], rest.length === 3 ? last : rest[2], rest.length === 4 ? last : '')
  }
}
