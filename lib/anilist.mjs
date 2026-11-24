// AniList: one dictionary of names per show — the characters known from its database, with their genders,
// so that a name is spelt the same in every episode and the gender agrees with every verb (ideas 14 + 17).
//
// Free and keyless; only the show's own title and year leave the server. Nothing about the viewer is sent.
// Any failure means the show counts as unknown and behaves exactly as before — never a block, never an error for the viewer.

const DEFAULT_URL = 'https://graphql.anilist.co'
const TIMEOUT_MS = 8_000

const post = async (url, query, variables) => {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`)
  const body = await response.json().catch(() => null)
  if (body?.errors?.length) throw new Error(String(body.errors[0]?.message || 'graphql error').slice(0, 200))
  return body?.data
}

// One show, matched to the catalogue page facts: title and, when known, year within two years either way.
export const searchAnime = async ({ name, year }, url = '') => {
  if (!name) return null
  url = url || DEFAULT_URL
  const data = await post(url, `query ($search: String!) { Page(page: 1, perPage: 5) { media(search: $search, type: ANIME, sort: SEARCH_MATCH) { id title { romaji english native } startDate { year } } } }`, { search: String(name).slice(0, 200) })
  const media = (data?.Page?.media || [])[0]
  if (!media?.id) return null
  const its = Number(media.startDate?.year) || 0
  if (year && its && Math.abs(its - year) > 2) return null
  return { id: media.id, title: String(media.title?.english || media.title?.romaji || name), year: its || year || 0 }
}

// The characters: most loved first, so the names the show is remembered by come first. Up to 80.
export const animeCharacters = async (mediaId, url = '') => {
  url = url || DEFAULT_URL
  const data = await post(url, `query ($id: Int!) { Media(id: $id) { characters(sort: [FAVOURITES_DESC], perPage: 80) { edges { node { id name { full native } gender } } } } }`, { id: mediaId })
  return (data?.Media?.characters?.edges || [])
    .map(edge => ({
      id: edge?.node?.id,
      name: String(edge?.node?.name?.full || '').trim(),
      native: String(edge?.node?.name?.native || '').trim(),
      gender: String(edge?.node?.gender || '').trim(),
    }))
    .filter(entry => entry.id && entry.name)
}
