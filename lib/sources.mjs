// Where the subtitles to translate come from: OpenSubtitles, through the public endpoint of Stremio's own addon.
// An addon is never given the video, so it cannot read the tracks inside the file. What it gets is the title's id and,
// when the player knows them, the file's name, size and hash: enough to find the same subtitle online, matched to the file.

import { isAnimeId, animeMeta, animeEpisodeTitle } from './anime.mjs'
import { readTextLimited } from './config.mjs'

const AGENT = { 'user-agent': 'tarjuman-addon/0.2' }

// env: name → value. allow: only subtitles from these hosts are ever downloaded, as the address travels in a link anyone could rewrite
export const sourceSettings = env => ({
  source: (env('SUBS_SOURCE') || 'https://opensubtitles-v3.strem.io').replace(/\/+$/, ''),
  meta: (env('META_SOURCE') || 'https://v3-cinemeta.strem.io').replace(/\/+$/, ''),
  // المضيفات المسموحة بتنزيل ترجمات منها: Stremio/OpenSubtitles و SubDL و Jimaku (فكرة 25). العنوان يمر داخل رابط المستخدم، فالتقييد مهم.
  allow: new RegExp(env('SUBS_ALLOW') || '^https://([a-z0-9-]+\\.)*(strem\\.io|subdl\\.com|jimaku\\.cc|lsoares\\.workers\\.dev)/', 'i'),
  kitsu: env('KITSU_URL') || '', anilist: env('ANILIST_URL') || '', subdl: env('SUBDL_URL') || '', subdlDl: env('SUBDL_DL_URL') || '', jimaku: env('JIMAKU_URL') || '', popcorn: env('POPCORN_URL') || '',
  extraMs: Math.max(500, Math.min(8_000, Number(env('EXTRA_TIMEOUT_MS')) || 3_000)),
})

const getJson = async (url, timeoutMs) => {
  const response = await fetch(url, { headers: AGENT, signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`)
  return JSON.parse(await readTextLimited(response))
}

const lists = new Map()   // address → { at, subtitles }, so reopening a title doesn't ask again
const LIST_TTL = 10 * 60_000

// rawId and rawExtra are the path segments exactly as the player sent them (still percent-encoded).
// Players give up on an addon's list after about 10 seconds (Nuvio does), so the source gets 8.
export const listSubtitles = async ({ type, rawId, rawExtra }, settings) => {
  const cacheKey = `${type}/${rawId}`
  const url = `${settings.source}/subtitles/${type}/${rawId}${rawExtra ? `/${rawExtra}` : ''}.json`
  const kept = lists.get(cacheKey)
  if (kept && Date.now() - kept.at < LIST_TTL) return kept.subtitles
  const subtitles = ((await getJson(url, 8_000)).subtitles || []).filter(sub => sub?.url && sub?.lang && settings.allow.test(sub.url))
  if (lists.size > 200) lists.delete(lists.keys().next().value)
  lists.set(cacheKey, { at: Date.now(), subtitles })
  return subtitles
}

// Whether the source answers from where this server runs: for the settings page's status line
export const probeSource = async settings => {
  const started = Date.now()
  try {
    const response = await fetch(`${settings.source}/subtitles/movie/tt0111161.json`, { headers: AGENT, signal: AbortSignal.timeout(6_000) })
    await response.body?.cancel()
    return { ok: response.ok, status: response.status, ms: Date.now() - started }
  } catch (error) {
    return { ok: false, error: error.name === 'TimeoutError' ? 'timeout' : 'unreachable', ms: Date.now() - started }
  }
}

const CAM = /\b(cam|camrip|hdcam|ts|hdts|telesync|tc|telecine|scr|screener)\b/i
const spaced = name => String(name || '').replace(/[._]+/g, ' ')
const words = name => new Set(spaced(name).toLowerCase().split(/[^a-z0-9]+/).filter(word => word.length > 1))

// Best match for the video file first: same hash, then the most words in common with the file's name; cinema recordings last
export const rank = (subtitles, filename = '') => {
  const mine = words(filename)
  const cinema = CAM.test(spaced(filename))
  return subtitles
    .map((sub, order) => {
      const name = `${sub.movieReleaseName || ''} ${sub.subtitleFileName || ''}`
      let score = sub.m === 'h' ? 100 : 0   // 'h': matched by the file's hash, as OpenSubtitles marks it
      if (mine.size) score += [...words(name)].filter(word => mine.has(word)).length
      if (CAM.test(spaced(name)) && !cinema) score -= 20
      return { sub, score, order }
    })
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map(entry => entry.sub)
}

// The language to translate from: the chosen one, or, when allowed, the first of these that the title has (never Arabic itself)
const FALLBACK = ['eng', 'fre', 'spa', 'ger', 'ita', 'por', 'pob', 'rus', 'tur', 'dut', 'pol', 'jpn', 'kor']
export const pickLanguage = (subtitles, preferred, anyLanguage) => {
  const has = lang => subtitles.some(sub => sub.lang === lang)
  if (has(preferred)) return preferred
  if (!anyLanguage) return null
  return FALLBACK.find(has) ?? subtitles.find(sub => sub.lang !== 'ara')?.lang ?? null
}

const NAMES = {
  eng: 'English', fre: 'French', spa: 'Spanish', ger: 'German', ita: 'Italian', por: 'Portuguese', pob: 'Brazilian Portuguese',
  rus: 'Russian', tur: 'Turkish', dut: 'Dutch', pol: 'Polish', jpn: 'Japanese', kor: 'Korean', chi: 'Chinese', hin: 'Hindi',
  swe: 'Swedish', dan: 'Danish', nor: 'Norwegian', fin: 'Finnish', gre: 'Greek', heb: 'Hebrew', per: 'Persian', ind: 'Indonesian',
}
export const languageName = code => NAMES[code] || 'the source language'

export const fetchSubtitle = async (url, settings) => {
  if (!settings.allow.test(url)) throw new Error('subtitle address not allowed')
  const response = await fetch(url, { headers: AGENT, signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`)
  const text = await readTextLimited(response)
  if (text.length > 3_000_000) throw new Error('subtitle file too large')
  return text
}

const titles = new Map()
const metas = new Map()

// One fetch of the title's catalogue page, shared: the "about" line, and the episode's own name (the wrong-episode guard uses it)
export const metaFor = async ({ type, id }, settings) => {
  if (isAnimeId(id)) return {}
  const imdb = String(id || '').split(':')[0]
  const key = `${type}/${imdb}`
  const kept = metas.get(key)
  if (kept !== undefined) return kept
  const { meta } = await getJson(`${settings.meta}/meta/${type}/${imdb}.json`, 5_000)
  const metaOrNothing = meta || {}
  if (metas.size > 100) metas.delete(metas.keys().next().value)
  metas.set(key, metaOrNothing)
  return metaOrNothing
}

// The episode's name, normalised (accents and punctuation gone). Empty for a film or an unknown episode
export const episodeTitle = async ({ type, id }, settings) => {
  if (isAnimeId(id)) return animeEpisodeTitle(id, { kitsu: settings.kitsu || undefined }).catch(() => '')
  const [imdb, season, episode] = String(id || '').split(':')
  if (type !== 'series' || !season || !episode) return ''
  let meta
  try { meta = await metaFor({ type, id }, settings) } catch { return '' }
  const video = (meta.videos || []).find(item => String(item.season) === season && String(item.episode) === episode)
  const plain = String(video?.name || video?.title || '').toLowerCase().normalize('NFKD').replace(/\p{Diacritic}/gu, '')
  return plain.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim()
}

// A text cut at a word, without the full stop the sentence around it brings
const clip = (text, max) => {
  const plain = String(text || '').replace(/\s+/g, ' ').trim()
  const cut = plain.length <= max ? plain : `${plain.slice(0, max).replace(/\s+\S*$/, '')}…`
  return cut.replace(/[.\s]+$/, '')
}

// "Breaking Bad (2008), a Crime, Drama series, season 2 episode 3 "Bit by a Dead Bee". The story: …" — context for the model.
// Empty when unknown.
export const describeTitle = async ({ type, id }, settings) => {
  const [imdb, season, episode] = id.split(':')
  const known = titles.get(id)
  if (known !== undefined) return known
  if (isAnimeId(id)) {
    let about = ''
    try {
      const meta = await animeMeta(id, { kitsu: settings.kitsu || undefined, anilist: settings.anilist || undefined })
      const kind = type === 'series' ? 'anime series' : 'anime film'
      const year = meta?.year ? ` (${meta.year})` : ''
      about = `${meta?.title || id}${year}, an ${kind}`
      if (meta?.original) about += `, original title: ${meta.original}`
      if (meta?.episode != null) about += `, episode ${meta.episode}`
      const story = clip(meta?.about, 350)
      if (story) about += `. The story: ${story}`
    } catch {}
    if (titles.size > 300) titles.delete(titles.keys().next().value)
    titles.set(id, about)
    return about
  }
  let about = ''
  try {
    const meta = await metaFor({ type, id }, settings)
    const year = String(meta.releaseInfo || meta.year || '').slice(0, 4)
    const genres = (meta.genres || meta.genre || []).slice(0, 3).join(', ')
    about = `${meta.name}${year ? ` (${year})` : ''}, a ${genres ? `${genres} ` : ''}${type === 'series' ? 'series' : 'film'}`
    let video
    if (season && episode) {
      video = (meta.videos || []).find(item => String(item.season) === season && String(item.episode) === episode)
      const name = video?.name || video?.title
      about += `, season ${season} episode ${episode}${name ? ` "${name}"` : ''}`
    }
    // What the story is about tells a translator who the people are and what their words refer to
    const story = clip(meta.description, 350), part = clip(video?.overview || video?.description, 250)
    if (story) about += `. The story: ${story}`
    if (part) about += `. This episode: ${part}`
  } catch {}
  if (titles.size > 300) titles.delete(titles.keys().next().value)
  titles.set(id, about)
  return about
}
