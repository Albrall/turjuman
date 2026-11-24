// The wrong-episode guard (idea 22) and the search for the right file (idea 23).
//
// A player hands ترجمان the title's id as tt<imdb>:<season>:<episode>, so for a series the episode that
// was asked for is never in doubt. Two cheap witnesses tell us a subtitle belongs to another episode:
//   1. the release the subtitle was made for (movieReleaseName / subtitleFileName): "…S03E11…", "Season 3 Episode 12",
//      "الموسم ٣ الحلقة ١٢" — compared against the requested season and episode;
//   2. the lines at the top of the subtitle itself (many fansubs open with their full name or "Episode 12").
// An unqualified episode number ("Episode 12") is never proof either way: anime is numbered in absolute
// order, so only an explicit season+episode marker is treated as a verdict. A title the translation
// itself names ("Night of the Battle to Retake the Wall") is a strong positive witness.

// "tt1375666:3:12" → { imdb, season, episode } (season/episode null for a plain movie id). Other shapes → null.
export const parseVideoId = id => {
  const match = /^(tt\d{5,10})(?::(\d{1,4}):(\d{1,4}))?$/.exec(String(id || ''))
  if (!match) return null
  return {
    imdb: match[1],
    season: match[2] === undefined ? null : Number(match[2]),
    episode: match[3] === undefined ? null : Number(match[3]),
  }
}

const ARABIC_INDIC = /[٠-٩۰-۹]/g
export const normDigits = text => String(text || '').replace(ARABIC_INDIC, ch => {
  const code = ch.codePointAt(0)
  const base = code >= 0x06F0 ? 0x06F0 : 0x0660
  return String(code - base)
})

// Every explicit season+episode marker in the text, normalised. An "x" between the two numbers is only
// trusted when the episode looks like one (an episode number never reaches 500 in practice), so that
// "1920x1080" cannot pass for season 19 episode 1080.
const PATTERNS = [
  /s0*(\d{1,3})[\s._-]*e0*(\d{1,4})/gi,
  /season[\s._-]*0*(\d{1,3})[\s._-]*(?:episode|ep|e)[\s._-]*0*(\d{1,4})/gi,
  /الموسم[\s._-]*0*(\d{1,3})[^\d]{0,24}(?:الحلقة|حلقه|حلقة)[\s._-]*0*(\d{1,4})/g,
]
const X_PATTERN = /(\d{1,2})x(\d{1,3})(?!\d)/gi

export const markersIn = text => {
  const plain = normDigits(String(text || '').toLowerCase())
  const out = []
  for (const re of PATTERNS) {
    re.lastIndex = 0
    for (let match; (match = re.exec(plain));) {
      const season = Number(match[1]), episode = Number(match[2])
      if (season >= 1 && season <= 99 && episode >= 1 && episode <= 9999) out.push({ season, episode })
    }
  }
  X_PATTERN.lastIndex = 0
  for (let match; (match = X_PATTERN.exec(plain));) {
    const season = Number(match[1]), episode = Number(match[2])
    if (season >= 1 && season <= 99 && episode >= 1 && episode <= 500) out.push({ season, episode })
  }
  return out
}

// "same" when an explicit marker says so, "wrong" when every explicit marker disagrees, "unknown" otherwise.
export const verdictFor = (text, expected) => {
  if (!expected || expected.season == null) return 'unknown'
  const plain = normDigits(String(text || '').toLowerCase())
  const markers = markersIn(plain)
  const same = marker => marker.season === expected.season && marker.episode === expected.episode
  if (markers.some(same)) return 'same'
  // A range continuation ("S03E10-E12") carries this episode inside the same season: positive evidence only
  const rangeRe = new RegExp(`-e0*${expected.episode}(?!\\d)`, 'i')
  if (rangeRe.test(plain)) {
    const otherSeasons = markers.filter(marker => marker.season !== expected.season)
    if (otherSeasons.length === 0) return 'same'
  }
  return markers.length ? 'wrong' : 'unknown'
}

// Lower-case, strip diacritics and punctuation, squash spaces — then compare by containment.
const normalizeTitle = text => {
  const plain = String(text || '').toLowerCase()
    .normalize('NFKD').replace(/\p{Diacritic}/gu, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
  return normDigits(plain).replace(/\s+/g, ' ').trim()
}
export const normalizeName = name => normalizeTitle(name)

// Verdict for a release/file name: the markers, plus the episode's own name as a positive witness
export const byName = (text, expected, episodeName = '') => {
  const verdict = verdictFor(text, expected)
  if (verdict !== 'unknown') return verdict
  if (episodeName && episodeName.length >= 8 && normalizeTitle(text).includes(episodeName)) return 'same'
  return 'unknown'
}

// Verdict from inside the file: the lines dictate it, not the release. Only explicit markers count —
// an "episode N" with no season is allowed to agree but never to convict.
export const embeddedVerdict = (cues, expected) => verdictFor(cues.map(cue => cue.text).join('\n'), expected)

// The first lines of a subtitle are where a fansub names itself; forty cues is plenty and cheap
export const openingCues = (cues, count = 40) => cues.slice(0, count)
