// فكرة 24: كتالوجات الأنمي — Kitsu و MAL و AniList.
//
// عادة Nuvio مع كتالوجات الأنمي يسلّم المعرّف بصيغة kitsu:7442 (أو kitsu:7442:1 — الحلقة) بدل tt<imdb>:<موسم>:<حلقة>.
// ترجمان كان يرفض هالشكل بالكامل ولا تظهر له قائمة. هذا الملف يعرف الأنمي المقصود من معرّفه،
// سواء من معرّف Kitsu مباشرة، أو معرّف MyAnimeList (يُقرأ عبر AniList لأن مال ما عنده قراءة مجانية بلا تسجيل)،
// أو معرّف AniList مباشرة. GraphQL من AniList مجاني وبدون مفتاح.
//
// أي فشل هنا لا يمنع المشاهدة أبدًا: عنوات مفقودة تقلّل جودة الحارس فقط — الترجمة تكمل.

const KITSU_DEFAULT = 'https://kitsu.io'
const ANILIST_DEFAULT = 'https://graphql.anilist.co'
const TIMEOUT_MS = 8_000
const UA = 'tarjuman-addon (anime subtitles)'

// "kitsu:7442" أو "kitsu:7442:1" (الحلقة 1) · "mal:16498[:3]" · "anilist:16498[:3]"
export const parseAnimeId = id => {
  const match = /^(kitsu|mal|anilist):(\d{1,9})(?::(\d{1,5}))?$/.exec(String(id || ''))
  if (!match) return null
  return { family: match[1], id: Number(match[2]), episode: match[3] === undefined ? null : Number(match[3]) }
}
export const isAnimeId = id => parseAnimeId(id) !== null
export const ID_OR_ANIME = /^(?:tt\d{5,10}(?::\d{1,4}:\d{1,4})?|(?:kitsu|mal|anilist):\d{1,9}(?::\d{1,5})?)$/

const stripHtml = html => String(html || '')
  .replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/\s+([.,!?;:])/g, '$1').replace(/\s+/g, ' ').trim()

const kitsuGet = async (kitsuUrl, path) => {
  const response = await fetch(`${kitsuUrl}/api/edge${path}`, {
    headers: { 'user-agent': UA, accept: 'application/vnd.api+json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${response.status} from ${new URL(kitsuUrl).host}`)
  return response.json()
}

// AniList GraphQL — مجاني وبدون مفتاح، يقبل id أو idMal
const anilistPost = async (anilistUrl, query, variables) => {
  const response = await fetch(anilistUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json', 'x-client-id': 'tarjuman-addon' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${response.status} from ${new URL(anilistUrl).host}`)
  const body = await response.json().catch(() => null)
  if (body?.errors?.length) throw new Error(String(body.errors[0]?.message || 'graphql error').slice(0, 150))
  return body?.data
}

const fromAnilist = async (anilistUrl, { family, id }) => {
  const argument = family === 'mal' ? 'idMal' : 'id'
  const data = await anilistPost(anilistUrl, `query ($id: Int!) { Media(${argument}: $id, type: ANIME) { id idMal title { romaji english native } description startDate { year } } }`, { id })
  const media = data?.Media
  if (!media?.id) return null
  return {
    about: stripHtml(media.description).slice(0, 600),
    title: media.title?.english || media.title?.romaji || media.title?.native || String(id),
    original: media.title?.native || '',
    year: Number(media.startDate?.year) || 0,
    anilistId: media.id,
    malId: Number(media.idMal) || null,
  }
}

// Everything ترجمان knows about one anime: what to tell the model about the show, and which
// catalogue ids exist (the Jimaku directory is keyed by AniList; SubDL wants a title).
export const animeMeta = async (rawId, { kitsu = KITSU_DEFAULT, anilist = ANILIST_DEFAULT } = {}) => {
  const parsed = parseAnimeId(rawId)
  if (!parsed) return null
  try {
    if (parsed.family === 'kitsu') {
      const [anime, mappings] = await Promise.all([
        kitsuGet(kitsu, `/anime/${parsed.id}`),
        kitsuGet(kitsu, `/anime/${parsed.id}/mappings?fields[mappings]=externalSite,externalId`).catch(() => null),
      ])
      const a = anime?.data?.attributes
      if (!a) return null
      const mapped = {}
      for (const entry of mappings?.data || []) {
        if (entry?.attributes?.externalSite) mapped[entry.attributes.externalSite] = entry.attributes.externalId
      }
      return {
        title: a.titles?.en || a.canonicalTitle || String(parsed.id),
        original: a.titles?.ja_jp || '',
        year: Number(String(a.startDate || '').slice(0, 4)) || 0,
        about: stripHtml(a.synopsis || a.description).slice(0, 600),
        episode: parsed.episode,
        anilistId: Number(mapped['anilist/anime']) || null,
        malId: Number(mapped['myanimelist/anime']) || null,
      }
    }
    const meta = await fromAnilist(anilist, parsed)
    if (!meta) return null
    return { ...meta, episode: parsed.episode }
  } catch {
    // فشل الكتالوج ليس حاجزًا عن المشاهدة: عناوين أضعف، تظل الترجمة تكمل
    return { title: '', original: '', year: 0, about: '', episode: parsed.episode, anilistId: parsed.family === 'anilist' ? parsed.id : null, malId: null }
  }
}

// الحلقة بعنوانها — شهود قوي للحارس. المصدر الوحيد الموثوق للعناوين هو Kitsu (فيها عناوين الحلقات).
export const animeEpisodeTitle = async (rawId, { kitsu = KITSU_DEFAULT } = {}) => {
  const parsed = parseAnimeId(rawId)
  if (!parsed?.episode) return ''
  if (parsed.family !== 'kitsu') return ''   // AniList streamingEpisodes غير مرتيحة؛ من kitsu يكفي
  try {
    const body = await kitsuGet(kitsu, `/episodes?filter[mediaId]=${parsed.id}&filter[number]=${parsed.episode}&fields[episodes]=titles,canonicalTitle&page[limit]=1`)
    const a = body?.data?.[0]?.attributes
    return String(a?.titles?.en_us || a?.titles?.en_jp || a?.canonicalTitle || '').slice(0, 120)
  } catch {
    return ''
  }
}
