// A translation in progress, kept as a board that requests work on together.
//
// On a plain server one background task could own a translation. On Cloudflare there is no background: work only runs
// inside a request, network calls belong to the request that made them, and a request is cut off 30 seconds after its
// client leaves. Players also ask for the same subtitle more than once (Nuvio on iOS downloads it, then hands the address
// to mpv, which downloads it again).
//
// So a translation is plain data — the board — and every request that wants it becomes a helper: it claims batches from
// the board's queue, translates them with its own network calls and writes the lines back. A helper that is cut off stops
// beating; the others notice and take its batches back. No request ever awaits a promise that another request owns.

import { applySeriesNames } from './series.mjs'
import { chat, freshCaps, loosen, readMap } from './llm.mjs'
import { isSongCue } from './subs.mjs'

export const PROMPT_VERSION = 3
const MAX_ATTEMPTS = 6        // tries for a batch whose answer was wrong or missing
const MAX_REFUSALS = 12       // times a batch may be told "too many requests, come back later" on top of that
const STALE_MS = 4_000        // a helper silent for this long is taken for gone
const BRIEF_CHARS = 48_000    // how much of the subtitle the brief is made from: about 12,000 tokens
const BRIEF_ATTEMPTS = 3
const BRIEF_PATIENCE = 25_000 // how long the batches wait for the brief before they go without it
const BRIEF_PARTS = 4         // pieces the subtitle is read in for the brief, when the provider turns it down as a whole
const SPLIT = 5               // pieces a batch the provider turned down is cut into. Every request that holds the line is turned down
                              // again, and a provider counts those: five ways, a batch of 80 gets to the line in three more
const PROBES = 6              // lines asked for alone, from all over the subtitle, to tell a provider that objects to some lines from one that refuses the video

// A name that is also an ordinary word is where a translator shows whether it follows the story. Both prompts say the
// same thing about it, with the same examples.
//
// The other way round goes wrong as easily: someone called by what they are. In anime subtitles the old master is
// "Old-timer" from the first episode to the last, and a rule that takes every word people are called by for a name
// makes "أولد تايمر" of him. And the people of a known work already have Arabic names, which a spelling by sound misses.
const NAMES_RULE = `A proper name is written by its SOUND in Arabic letters; its meaning is never translated. A woman called Hope is "هوب", never "أمل"; Mr. Stone is "السيد ستون", never "السيد حجر". Where a place has an established Arabic name, use it (London → لندن, Egypt → مصر).
A capitalised word in the middle of a sentence is a name even when it is also an ordinary word (Hope, Grace, Hunter, Summer, Will, Mark, Rose).
At the start of a sentence the capital letter proves nothing, so read the sentence: "Hope, wait for me" speaks to the woman, while "Hope is all we have left" is about the feeling and is translated as "الأمل".
A word that only says what someone is — their age, rank, work, kinship or looks — is not a name, with or without a capital letter and even when they are spoken to by it: old-timer, old man, kid, boss, captain, master, teacher, big brother, granny. Translate it: "Who are you, Old-timer?" → "من أنت أيها العجوز؟". Before a name it is a title: the title is translated and the name is written by sound (Master Roshi → المعلم روشي). A nickname that someone goes by in the story is a name all the same (Red, Baby).
The characters of a known film, series or anime are written the way Arabic-speaking viewers know them (Goku → غوكو, Piccolo → بيكولو, Vegeta → فيجيتا). In Japanese names a hard g is غ, ch is تش, ts is تس, and a long vowel is written once (Ichigo → إيتشيغو, Yuuki → يوكي).
A Japanese honorific after a name is kept, in Arabic letters, wherever the line has it: -san is سان, -kun is كن, -chan is تشان, -sama is ساما, -sensei is سينسي, -senpai is سينباي (Kakashi-sensei → كاكاشي سينسي).`

export const systemPrompt = ({ from, about }) => `You are a professional subtitle translator working from ${from} into Arabic.

You receive JSON with:
- "lines": the subtitle lines to translate, keyed by id.
- "context_before" and "context_after": neighbouring lines, only to help you follow the conversation. Never translate or return them.
- "names" (when present): the proper names that occur here, each with the Arabic spelling to use and what it is (man, woman, place, group).
- "terms" (when present): special words of this story, each with the Arabic wording to use every time.

Return ONLY a JSON object that has exactly the same ids as "lines"; each value is the Arabic translation of that line. No extra keys, no notes, no Markdown.

How to translate:
- One translation per id. Never merge, split, drop or reorder lines. When a sentence runs across several ids, translate each part so that the parts read naturally one after the other.
- Write natural Modern Standard Arabic, in the register of professional film subtitles: short, clear, easy to read at a glance. Translate the meaning, not word for word; give idioms, slang and jokes a natural Arabic equivalent.
- Follow the conversation: who is speaking, to whom, and about what. Take gender and number from the context. Keep the speaker's tone.
- Keep digits as digits.
- Keep <i>, <b> and <u> tags around the matching words. Keep a line break ("\\n") where the line has one, and a leading "- " that marks a change of speaker. Keep ♪ signs.
- A line with nothing to translate (a symbol, a number) is returned as it is.

Names:
- ${NAMES_RULE.replaceAll('\n', '\n- ')}
- Spell the names listed in "names" letter for letter as given there, and use what it says about a person (man or woman) for the gender of verbs, pronouns and adjectives, also when that person is being spoken to.
- "names" says how a word is written when it is used as a name. Where the same word is used as an ordinary word, translate it as usual.
- Word the entries of "terms" as given there.

What you are translating: ${about || 'a film or a series episode'}.`

// Read once per title, before the first line is translated: who is who, how each name is written, which words recur.
// Batches are translated side by side and each sees only its own lines, so this is what keeps a name the same from
// the first scene to the last.
// The show's known characters and their gender, and the Arabic spellings already chosen for this work, if any.
// Every episode of the show gets its brief with the same list, so a name is written one way for good.
const seriesSection = ({ series }) => {
  if (!series?.length) return ''
  const stored = series.filter(entry => entry.arabic)
  const lines = series.map(entry => `- ${entry.name}${entry.native ? ` (${entry.native})` : ''} — ${entry.kind}${entry.arabic ? ` → ${entry.arabic}` : ''}`)
  return `
The characters of this work, known from its database, with their gender. Write "name" exactly as shown below, and set "kind" from it:
${lines.join('\n')}${stored.length ? `
These have a spelling already chosen for this work; use it exactly as it is, every time it occurs:
${stored.map(entry => `- ${entry.name} → ${entry.arabic}`).join('\n')}` : ''}
A name of this list with no spelling yet is spelt by you — the spelling you choose is kept, and the whole work reuses it.`
}

export const briefPrompt = ({ from, about, series }, sampled) => `You are preparing a translator's brief for the Arabic subtitles of: ${about || 'a film or a series episode'}.

You receive the subtitle lines in ${from}${sampled ? ' (a sample of them; "[…]" marks what was left out)' : ''}. Read them and return ONLY a JSON object of this shape:
{"names":[{"name":"…","arabic":"…","kind":"man"}],"terms":[{"term":"…","arabic":"…"}]}

"names": the proper names that occur in the lines — people (first names, surnames, nicknames), places, organisations, ships, brands.
- "name": as written in the lines. One entry per distinct name: "Robert Fischer" and "Fischer" are two entries.
- "arabic": how to write it in Arabic. ${NAMES_RULE.replaceAll('\n', '\n  ')}
- "kind": "man", "woman", "place", "group" or "other". Use what you know about this film, series or anime, and the lines themselves (how a person is addressed, he or she), to tell men from women. "other" when unsure.
- Leave out ordinary words that are capitalised only because they start a sentence, and days, months, languages and nationalities.
- Leave out the words that only say what someone is and by which they are spoken to (old-timer, old man, kid, boss, captain, master, big brother): they are not names.
- At most 80 names, the most frequent first.${seriesSection({ series })}

"terms": up to 15 special words or phrases that recur and should be worded the same way every time: invented words, jargon, ranks, forms of address, code names whose meaning matters. "arabic" is the wording to use. Leave out ordinary vocabulary. An empty list is fine.`

// The lines the brief is made from: all of them, or evenly spaced runs when there are too many
export const briefInput = cues => {
  let total = 0
  for (const cue of cues) total += cue.text.length + 1
  const flat = cue => (cue.text.includes('\n') ? cue.text.replaceAll('\n', ' ') : cue.text)
  if (total <= BRIEF_CHARS) return { text: cues.map(flat).join('\n'), sampled: false }
  const run = 30
  const runs = Math.max(2, Math.floor(BRIEF_CHARS / ((total / cues.length) * run)))
  const step = (cues.length - run) / (runs - 1)
  const parts = []
  for (let i = 0; i < runs; i++) {
    const from = Math.round(i * step)   // the first run is the opening, where most names are introduced
    parts.push(cues.slice(from, from + run).map(flat).join('\n'))
  }
  return { text: parts.join('\n[…]\n'), sampled: true }
}

const KINDS = ['man', 'woman', 'place', 'group']

// The model is asked for two lists of small flat objects. They are picked out one by one, so that a reply wrapped in
// prose, or cut off before its end, still gives what it holds.
export const readBrief = text => {
  const clean = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, 80) : '')
  const names = [], terms = [], seen = new Set()
  for (const [chunk] of String(text).matchAll(/\{[^{}]*\}/g)) {
    let item
    try { item = JSON.parse(chunk) } catch { continue }
    const source = clean(item.name ?? item.term), arabic = clean(item.arabic)
    if (!source || !/[\u0600-\u06FF]/.test(arabic) || seen.has(source.toLowerCase())) continue
    seen.add(source.toLowerCase())
    if (item.name !== undefined) {
      if (names.length < 120) names.push({ name: source, arabic, kind: KINDS.includes(item.kind) ? item.kind : 'other' })
    } else if (terms.length < 30) {
      terms.push({ term: source, arabic })
    }
  }
  return { names, terms }
}

// ── fansub-style notes (idea 27) ──
// The model is asked for at most three things worth understanding. The reply may be wrapped in prose or cut off,
// or offer ten notes; what survives is at most three whole notes.
export const readNotes = text => {
  const notes = []
  const start = String(text).search(/\[/)
  if (start < 0) return notes
  const end = String(text).lastIndexOf(']')
  if (end <= start) return notes
  let parsed
  try { parsed = JSON.parse(String(text).slice(start, end + 1)) } catch { return notes }
  if (!Array.isArray(parsed)) return notes
  const clean = value => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '')
  for (const item of parsed) {
    const find = clean(item?.find), note = clean(item?.note)
    if (find && note && notes.length < 3) notes.push({ find: find.slice(0, 120), note: note.slice(0, 80) })
  }
  return notes
}

export const notesPrompt = () => `You are a translator's editor for an Arabic fansub of an anime episode.
The translation into Arabic is done. Some moments in it will not land with an Arabic-speaking viewer: a joke that only works in the source language, a Japanese word kept in Arabic letters, a line that plays on something the anime audience knows.
Pick at most three of those moments — no more. For each, one short note of at most twelve Arabic words, natural for this show.
Return ONLY a JSON array: [{"find": "…", "note": "…"}]
- "find": a phrase copied exactly from the Arabic translation of that one line (the first six to ten words of it). It is used to position the note, so it must occur in the text.
- An empty array is fine. Prefer silence to a forced note.`

// Where a note goes on screen: the first translated cue whose text contains its "find" phrase,
// after both sides are searched the same way (no diacritics, no kashida, no direction marks, one case).
const normalize = text => String(text)
  .replace(/[\u064B-\u065F\u0670\u0640\u200F\u200E]/g, '')
  .toLowerCase().replace(/\s+/g, ' ').trim()
export const anchorNotes = (notes, cues, out) => {
  const found = []
  for (const note of notes) {
    const needle = normalize(note.find).split(' ').slice(0, 8).join(' ')
    if (needle.length < 4) continue
    for (let i = 0; i < cues.length; i++) {
      const text = out[i]
      if (typeof text === 'string' && normalize(text).includes(needle)) {
        const start = cues[i].start
        found.push({ start, end: Math.min(start + 5, cues[i].end + 4), text: `ملاحظة المترجم: ${note.note}` })
        break
      }
    }
    if (found.length >= 3) break
  }
  return found
}

const LETTER = /\p{L}/u
// Whether the word or phrase occurs in the text as a whole word. Both are lower case already.
const occurs = (text, phrase) => {
  for (let at = text.indexOf(phrase); at >= 0; at = text.indexOf(phrase, at + 1)) {
    const before = text[at - 1], after = text[at + phrase.length]
    if (!(before && LETTER.test(before)) && !(after && LETTER.test(after))) return true
  }
  return false
}

// indexes: positions in the cue list still waiting for a translation
export const makeBatches = (cues, indexes, size) => {
  const batches = []
  let batch = [], weight = 0
  for (const index of indexes) {
    const length = cues[index].text.length
    if (batch.length && (batch.length >= size || weight + length > size * 100)) {
      batches.push(batch)
      batch = []
      weight = 0
    }
    batch.push(index)
    weight += length
  }
  if (batch.length) batches.push(batch)
  return batches
}

export const cacheKey = async parts => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)))
  let hex = ''
  for (const byte of new Uint8Array(digest, 0, 16)) hex += byte.toString(16).padStart(2, '0')
  return hex
}

let sequence = 0

const fill = (board, batchSize) => {
  const waiting = []
  for (let i = 0; i < board.cues.length; i++) if (board.out[i] === undefined) waiting.push(i)
  board.queue = makeBatches(board.cues, waiting, batchSize).map(lines => ({ lines, attempt: 1, refused: 0, notBefore: 0 }))
  if (board.brief === undefined && board.queue.length) board.queue.unshift({ brief: true, attempt: 1, refused: 0, notBefore: 0 })
}

// cues: [{ start, end, text }] · out: the translations so far, when a translation is picked up again · from/about: for the prompts
// wantBrief: read the whole subtitle once, before the first batch, for its names and terms · brief: the one made earlier
// seriesNames: the show's dictionary — names with gender and, when known, the Arabic spelling chosen for this work
// learnNames: told about the Arabic spellings this brief chose for the dictionary, to keep them for good
export const createBoard = ({ key, cues, out, from, about, batchSize, wantBrief = false, brief, asWritten, seriesNames, learnNames, wantNotes = false }) => {
  const board = {
    key, cues, from, about,
    brief: brief ?? (wantBrief ? undefined : null),   // undefined: still to be made · null: none wanted · { names, terms }
    briefSince: 0,          // when the brief was first asked for
    out: out ?? new Array(cues.length),
    translated: 0, requests: 0,
    state: 'running', error: '', lastError: '', fatal: false,
    queue: [],              // batches waiting: { lines, attempt, notBefore }
    claims: new Map(),      // batches being translated: claim id → { helper, task }
    helpers: new Map(),     // helper id → the time of its last beat
    caps: null, shape: 0,   // the optional request fields the provider accepts, and how many times that list changed
    pauseUntil: 0,          // the provider asked everyone to wait until then
    accepted: 0,            // batches the provider answered: what shows that it takes this video at all
    refusals: 0,            // requests it turned down for what they say
    unproven: new Set(),    // lines it turned down when asked for them alone, while it has not answered anything yet
    probe: null,            // { left: the lines asked for alone to find out whether it answers at all, and not back yet }
    asWritten: new Set(),   // lines it turned down, left as they were written
    briefDraft: null,       // the brief while its pieces come in: { names, terms, seen, open }
    tokens: { p: 0, c: 0 }, // what the provider says was spent (input and output), added up
    notes: [],              // ≤3 fansub-style notes shown over the top of the screen (idea 27)
    wantNotes: Boolean(wantNotes),
    notesDraft: null,
    series: seriesNames?.length ? seriesNames : null,   // the show's dictionary (idea 14), or null for a film or an unknown show
    learned: [],            // spellings this brief chose, to hand back to the store
    learnNames: typeof learnNames === 'function' ? learnNames : null,
    startedAt: Date.now(), finishedAt: 0,
  }
  // Runs of three or more cues carrying a music note are a theme (opening or ending): every episode repeats them, so they
  // are left as they were written and never sent to the model (idea 5). Resumes skip what is already defined.
  {
    let run = []
    const flush = () => {
      if (run.length >= 3) for (const index of run) if (board.out[index] === undefined) { board.out[index] = board.cues[index].text; board.asWritten.add(index); board.song = (board.song || 0) + 1 }
      run = []
    }
    for (let i = 0; i <= cues.length; i++) {
      if (i < cues.length && isSongCue(cues[i].text)) run.push(i)
      else flush()
    }
  }
  for (let i = 0; i < cues.length; i++) if (board.out[i] !== undefined) board.translated++
  for (const index of asWritten ?? []) if (Number.isInteger(index) && board.out[index] !== undefined) board.asWritten.add(index)
  fill(board, batchSize)
  return board
}

// Picks a stopped translation up again from the lines it still misses
export const resumeBoard = (board, batchSize) => {
  if (board.state !== 'failed') return board
  Object.assign(board, { state: 'running', error: '', lastError: '', fatal: false, caps: null, shape: 0, pauseUntil: 0, finishedAt: 0, briefSince: 0, refusals: 0, briefDraft: null, probe: null })
  board.claims.clear()
  board.unproven.clear()
  fill(board, batchSize)
  return board
}

// Forgets the helpers that stopped beating, and puts the batches they held back in the queue
const reap = board => {
  const now = Date.now()
  for (const [id, beat] of board.helpers) if (now - beat > STALE_MS) board.helpers.delete(id)
  for (const [id, claim] of board.claims) {
    if (board.helpers.has(claim.helper)) continue
    board.claims.delete(id)
    board.queue.unshift(claim.task)
  }
}

// Whether some request is still working on the board
export const alive = board => {
  reap(board)
  return board.helpers.size > 0
}

const fail = (board, message, fatal = true) => {
  if (board.state !== 'running') return
  Object.assign(board, { state: 'failed', fatal, error: message, finishedAt: Date.now() })
}

// Back in the queue for another try. Past the limits the lines are left for a later request to pick up.
const again = (board, task, lines, reason, { notBefore = 0, refused = false } = {}) => {
  board.lastError = reason
  const next = { lines, attempt: task.attempt + (refused ? 0 : 1), refused: task.refused + (refused ? 1 : 0), notBefore }
  if (task.bare) next.bare = true
  if (task.probe) next.probe = true
  if (next.attempt <= MAX_ATTEMPTS && next.refused <= MAX_REFUSALS) board.queue.push(next)
}

// ───────── a provider that turns down what a request says ─────────
//
// Films say things a moderation filter objects to, and the filter does not know it is reading a film. It turns down the
// whole request, eighty lines for one. Such a batch is cut into pieces, and the piece that is turned down again into
// smaller ones, until the lines it objects to stand alone: those stay as they were written, and everything else is
// translated.
//
// One thing must hold first: that the provider translates this video at all. An account under review, or a model that is
// not open to it, turns down every request in the same words, and then there are no lines to tell apart. So when a batch
// is turned down before anything was answered, a few single lines from all over the subtitle are asked for first. One
// answer is enough to go on; if every one of them is turned down, it is the video that is refused, not its lines.

// Whether the provider has answered anything of this video: a batch, a line asked for alone, or lines that are in
const proven = board => board.accepted > 0 || board.translated > board.asWritten.size

// How many lines may stay as written before the translation is not worth calling one. Past that the provider does not
// suit this video, and going on would only add to it: the translation stops there, also when it is picked up again.
const tooMany = board => Math.max(12, Math.ceil(board.cues.length * 0.08))
const unfit = board => {
  if (board.asWritten.size <= tooMany(board)) return false
  fail(board, `رفض المزود ترجمة ${board.asWritten.size} سطرًا من هذا الفيديو، وهذا أكثر مما يُترك بلغته. جرّب نموذجًا أو مزودًا آخر`)
  return true
}

// The lines turned down alone are left as written — once the provider has shown that it answers for this video.
// Until then they are only remembered: nothing is written on the board, so nothing of it can be saved as translated.
const settle = board => {
  if (board.state !== 'running' || !proven(board)) return
  // the question the single lines were to answer is answered
  if (board.probe && board.queue.some(task => task.probe)) board.queue = board.queue.filter(task => !task.probe)
  if (!board.unproven.size) return
  for (const index of board.unproven) {
    if (board.out[index] !== undefined) continue
    board.out[index] = board.cues[index].text
    board.translated++
    board.asWritten.add(index)
  }
  board.unproven.clear()
  unfit(board)
}

// Nothing was answered: the provider refuses the video as a whole, and nothing is concluded about any line
const turnAway = board => {
  board.unproven.clear()
  fail(board, `رفض المزود كل ما أُرسل إليه، فجرّب نموذجًا أو مزودًا آخر — ${board.lastError}`)
}

// A few lines from all over the subtitle, each to be asked for alone. What comes back for them is not kept: a line is
// better translated among its neighbours, which is how the batches will ask for it.
const sendProbes = board => {
  const waiting = []
  for (let i = 0; i < board.cues.length; i++) if (board.out[i] === undefined && !board.unproven.has(i)) waiting.push(i)
  const count = Math.min(PROBES, waiting.length)
  const picked = Array.from({ length: count }, (_, k) => waiting[Math.floor(((k + 0.5) * waiting.length) / count)])
  board.probe = { left: new Set(picked) }
  board.queue.unshift(...picked.map(index => ({ lines: [index], attempt: 1, refused: 0, notBefore: 0, bare: true, probe: true })))
}

// lines: the lines of the request that was turned down
const turnedDown = (board, task, lines, message) => {
  board.refusals++
  board.lastError = message
  // The pieces go without their neighbours' lines (bare), so that the answer is about these lines and nothing else
  const piece = part => ({ lines: part, attempt: 1, refused: 0, notBefore: 0, bare: true })
  if (lines.length > 1) {
    const size = Math.ceil(lines.length / SPLIT)
    const pieces = []
    for (let at = 0; at < lines.length; at += size) pieces.push(piece(lines.slice(at, at + size)))
    board.queue.unshift(...pieces)
  } else if (!task.bare) {
    board.queue.unshift(piece(lines))   // it may have been a neighbour's line that was objected to: once more, alone
  } else {
    board.unproven.add(lines[0])
    if (board.probe?.left.delete(lines[0]) && !board.probe.left.size && !proven(board)) return turnAway(board)
    settle(board)
  }
  if (!board.probe && !proven(board)) sendProbes(board)
}

// Arabic as it is compared: without vowel marks, with the forms of alef, ya and ta marbuta made one
const plainArabic = text => text.replace(/[\u064B-\u065F\u0670\u0640]/g, '').replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')

// Whether the name stands in the line where only a name can stand: capitalised in mid-sentence, or called out at the end
// ("Wait for me, Hope!"). At the start of a sentence nothing can be said, and nothing is.
export const surelyName = (line, name) => {
  for (let at = line.indexOf(name); at >= 0; at = line.indexOf(name, at + 1)) {
    const before = line[at - 1], after = line[at + name.length]
    if ((before && LETTER.test(before)) || (after && LETTER.test(after))) continue
    // what comes before it in its sentence, without tags, quotes and the dash of a new speaker
    const lead = line.slice(0, at).replace(/<\/?[ibu]>/g, '').replace(/[ \t"'“‘(-]+$/, '')
    if (lead && !/[.!?…:\n]$/.test(lead)) return true
  }
  return false
}

// The names of the brief that the Arabic line should show and does not. names: the entries given to the model with these lines.
export const misnamed = (source, arabic, names) => {
  if (!names.length) return false
  const plain = plainArabic(arabic)
  return names.some(entry => /^\p{Lu}/u.test(entry.name) && surelyName(source, entry.name) && !plain.includes(plainArabic(entry.arabic.split(' ').at(-1))))
}

const hasArabic = text => /[\u0600-\u06FF]/.test(text)
// Whether the line has words to translate: letters of any script but Arabic, tags aside
const hasWords = text => (text.replace(/<[^>]*>/g, '').match(/(?![\u0600-\u06FF])\p{L}/gu)?.length ?? 0) >= 3

// Returns the model's answers by id, and the names it was given with these lines.
// bare: these lines only, without the neighbouring lines that help to follow the conversation
const ask = async (board, indexes, llm, signal, attempt, bare = false) => {
  const { cues } = board
  const first = indexes[0], last = indexes.at(-1)
  let names = []
  // A line the provider turned down is kept out of the other requests: it would get them turned down as well
  const around = (from, to) => {
    const lines = []
    if (!bare) for (let i = Math.max(0, from); i < Math.min(to, cues.length); i++) if (!board.asWritten.has(i) && !board.unproven.has(i)) lines.push(cues[i].text)
    return lines
  }
  const request = {
    context_before: around(first - 4, first),
    lines: Object.fromEntries(indexes.map(index => [String(index + 1), cues[index].text])),
    context_after: around(last + 1, last + 3),
  }
  if (board.brief && (board.brief.names.length || board.brief.terms.length)) {
    const here = `${request.context_before.join('\n')}\n${Object.values(request.lines).join('\n')}\n${request.context_after.join('\n')}`.toLowerCase()
    names = board.brief.names.filter(entry => occurs(here, entry.name.toLowerCase()))
    const terms = board.brief.terms.filter(entry => occurs(here, entry.term.toLowerCase()))
    if (names.length) request.names = Object.fromEntries(names.map(entry => [entry.name, entry.kind === 'other' ? { arabic: entry.arabic } : { arabic: entry.arabic, is: entry.kind }]))
    if (terms.length) request.terms = Object.fromEntries(terms.map(entry => [entry.term, entry.arabic]))
    if (names.length && attempt > 1) request.note = 'These lines are asked for again. Check each name against "names" and write it letter for letter as given there.'
  }
  board.requests++
  board.prompt ??= systemPrompt(board)
  const reply = await chat({
    baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model, effort: llm.effort, caps: board.caps, signal,
    messages: [{ role: 'system', content: board.prompt }, { role: 'user', content: JSON.stringify(request) }],
  })
  spent(board, reply.usage)
  return { answers: readMap(reply.text), names }
}

// The provider says what a request cost; we only add it up. Providers that do not say leave the totals at zero.
export const spent = (board, usage) => {
  if (!usage) return
  board.tokens.p += usage.p || 0
  board.tokens.c += usage.c || 0
}

// How long to stay away after a refusal that may pass. fast: the tests wait milliseconds where real use waits seconds.
const backOff = (board, error, attempt, fast) => {
  const seconds = error.retryAfter ? Math.min(error.retryAfter, 90) + 1 : Math.min(45, 1.5 * 2 ** attempt)
  const wait = seconds * (fast ? 1 : 1000)
  if (error.retryAfter) board.pauseUntil = Math.max(board.pauseUntil, Date.now() + wait)   // the provider said when: everyone waits
  return Date.now() + wait
}

// A provider refused a field of the request: the first request back drops it, the others (they run side by side) just go again.
// False when there is nothing left to drop.
const reshape = (board, shape, message) => {
  if (shape !== board.shape) return true
  if (!loosen(board.caps, message)) return false
  board.shape++
  return true
}

const NO_BRIEF = { names: [], terms: [] }

// One answer to the brief, or to one piece of it. The brief is ready when every piece is in.
const gather = (board, found) => {
  const draft = board.briefDraft
  if (!draft) return   // an answer that comes in after the brief was settled
  for (const entry of found.names) {
    const key = entry.name.toLowerCase()
    if (draft.seen.has(key) || draft.names.length >= 120) continue
    draft.seen.add(key)
    const merged = applySeriesNames(entry, board.series)
    if (merged.learned) board.learned.push(merged.learned)
    draft.names.push(merged.entry)
  }
  for (const entry of found.terms) {
    const key = entry.term.toLowerCase()
    if (draft.seen.has(key) || draft.terms.length >= 30) continue
    draft.seen.add(key)
    draft.terms.push(entry)
  }
  if (--draft.open > 0) return
  board.brief = { names: draft.names, terms: draft.terms }
  board.briefDraft = null
  if (board.learned.length && board.learnNames) {
    const learned = board.learned
    board.learned = []
    Promise.resolve().then(() => board.learnNames(learned)).catch(() => {})
  }
}

// The request that makes the brief. It is worth a few tries, not more: without it the translation still goes ahead.
// task.part: [from, to) — the lines it reads, when the whole subtitle was turned down and is read in pieces instead
const prepare = async (board, task, llm, helper, fast) => {
  const shape = board.shape
  const [from, to] = task.part ?? [0, board.cues.length]
  board.briefDraft ??= { names: [], terms: [], seen: new Set(), open: 1 }
  try {
    board.requests++
    const { text, sampled } = briefInput(task.part ? board.cues.slice(from, to) : board.cues)
    const reply = await chat({
      baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model, effort: llm.effort, caps: board.caps, signal: helper.abort.signal,
      messages: [{ role: 'system', content: briefPrompt(board, sampled) }, { role: 'user', content: text }],
    })
    spent(board, reply.usage)
    gather(board, readBrief(reply.text))
  } catch (error) {
    if (board.state !== 'running') return
    if (board.backupLlm && !board.useBackup && (error.kind === 'fatal' || error.kind === 'retry')) {
      board.useBackup = true
      board.queue.unshift({ ...task, refused: 0, notBefore: 0 })
      return
    }
    if (error.kind === 'fatal') return fail(board, error.message)
    if (error.kind === 'shape') {
      if (!reshape(board, shape, error.message)) return fail(board, error.message)
      board.queue.unshift({ ...task, notBefore: 0 })
      return
    }
    if (error.kind === 'content') {
      // Something in these lines is objected to. Read in pieces, the pieces without it still give their names; the piece
      // that is turned down again is left out, and not asked for a third time.
      if (task.part || to - from < BRIEF_PARTS || !board.briefDraft) return gather(board, NO_BRIEF)
      const size = Math.ceil((to - from) / BRIEF_PARTS)
      const pieces = []
      for (let at = from; at < to; at += size) pieces.push({ brief: true, attempt: 1, refused: 0, notBefore: 0, part: [at, Math.min(to, at + size)] })
      board.briefDraft.open += pieces.length - 1
      board.queue.unshift(...pieces)
      return
    }
    const refused = Boolean(error.retryAfter)
    const next = { ...task, attempt: task.attempt + (refused ? 0 : 1), refused: task.refused + (refused ? 1 : 0), notBefore: backOff(board, error, task.attempt, fast) }
    if (next.attempt <= BRIEF_ATTEMPTS && next.refused <= BRIEF_ATTEMPTS) board.queue.unshift(next)
    else gather(board, NO_BRIEF)
  }
}

// After the last line is in: read the translation once more for at most three things worth a note (idea 27).
// Any failure simply means no notes — never a failed translation.
const makeNotes = async (board, task, llm, helper, fast) => {
  if (board.notesUsed) return
  board.notesUsed = true   // at most one attempt at this step
  try {
    board.requests++
    const lines = board.out.map((text, i) => ([i + 1, typeof text === 'string' ? text : board.cues[i].text]))
    const sampled = lines.length > 500 ? lines.filter((_, i) => i % Math.ceil(lines.length / 500) === 0) : lines
    const user = {
      ...(board.brief?.terms?.length ? { terms: board.brief.terms.map(({ term, arabic }) => ({ term, arabic })) } : {}),
      ...(board.brief?.names?.length ? { names: board.brief.names.slice(0, 60).map(({ name, arabic }) => ({ name, arabic })) } : {}),
      lines: sampled,
    }
    const reply = await chat({
      baseUrl: llm.baseUrl, apiKey: llm.apiKey, model: llm.model, effort: llm.effort, caps: board.caps, signal: helper.abort.signal,
      messages: [{ role: 'system', content: notesPrompt() }, { role: 'user', content: JSON.stringify(user) }],
    })
    spent(board, reply.usage)
    board.notes = anchorNotes(readNotes(reply.text), board.cues, board.out)
  } catch { board.notes = [] }
}

// One request to the model for one batch. Never throws: what goes wrong is written on the board.
const work = async (board, task, llm, helper, fast) => {
  if (task.brief) return prepare(board, task, llm, helper, fast)
  if (task.notes) return makeNotes(board, task, llm, helper, fast)
  const pending = task.lines.filter(index => board.out[index] === undefined && !board.unproven.has(index))
  if (!pending.length) return
  const shape = board.shape
  try {
    const { answers, names } = await ask(board, pending, llm, helper.abort.signal, task.attempt, task.bare)
    board.accepted++
    settle(board)
    if (task.probe) return
    const read = index => {
      const raw = answers[String(index + 1)]
      return typeof raw === 'string' ? raw.trim() : ''
    }
    // A line that comes back without a word of Arabic may be right (a name, a brand, a sound): it is asked for once more,
    // then taken as it is. A batch that comes back mostly so was not translated at all, and is never taken: a model that
    // hands the lines back must not end up as a "finished" translation.
    const untouched = pending.filter(index => read(index) && !hasArabic(read(index)) && hasWords(board.cues[index].text))
    const notTranslated = untouched.length > 2 && untouched.length > pending.length * 0.3
    for (const index of pending) {
      const answer = read(index), source = board.cues[index].text
      if (!answer || board.out[index] !== undefined) continue
      const doubtful = untouched.includes(index) || misnamed(source, answer, names)   // a name of the brief translated, or spelt another way
      if (doubtful && (task.attempt === 1 || (notTranslated && untouched.includes(index)))) continue
      board.out[index] = answer
      board.translated++
    }
    const left = pending.filter(index => board.out[index] === undefined)
    if (left.length) again(board, task, left, notTranslated ? 'النموذج أعاد الأسطر كما هي بلا ترجمة' : 'بعض الأسطر لم ترجع من النموذج')
  } catch (error) {
    if (board.state !== 'running') return
    // فكرة 34: مرة واحدة في الحلقة، الاحتياطي يكمل — بدون ما تتدخل
    if (board.backupLlm && !board.useBackup && (error.kind === 'fatal' || error.kind === 'retry')) {
      board.useBackup = true
      board.queue.unshift({ ...task, refused: 0, notBefore: 0 })
      return
    }
    if (error.kind === 'fatal') return fail(board, error.message)
    if (error.kind === 'content') return turnedDown(board, task, pending, error.message)
    if (error.kind === 'shape') {
      if (!reshape(board, shape, error.message)) return fail(board, error.message)
      board.queue.unshift({ ...task, lines: pending, notBefore: 0 })
      return
    }
    // Being told to come back later does not count against the batch
    again(board, task, pending, error.message || 'خطأ من مزود الـAI', { notBefore: backOff(board, error, task.attempt, fast), refused: Boolean(error.retryAfter) })
  }
}

// Saving is a convenience: a store that fails must not stop a translation
const quietly = async action => {
  try { await action() } catch {}
}

const run = async (board, llm, helper, { fast = false, onProgress, onDone }) => {
  board.caps ??= freshCaps(llm.effort)
  const active = new Set()   // this helper's requests to the model
  let wake = null
  const nap = ms => new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    wake = () => { clearTimeout(timer); resolve() }
  })
  const beat = () => {
    board.helpers.set(helper.id, Date.now())
    if (board.state !== 'running') helper.abort.abort()
  }
  beat()
  const pulse = setInterval(beat, 1000)
  try {
    while (board.state === 'running') {
      reap(board)
      settle(board)
      if (unfit(board) || board.state !== 'running') break
      const now = Date.now()
      const mayClaim = now < helper.stopAt
      // Batches wait for the brief, so that every one of them spells the names alike; but not for ever
      const briefed = board.brief !== undefined || (board.briefSince > 0 && now - board.briefSince > (fast ? 250 : BRIEF_PATIENCE))
      while (mayClaim && helper.requests < helper.budget && now >= board.pauseUntil && active.size < llm.concurrency && board.claims.size < llm.concurrency) {
        const ready = task => task.notBefore <= now && (briefed || task.brief)
        // Until the provider has answered something of this video, a batch it turned down is not cut up further while
        // a request is out: what that one brings back says whether it objects to these lines or to everything
        let at = board.queue.findIndex(proven(board) ? ready : task => ready(task) && (!task.bare || task.probe))
        if (at < 0 && !proven(board) && board.claims.size === 0) at = board.queue.findIndex(ready)
        if (at < 0) break
        const [task] = board.queue.splice(at, 1)
        if (task.brief) board.briefSince ||= now
        const id = ++sequence
        board.claims.set(id, { helper: helper.id, task })
        helper.requests++
        const askingLlm = board.useBackup && board.backupLlm ? board.backupLlm : llm
        const request = work(board, task, askingLlm, helper, fast).finally(() => {
          board.claims.delete(id)
          active.delete(request)
          wake?.()
        })
        active.add(request)
      }
      if (board.queue.length === 0 && board.claims.size === 0 && !board.notesUsed && board.wantNotes && board.translated === board.cues.length) {
        board.queue.unshift({ notes: true, attempt: 1, refused: 0, notBefore: 0 })
        continue
      }
      if (board.queue.length === 0 && board.claims.size === 0) {
        const complete = board.translated === board.cues.length
        // Lines turned down alone and nothing ever answered: every request was turned down
        if (board.unproven.size) turnAway(board)
        else Object.assign(board, complete ? { state: 'done', finishedAt: now } : { state: 'failed', fatal: false, error: board.lastError || 'لم تكتمل الترجمة', finishedAt: now })
        break
      }
      // A helper that may send no more leaves; the batches still waiting are for the requests that come after it
      if (active.size === 0 && (!mayClaim || helper.requests >= helper.budget)) break

      let ms = active.size ? 1000 : 400
      for (const task of board.queue) if (task.notBefore > now) ms = Math.min(ms, task.notBefore - now)
      if (board.pauseUntil > now) ms = Math.min(ms, board.pauseUntil - now)
      await nap(Math.max(2, ms))
      if (onProgress && board.state === 'running') await quietly(() => onProgress(board, false))
    }
    if (active.size) {
      if (board.state !== 'running') helper.abort.abort()
      await Promise.allSettled([...active])
    }
    // The helper that sees the last line in is the one that stores the result
    if (board.state === 'done' && !board.stored) {
      board.stored = true
      if (onDone) await quietly(() => onDone(board))
    } else if (board.state === 'running' && onProgress) {
      await quietly(() => onProgress(board, true))
    }
  } finally {
    clearInterval(pulse)
    board.helpers.delete(helper.id)
  }
}

// llm: { baseUrl, apiKey, model, effort, concurrency }
// options: budget — requests this helper may send · stopAt — the time after which it claims no new batch
//          onProgress(board, leaving) — after each step, to save what there is · onDone(board) — once, when the last line is in
export const startHelper = (board, llm, options = {}) => {
  board.backupLlm = options.backup ?? null   // فكرة 34: الاحتياطي للحلقة كلها
  const helper = { id: ++sequence, requests: 0, budget: options.budget ?? Infinity, stopAt: options.stopAt ?? Infinity, abort: new AbortController(), finished: Promise.resolve() }
  if (board.state === 'running') helper.finished = run(board, llm, helper, options)
  return helper
}
