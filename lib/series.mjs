// One name dictionary per show (ideas 14 + 17): built from AniList's character list for the show,
// with the gender known per character and the Arabic spelling learned the first time it is used — and kept.
//
// Where it lives: the same store the translations are kept in. Nothing is kept twice, nothing is invented.
// Failures are silent on purpose: a show that matches nothing gets today's behaviour, unchanged.

import { animeCharacters, searchAnime } from './anilist.mjs'
import { animeMeta, isAnimeId } from './anime.mjs'
import { parseVideoId } from './episode.mjs'
import { metaFor } from './sources.mjs'

// The catalogue page gives us the name, the year and the genre; AniList does the rest.
export const showFacts = async ({ type, id }, settings) => {
  if (type !== 'series') return null
  let meta
  try {
    meta = isAnimeId(id) ? await animeMeta(id, { kitsu: settings.kitsu || undefined, anilist: settings.anilist || undefined }) : await metaFor({ type, id }, settings)
  } catch { return null }
  const name = String(meta.name || '').trim()
  if (!name) return null
  return { name, year: Number(String(meta.releaseInfo || meta.year || '').slice(0, 4)) || 0, genres: meta.genres || meta.genre || [] }
}

const genderOf = gender => (/^male$/i.test(gender) ? 'man' : /^female$/i.test(gender) ? 'woman' : 'other')

// The list for one show, from wherever it is kept, building it on first use. Null when it cannot be known.
export const seriesNames = async (ref, sources, store, url = '') => {
  const expected = parseVideoId(ref.i)
  if (ref.t !== 'series') return null
  const key = expected?.imdb || String(ref.i).replace(/:/g, '_')
  if (store.getNames) {
    const kept = await store.getNames(key).catch(() => null)
    if (kept && Array.isArray(kept.names)) return kept.names.length ? kept.names : null   // an empty list means "checked, nothing known"
  }
  const facts = await showFacts({ type: ref.t, id: ref.i }, sources)
  if (!facts || !facts.genres.some(genre => /animation/i.test(genre))) return null   // أفلام وأنمي الميديا فقط بحكم التعريف
  let names = []
  try {
    const found = await searchAnime({ name: facts.name, year: facts.year }, url)
    if (found) names = (await animeCharacters(found.id, url)).map(character => ({ name: character.name, native: character.native || '', arabic: '', kind: genderOf(character.gender) })).slice(0, 80)
  } catch { names = null }
  if (!names) return null
  if (store.putNames) await store.putNames(key, { names }).catch(() => {})
  return names.length ? names : null
}

// Merge what a brief reply taught us back into the stored list: the first spelling of an Arabic name stays for good.
// entries: { name, arabic, kind } from a brief. Returns the spellings that were missing and are now kept.
export const learnSeriesNames = async (key, entries, store) => {
  if (!store.getNames || !store.putNames) return 0
  const kept = await store.getNames(key).catch(() => null)
  if (!kept || !Array.isArray(kept.names)) return 0
  const index = new Map(kept.names.map(entry => [entry.name.toLowerCase(), entry]))
  let learned = 0
  for (const entry of entries) {
    const known = index.get(String(entry.name || '').toLowerCase())
    if (!known) continue
    if (!known.arabic && entry.arabic) { known.arabic = String(entry.arabic).slice(0, 80); learned++ }
    if (known.kind === 'other' && ['man', 'woman'].includes(entry.kind)) known.kind = entry.kind
  }
  if (learned) await store.putNames(key, kept).catch(() => {})
  return learned
}

// The stored entry for what the model wrote, if any: exactly as it was written, in no particular case; or, when the
// model wrote a single word and only one stored name starts with it («Eren» → «Eren Yeager»), that one — ambiguously, nothing.
export const storedEntry = (name, seriesList) => {
  const lower = String(name || '').toLowerCase()
  if (!lower) return null
  const exact = seriesList.find(known => known.name.toLowerCase() === lower)
  if (exact) return exact
  if (lower.includes(' ')) return null
  const starting = seriesList.filter(known => known.name.toLowerCase().startsWith(`${lower} `))
  return starting.length === 1 ? starting[0] : null
}

// A brief entry vs the stored dictionary: stored spelling and stored gender win; the model's spelling is only
// used to fill a gap, and it is reported back to be stored. seriesList may be empty; entry comes from the model.
export const applySeriesNames = (entry, seriesList) => {
  if (!seriesList?.length) return { entry, learned: null }
  const stored = storedEntry(entry.name, seriesList)
  if (!stored) return { entry, learned: null }
  const learned = !stored.arabic && entry.arabic ? { name: stored.name, arabic: String(entry.arabic).slice(0, 80), kind: entry.kind } : null
  return {
    entry: { ...entry, arabic: stored.arabic || entry.arabic, kind: ['man', 'woman'].includes(stored.kind) ? stored.kind : entry.kind },
    learned,
  }
}
