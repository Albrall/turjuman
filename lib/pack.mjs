// Episode packs: one subtitle file carrying several episodes at once ("S01E01-E13", "1-13", "Batch", …).
//
// Two shapes exist in the wild, and both used to slip through the old guard:
//   1. the clock RESTARTS at 00:00 at the start of every episode. parseSubtitle used to sort cues by time, which
//      stacked all 13 episodes on top of each other inside one 24-minute window; the viewer saw episode 1's lines
//      no matter which episode was playing. Sorting also destroyed the very boundary we need to detect.
//   2. the clock CONTINUES across episodes (a 5-hour file). The old span guard caught it and threw it away.
//
// This module reads cues in FILE ORDER, finds the boundaries, keeps only the requested episode and re-bases its
// timestamps to zero. It is deliberately conservative: when a file looks like a pack but its boundaries cannot be
// established with confidence, it says so instead of serving a guessed (wrong) episode. Every path — ready Arabic,
// AI translation, comparison, and the list — calls the same selectEpisode, so there is no second way in.

import { normDigits, packRange, parseVideoId, verdictFor } from './episode.mjs'

export const PACK_MIN_CUES = 150
const RESET_DROP_S = 240       // a cue 4+ minutes BEFORE the running maximum ⇒ the clock restarted
const MIN_PART_S = 420         // …but only after at least 7 minutes of plausible episode
const MIN_PART_CUES = 20
const GAP_S = 300              // a 5-minute silence between two continuous episodes
const MIN_EPISODE_S = 8 * 60
const MAX_EPISODE_S = 60 * 60
const MAX_CUES = 8000
const MAX_PARTS = 60

const bounds = cues => {
  let first = Infinity, last = -Infinity
  for (const cue of cues) {
    if (cue.start < first) first = cue.start
    if (cue.end > last) last = cue.end
  }
  return { first, last, minutes: (last - first) / 60 }
}

const minStart = part => {
  let first = Infinity
  for (const cue of part) if (cue.start < first) first = cue.start
  return Number.isFinite(first) ? first : 0
}

// Re-base one episode to its own zero and return cues sorted by time (safe: inside one part the clock is monotonic).
const normalize = (part, base) => {
  const out = []
  for (const cue of part) {
    const start = Math.max(0, cue.start - base)
    const end = Math.max(0, cue.end - base)
    if (end > start) out.push({ start, end, text: cue.text })
  }
  return out.sort((a, b) => a.start - b.start).slice(0, MAX_CUES)
}

const splitByResets = cues => {
  const parts = []
  let start = 0
  let maxEnd = cues[0].end
  for (let i = 1; i < cues.length; i++) {
    const cue = cues[i]
    if (cue.start < maxEnd - RESET_DROP_S && maxEnd - cues[start].start >= MIN_PART_S && i - start >= MIN_PART_CUES) {
      parts.push(cues.slice(start, i))
      start = i
      maxEnd = cue.end
    } else if (cue.end > maxEnd) maxEnd = cue.end
  }
  parts.push(cues.slice(start))
  return parts
}

const splitByGaps = cues => {
  const parts = []
  let start = 0
  for (let i = 1; i < cues.length; i++) {
    if (cues[i].start - cues[i - 1].end > GAP_S && i - start >= MIN_PART_CUES) {
      parts.push(cues.slice(start, i))
      start = i
    }
  }
  parts.push(cues.slice(start))
  return parts
}

// A fansub sometimes writes "Episode 4" / "第4話" / "الحلقة ٤" at the head of each episode. Only cues far enough
// apart (a whole episode of lines) count as boundaries, so a character saying "episode 3" cannot split the file.
const LABEL_PATTERNS = [
  /\bs0*(\d{1,2})[\s._-]*e0*(\d{1,3})\b/i,
  /第\s*0*(\d{1,3})\s*[話话集]/,
  /(?:الحلقة|حلقه)\s*0*(\d{1,3})/,
  /\b(?:episode|ep)\.?\s*0*(\d{1,3})\b/i,
]
export const episodeLabel = text => {
  const plain = normDigits(String(text || '')).slice(0, 200)
  for (const pattern of LABEL_PATTERNS) {
    pattern.lastIndex = 0
    const match = pattern.exec(plain)
    if (match) {
      const value = Number(match[match.length - 1])
      if (value >= 1 && value <= 999) return value
    }
  }
  return null
}

const labelBoundaries = cues => {
  const found = []
  let lastAt = -MIN_PART_CUES, lastEpisode = 0
  for (let i = 0; i < cues.length; i++) {
    const episode = episodeLabel(cues[i].text)
    if (episode === null || i - lastAt < MIN_PART_CUES) continue
    if (episode < lastEpisode) break            // numbering went backwards: not a reliable header sequence
    if (episode === lastEpisode) continue       // the same episode announced twice
    found.push({ at: i, episode })
    lastAt = i
    lastEpisode = episode
  }
  return found
}

const partsFromLabels = (cues, boundaries) => boundaries.map((boundary, i) => ({
  episode: boundary.episode,
  cues: cues.slice(boundary.at, boundaries[i + 1]?.at ?? cues.length),
}))

// Last resort for a continuous pack: the release says E01-E13, so divide the timeline into N equal episodes, but
// only when the resulting episode length is plausible (8–60 minutes). A 2-hour film is never divided.
const divideByRange = (cues, range, episode) => {
  const count = range.to - range.from + 1
  const index = episode - range.from
  if (count < 2 || count > MAX_PARTS || index < 0 || index >= count) return null
  const { first, last } = bounds(cues)
  const per = (last - first) / count
  if (per < MIN_EPISODE_S || per > MAX_EPISODE_S) return null
  const from = first + index * per
  const part = cues.filter(cue => cue.start >= from - 1 && cue.start < from + per - 1)
  if (part.length < MIN_PART_CUES) return null
  return {
    pack: true, ok: true, cues: normalize(part, from), episode, parts: count,
    from: range.from, method: 'division', confidence: 'medium',
  }
}

const partResult = (part, extra) => {
  const cues = normalize(part, minStart(part))
  if (cues.length < MIN_PART_CUES) return null
  return { pack: true, ok: true, cues, ...extra }
}

/**
 * @param cues  cues in FILE ORDER — parseSubtitle(raw, { ordered: true })
 * @returns { pack:false, cues } for an ordinary single file, or
 *          { pack:true, ok:true, cues, episode, parts, method, confidence } for a split pack, or
 *          { pack:true, ok:false, reason } when a pack cannot be served safely.
 */
export const selectEpisode = (cues, { id = '', name = '', enabled = true } = {}) => {
  const list = Array.isArray(cues) ? cues : []
  if (!list.length) return { pack: false, cues: [] }
  const expected = parseVideoId(id)
  const hasSeason = Boolean(expected && expected.season != null)
  const range = packRange(name)
  const usableRange = range && (!hasSeason || range.season == null || range.season === expected.season) ? range : null

  const resetParts = splitByResets(list)
  const resetPack = resetParts.length > 1 && list.length >= PACK_MIN_CUES
  const measured = bounds(list)
  const labels = labelBoundaries(list)
  const evidence = Boolean(usableRange) || labels.length >= 2
  const suspicious = list.length >= PACK_MIN_CUES && measured.minutes > 50
  const continuousPack = !resetPack && suspicious && (evidence || measured.minutes > 90)
  if (!resetPack && !continuousPack) return { pack: false, cues: list }
  // A long film (no season in the id) with no explicit episode evidence is NOT a pack — the old guard threw these
  // away. Six hours is the ceiling: beyond that no single film/episode file is plausible, so refuse rather than guess.
  if (!hasSeason && !resetPack && !evidence && measured.minutes <= 360) return { pack: false, cues: list }

  if (!enabled) return { pack: true, ok: false, reason: 'disabled', parts: resetPack ? resetParts.length : 0 }
  if (!hasSeason) return { pack: true, ok: false, reason: 'movie' }
  const episode = expected.episode

  if (resetPack) {
    const from = usableRange?.from ?? 1
    let index = episode - from
    // Fansub headers inside the file are a stronger witness than the release name.
    const witness = resetParts.findIndex(part => verdictFor(part.slice(0, 40).map(cue => cue.text).join('\n'), expected) === 'same')
    if (witness >= 0) index = witness
    if (index < 0 || index >= resetParts.length) return { pack: true, ok: false, reason: 'out-of-range', parts: resetParts.length, episode }
    const result = partResult(resetParts[index], { episode, parts: resetParts.length, from, method: 'reset', confidence: 'high' })
    return result || { pack: true, ok: false, reason: 'out-of-range', parts: resetParts.length, episode }
  }

  if (labels.length >= 2) {
    const parts = partsFromLabels(list, labels)
    const found = parts.find(part => part.episode === episode)
    if (found) {
      const result = partResult(found.cues, { episode, parts: parts.length, method: 'labels', confidence: 'high' })
      if (result) return result
    }
  }
  const gapParts = splitByGaps(list)
  if (!usableRange && gapParts.length > 1 && episode >= 1 && episode <= gapParts.length) {
    const result = partResult(gapParts[episode - 1], { episode, parts: gapParts.length, method: 'gaps', confidence: 'medium' })
    if (result) return result
  }
  if (usableRange) {
    const divided = divideByRange(list, usableRange, episode)
    if (divided) return divided
  }
  return { pack: true, ok: false, reason: 'unresolved', parts: 0, episode }
}

export const packNotice = result => {
  switch (result?.reason) {
    case 'disabled':
      return '⚠️ ترجمان: فصل حزم الحلقات متوقف في الإعدادات. هذا الملف يجمع عدة حلقات، فلم يُعرض شيء بدل ترجمة حلقة خاطئة. شغّل الخيار أو اختر ترجمة مستقلة لكل حلقة.'
    case 'movie':
      return '⚠️ ترجمان: هذا الملف يجمع عدة حلقات، ولا يمكن اختيار حلقة منه لفيلم. اختر ترجمة مستقلة.'
    case 'out-of-range':
      return `⚠️ ترجمان: الحزمة تحتوي ${result.parts || 'عدة'} حلقات ولا تتضمن الحلقة المطلوبة ${result.episode}. اختر ترجمة أخرى.`
    default:
      return '⚠️ ترجمان: تعذّر تحديد حدود الحلقة المطلوبة داخل حزمة الحلقات؛ لم يُعرض شيء بدل ترجمة حلقة خاطئة. جرّب ترجمة مستقلة لكل حلقة.'
  }
}
