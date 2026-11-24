// Subtitle text in and out: read SRT or WebVTT, tidy the lines, write WebVTT.
//
// On Cloudflare's free plan a request has about 10 ms of CPU, and a film has some 1,500 cues. So this file is written
// for speed: a regular expression only runs on text that a plain search says could match, and little is allocated per line.

const TIMING = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/
const DIGITS = /^\d+$/
const BLOCK = /^(NOTE|STYLE|REGION)\b/

// ── ASS/SSA (فكرة المصادر، 25) ──
// ملفات الفانساب عادةً ASS: سطور Dialogue بين [Events]، والأوقات بصيغة h:mm:ss.cc
const ASS_TIME = /^\s*(\d{1,2}):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/
const parseAssTime = value => {
  const m = ASS_TIME.exec(String(value))
  if (!m) return null
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / (m[4].length === 2 ? 100 : 1000)
}
export const parseAss = raw => {
  const cues = []
  let inEvents = false, format = []
  for (const rawLine of String(raw).split('\n')) {
    const line = rawLine.trim()
    if (/^\[events\]/i.test(line)) { inEvents = true; format = []; continue }
    if (/^\[/.test(line)) { inEvents = false; continue }
    if (!inEvents) continue
    if (/^format\s*:/i.test(line)) { format = line.slice(line.indexOf(':') + 1).split(',').map(s => s.trim().toLowerCase()); continue }
    if (!/^dialogue\s*:/i.test(line)) continue
    const rest = line.slice(line.indexOf(':') + 1)
    // النص يحمل فواصل عادة: نقسم كح عدد الحقول المعلنة فقط
    const fieldCount = Math.max(format.length, 10)
    const fields = []
    let at = 0
    for (let i = 0; i < fieldCount - 1; i++) {
      const comma = rest.indexOf(',', at)
      if (comma < 0) break
      fields.push(rest.slice(at, comma))
      at = comma + 1
    }
    fields.push(rest.slice(at))
    const get = name => { const idx = format.indexOf(name); return idx >= 0 ? (fields[idx] ?? '') : '' }
    const start = parseAssTime(get('start')), end = parseAssTime(get('end'))
    if (start === null || end === null || end <= start) continue
    if (/^(sign|signs|title|credit|note)$/i.test(String(get('style')).trim())) continue   // إشارات و títulos، لا حوار
    const text = get('text')
      .replace(/\\h/g, ' ')
      .replace(/\{\\[^}]*\}/g, '')
      .replace(/\\N/gi, '\n')
      .replace(/\\,/g, ',')
      .trim()
    if (text) cues.push({ start, end, text })
  }
  return cues.sort((a, b) => a.start - b.start)
}

// The timestamp whose parts start at group `at` of a TIMING match, in seconds
const seconds = (match, at) => {
  const fraction = match[at + 3]
  return (match[at] ? Number(match[at]) * 3600 : 0) + Number(match[at + 1]) * 60 + Number(match[at + 2])
    + Number(fraction) / (fraction.length === 3 ? 1000 : fraction.length === 2 ? 100 : 10)
}

const isBlank = line => {
  if (line.length === 0) return true
  const first = line.charCodeAt(0)
  return (first <= 32 || first === 0xA0 || first === 0x3000 || first === 0xFEFF) && line.trim() === ''
}

// Reads line by line rather than block by block, so files with a missing blank line, or a blank line inside a cue, still come out whole
export const parseSubtitle = raw => {
  let text = String(raw)
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  if (/\[events\]/i.test(text) && /^\s*dialogue\s*:/im.test(text)) return parseAss(text)
  if (text.includes('\r')) text = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n')
  const lines = text.split('\n')
  const blank = i => i < 0 || isBlank(lines[i])

  const cues = []
  let body = null        // the lines of the cue being read, or null between cues
  let start = 0, end = 0
  let skipping = false   // inside a WebVTT NOTE, STYLE or REGION block
  const close = () => {
    if (body === null) return
    let joined = ''
    for (const line of body) {
      const trimmed = line.trim()
      if (trimmed) joined = joined ? `${joined}\n${trimmed}` : trimmed
    }
    if (joined && end > start) cues.push({ start, end, text: joined })
    body = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const timing = line.includes('-->') ? TIMING.exec(line) : null
    if (timing) {
      // The line right above the timing is the cue's counter or name, which was read as text of the cue before
      if (body !== null && !blank(i - 1) && (blank(i - 2) || DIGITS.test(lines[i - 1].trim()))) body.pop()
      close()
      skipping = false
      start = seconds(timing, 1)
      end = seconds(timing, 5)
      body = []
    } else if (isBlank(line)) {
      skipping = false
    } else if (blank(i - 1) && line.charCodeAt(0) >= 78 && line.charCodeAt(0) <= 83 && BLOCK.test(line)) {
      close()
      skipping = true
    } else if (body !== null && !skipping) {
      body.push(line)
    }
  }
  close()
  return cues.sort((a, b) => a.start - b.start)
}

// A line that carries a music note: likely the opening or ending theme it sits inside. Idea 5 uses runs of these.
const NOTE = /[\u266A\u266B\u266C]/
export const isSongCue = text => NOTE.test(String(text))

const AD = /(www\.[a-z0-9-]+\.[a-z]{2,}|https?:\/\/|opensubtitles|osdb\.link|subtitles? by |subtitles downloaded|sync(?:ed|hronized)?,? (?:and|&) correct|advertise your product|become a? ?vip|rate this subtitle)/i

const STYLE_CODE = /\{\\[^}]*\}/g                       // {\an8} and other ASS codes
const TAG = /<\/?([a-zA-Z][\w.]*)[^>]*>/g
const BASIC_TAG = /^[ibu]$/i
const TAG_ATTRIBUTES = /\s[^>]*(?=>)/
const EMPTY_TAG = /<([ibu])>\s*<\/\1>/g
const BASIC_MARKUP = /<\/?[ibu]>/g
const SPACES = /[ \t]+/g
const SIGNS_ONLY = /^[\s♪♫#*~-]+$/
// What the hearing-impaired subtitles add: [door slams], (sighs), MARY:
const SQUARE = /\[[^\]]*\]/g
const ROUND = /\([^()]{1,60}\)/g
const SPEAKER = /^(-\s*)?[A-Z][A-Z0-9 .'#-]{1,25}:\s+/

const keepBasicTags = (tag, name) => (BASIC_TAG.test(name) ? tag.toLowerCase().replace(TAG_ATTRIBUTES, '') : '')

const tidyLine = (line, dropSounds) => {
  if (dropSounds) {
    if (line.includes('[')) line = line.replace(SQUARE, '')
    if (line.includes('(')) line = line.replace(ROUND, '')
    if (line.includes(':')) line = line.replace(SPEAKER, '$1')
  }
  if (line.includes('<')) line = line.replace(EMPTY_TAG, '')
  if (line.includes('  ') || line.includes('\t')) line = line.replace(SPACES, ' ')
  return line.trim()
}

// A line of music signs and dashes with nothing said, such as "♪♪" or "<i>- -</i>"
const signsOnly = line => {
  const first = line.charCodeAt(0)
  if (first !== 0x266A && first !== 0x266B && first !== 35 && first !== 42 && first !== 126 && first !== 45 && first !== 60) return false
  return SIGNS_ONLY.test(line.includes('<') ? line.replace(BASIC_MARKUP, '') : line)
}

export const tidy = (cues, { dropSounds = true } = {}) => {
  const kept = []
  for (const cue of cues) {
    let text = cue.text
    if (text.includes('{')) text = text.replace(STYLE_CODE, '')
    if (text.includes('<')) text = text.replace(TAG, keepBasicTags)
    if (text.includes('-->')) text = text.replaceAll('-->', '→')
    if (text.includes('\n')) {
      let joined = ''
      for (const raw of text.split('\n')) {
        const line = tidyLine(raw, dropSounds)
        if (line && !signsOnly(line)) joined = joined ? `${joined}\n${line}` : line
      }
      text = joined
    } else {
      text = tidyLine(text, dropSounds)
      if (text && signsOnly(text)) text = ''
    }
    if (text && !AD.test(text)) kept.push({ start: cue.start, end: cue.end, text })
  }
  return kept
}

const two = value => (value < 10 ? `0${value}` : `${value}`)

export const stamp = seconds => {
  const ms = Math.max(0, Math.round(seconds * 1000))
  const rest = ms % 1000
  return `${two(Math.floor(ms / 3600000))}:${two(Math.floor(ms / 60000) % 60)}:${two(Math.floor(ms / 1000) % 60)}.${rest < 10 ? `00${rest}` : rest < 100 ? `0${rest}` : rest}`
}

// Arabic lines often start with a dash, a digit or a Latin name; the mark keeps the whole line right-to-left
const RLM = '\u200F'

// cue: { start, end, text, rtl?: Arabic text, top?: shown at the top of the screen, away from the dialogue }
export const buildVtt = cues => {
  const sorted = [...cues].sort((a, b) => a.start - b.start)
  const parts = ['WEBVTT\n\n']
  for (let i = 0; i < sorted.length; i++) {
    const cue = sorted[i]
    let text = cue.text
    if (text.includes('-->')) text = text.replaceAll('-->', '→')
    let body = ''
    if (text.includes('\n')) {
      for (const raw of text.split('\n')) {
        const line = raw.trim()
        if (line) body += (body ? '\n' : '') + (cue.rtl ? RLM + line : line)
      }
    } else {
      const line = text.trim()
      if (line) body = cue.rtl ? RLM + line : line
    }
    parts.push(`${i ? '\n\n' : ''}${stamp(cue.start)} --> ${stamp(cue.end)}${cue.top ? ' line:0' : ''}\n${body}`)
  }
  return `${parts.join('')}\n`
}
