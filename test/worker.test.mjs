// The Cloudflare build (cloudflare/_worker.js), run in workerd — the runtime Cloudflare itself uses — through Miniflare.
// A new Miniflare instance stands for a new isolate: empty memory, the same KV.

import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { encodeConfig } from '../lib/config.mjs'
import { parseSubtitle, tidy } from '../lib/subs.mjs'
import { ROUGH, fake, sampleSrt, startAi, startAniList, startSource } from './mocks.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
let Miniflare, bundle, zipOne
try {
  ({ Miniflare } = await import('miniflare'));
  ({ bundle, zipOne } = await import('../build.mjs'))
} catch {}
const skip = Miniflare ? false : process.env.CI ? false : 'run "npm install" first to test the Cloudflare build'

const RLM = '\u200F'
const expected = tidy(parseSubtitle(sampleSrt()))
const BATCHES = Math.ceil(expected.length / 40)
const COMPLETE = 'public, max-age=86400'
const HELD = 'no-store, no-transform'
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))

describe('on Cloudflare (workerd)', { skip }, () => {
  let ai, source, anilist, script
  const running = new Set()

  before(async () => {
    ai = await startAi()
    source = await startSource()
    anilist = await startAniList()
    script = await readFile(join(ROOT, 'cloudflare', '_worker.js'), 'utf8')
  })
  after(async () => {
    await Promise.all([...running].map(isolate => isolate.dispose()))
    await ai.close()
    await source.close()
    await anilist.close()
  })

  // persist: the folder that stands for a KV namespace · kv: false for a deployment where none was bound
  const isolate = async ({ persist, kv = true, ...settings } = {}) => {
    const mf = new Miniflare({
      modules: true, script, compatibilityDate: '2026-01-20',
      kvNamespaces: kv ? ['CACHE'] : [], kvPersist: persist ?? false,
      bindings: {
        SUBS_SOURCE: source.url, META_SOURCE: source.url, SUBS_ALLOW: `^${source.url.replace(/\./g, '\\.')}/`,
        ALLOW_LOCAL_AI: '1', FAST_RETRIES: '1', RETRY_COOLDOWN_MS: '0', ANILIST_URL: 'http://127.0.0.1:9', ...settings,
      },
    })
    running.add(mf)
    const base = (await mf.ready).origin
    return {
      base,
      get: (path, options) => fetch(base + path, options),
      kvKeys: async () => (await (await mf.getKVNamespace('CACHE')).list()).keys.map(key => key.name[0]).sort().join(''),
      kvProgress: async () => {
        const kv = await mf.getKVNamespace('CACHE')
        const name = (await kv.list({ prefix: 'p:' })).keys[0]?.name
        return name ? kv.get(name, { type: 'json' }) : null
      },
      close: async () => { running.delete(mf); await mf.dispose() },
    }
  }

  // nm (reading the subtitle first, for its names) is off here, so that each test counts only the requests it is about
  const settings = (model, extra = {}) => encodeConfig({ b: ai.url, k: 'secret-key', m: model, src: 'eng', any: 1, warm: 0, cf: 0, sdh: 1, nm: 0, nt: 0, n: 2, wait: 20, bs: 40, cc: 2, ...extra })
  const callsOf = model => ai.callsOf(model).length
  const read = vtt => {
    assert.ok(vtt.startsWith('WEBVTT\n\n'), 'starts as WebVTT')
    return vtt.slice(8).trim().split(/\n{2,}/).filter(Boolean).map(block => {
      const [timing, ...lines] = block.split('\n')
      return { top: timing.endsWith(' line:0'), text: lines.join('\n') }
    })
  }
  const track = async (worker, path, options) => {
    const response = await worker.get(path, options)
    const cues = read(await response.text())
    const lines = cues.filter(cue => !cue.top).map(cue => cue.text)
    return { response, kept: response.headers.get('cache-control'), notes: cues.filter(cue => cue.top), lines, arabic: lines.filter((line, i) => line === RLM + fake(i + 1)).length }
  }
  // The address of the first listed subtitle, as a path
  const firstTrack = async (worker, cfg, title = 'movie/tt0000001') => {
    const { subtitles } = await (await worker.get(`/${cfg}/subtitles/${title}.json`)).json()
    assert.ok(subtitles[0].url.startsWith(`${worker.base}/${cfg}/t/`))
    return new URL(subtitles[0].url).pathname
  }

  test('the file that gets uploaded is built from the sources as they are now', async () => {
    const fresh = await bundle()
    assert.ok(fresh.equals(await readFile(join(ROOT, 'cloudflare', '_worker.js'))), 'cloudflare/_worker.js is out of date: run "npm run build"')
    assert.ok(zipOne('_worker.js', fresh).equals(await readFile(join(ROOT, 'cloudflare', 'tarjuman-cloudflare.zip'))), 'the zip is out of date: run "npm run build"')
    assert.ok(!/\bnode:|\brequire\(|\bprocess\.|\bBuffer\b/.test(script), 'nothing in it needs Node')
  })

  test('it answers: the page, the logo, the manifest, and what it can do', async () => {
    const worker = await isolate()
    const page = await worker.get('/')
    assert.match(page.headers.get('content-type'), /text\/html/)
    assert.match(await page.text(), /<html lang="ar" dir="rtl">/)
    const logo = await worker.get('/logo.png')
    assert.deepEqual([...new Uint8Array(await logo.arrayBuffer()).slice(0, 4)], [0x89, 0x50, 0x4e, 0x47])
    const manifest = await (await worker.get(`/${settings('ok')}/manifest.json`)).json()
    assert.equal(manifest.behaviorHints.configurationRequired, false)
    assert.equal(manifest.logo, `${worker.base}/logo.png`)
    const status = await (await worker.get('/api/status')).json()
    assert.deepEqual({ runtime: status.runtime, storage: status.storage, source: status.source.ok }, { runtime: 'cloudflare', storage: 'kv', source: true })
    const tested = await (await worker.get('/api/test', { method: 'POST', body: JSON.stringify({ b: ai.url, k: 'x', m: 'ok-cf-button' }) })).json()
    assert.deepEqual(tested.lines.map(pair => pair.to), [fake(1), fake(2), fake(3)])
    // installed from its bare address, without the settings: the list of subtitles says so
    const bare = await (await worker.get('/subtitles/series/tt0000001%3A1%3A2/filename=Some.Show.S01E02.mkv.json')).json()
    assert.deepEqual(bare.subtitles.map(entry => [entry.lang, entry.id, entry.url]), [['ara', '⚠️ ترجمان: ناقصها الإعدادات', `${worker.base}/notice/setup.vtt`]])
    assert.match(await (await worker.get('/notice/setup.vtt')).text(), /^WEBVTT\n\n00:00:00\.500 --> 00:00:08\.500 line:0\n\u200F⚠️ ترجمان مثبّتة بلا إعدادات/)
    assert.equal((await (await worker.get('/manifest.json')).json()).name, 'Tarjuman AI | ترجمان (بلا إعدادات)')
    await worker.close()
  })

  test('a translation is kept in KV: a new isolate serves it without asking the model', async () => {
    const persist = await mkdtemp(join(tmpdir(), 'tarjuman-kv-'))
    const cfg = settings('ok-cf')
    const first = await isolate({ persist })
    const path = await firstTrack(first, cfg)
    const made = await track(first, path)
    assert.equal(made.kept, HELD)
    assert.equal(made.notes.length, 0)
    assert.equal(made.arabic, expected.length)
    assert.equal(callsOf('ok-cf'), BATCHES)
    assert.equal((await track(first, path)).kept, COMPLETE)
    assert.match(await first.kvKeys(), /f/)
    await first.close()

    const second = await isolate({ persist })
    const served = await track(second, path)
    assert.equal(served.kept, COMPLETE)
    assert.equal(served.arabic, expected.length)
    assert.equal(callsOf('ok-cf'), BATCHES)
    await second.close()
  })

  test('translating starts when the list is asked for, and goes on after the list was answered', async () => {
    const worker = await isolate()
    const path = await firstTrack(worker, settings('lag-cf-warm', { warm: 1 }))
    await pause(1200)
    assert.equal(callsOf('lag-cf-warm'), BATCHES)
    const ready = await track(worker, path)
    assert.equal(ready.kept, COMPLETE)
    assert.equal(ready.arabic, expected.length)
    await worker.close()
  })

  test('a player that hangs up and asks again (Nuvio on iOS) joins the same translation', async () => {
    const worker = await isolate()
    const path = await firstTrack(worker, settings('slow-cf-twice', { cc: 1 }))
    const first = new AbortController()
    const dropped = worker.get(path, { signal: first.signal }).then(response => response.text()).catch(error => error.name)
    await pause(1000)
    first.abort()
    assert.equal(await dropped, 'AbortError')
    const second = await track(worker, path)
    assert.equal(second.notes.length, 0)
    assert.equal(second.arabic, expected.length)
    assert.equal(callsOf('slow-cf-twice'), BATCHES, 'nothing was translated twice')
    await worker.close()
  })

  test('two players at once share one translation', async () => {
    const worker = await isolate()
    const path = await firstTrack(worker, settings('lag-cf-pair'))
    const [one, two] = await Promise.all([track(worker, path), track(worker, path)])
    assert.equal(one.arabic, expected.length)
    assert.equal(two.arabic, expected.length)
    assert.equal(callsOf('lag-cf-pair'), BATCHES)
    assert.ok(ai.peakOf('lag-cf-pair') <= 2)
    await worker.close()
  })

  test('while it waits, the answer has started and keeps the line alive', async () => {
    const worker = await isolate({ TRICKLE_MS: '400' })
    const path = await firstTrack(worker, settings('slow-cf-trickle', { cc: 1 }))
    const started = Date.now()
    const response = await worker.get(path)
    assert.ok(Date.now() - started < 1500, 'the headers come at once')
    assert.equal(response.headers.get('cache-control'), HELD)
    const arrivals = []
    const decoder = new TextDecoder()
    for await (const chunk of response.body) arrivals.push({ at: Date.now() - started, part: decoder.decode(chunk, { stream: true }) })
    assert.ok(arrivals[0].part.startsWith('WEBVTT\n\n'))
    assert.ok(arrivals[0].at < 1500)
    const early = arrivals.filter(arrival => arrival.at < 3500 && /^\n+$/.test(arrival.part))
    assert.ok(early.length >= 3, `${early.length} blank lines before the translation: ${arrivals.map(a => a.at).join(' ')}`)
    assert.equal(read(arrivals.map(arrival => arrival.part).join('')).length, expected.length)
    await worker.close()
  })

  test('a request cut short by its budget: the work carries over, across requests and isolates, and no line is sent twice', async () => {
    // The free plan allows a request 50 outgoing requests; here each request may send one batch, to see the hand-over
    const persist = await mkdtemp(join(tmpdir(), 'tarjuman-kv-'))
    const cfg = settings('ok-cf-budget', { cc: 1 })
    const sent = () => ai.callsOf('ok-cf-budget').flatMap(call => Object.keys(JSON.parse(call.messages[1].content).lines))

    const first = await isolate({ persist, HELPER_BUDGET: '1' })
    const path = await firstTrack(first, cfg)
    const one = await track(first, path)
    assert.equal(one.arabic, 40)
    assert.match(one.notes[0].text, /قيد التجهيز \(37%\)/)
    assert.equal(one.lines.length, expected.length)
    const saved = await first.kvProgress()
    assert.equal(saved.cues.length, expected.length)
    assert.equal(saved.out.filter(Boolean).length, 40)
    await first.close()

    // a new isolate knows nothing: it reads what was saved, and goes on from there without fetching the subtitle again
    const files = source.hits.file
    const second = await isolate({ persist, HELPER_BUDGET: '1' })
    const two = await track(second, path)
    assert.equal(two.arabic, 80)
    assert.equal(source.hits.file, files)
    await second.close()

    const third = await isolate({ persist, HELPER_BUDGET: '1' })
    const three = await track(third, path)
    assert.equal(three.arabic, expected.length)
    assert.equal(three.notes.length, 0)
    assert.equal(await third.kvKeys(), 'fpr')   // f: the finished translation · p: what was saved half-way · r: the monthly report
    await third.close()

    assert.equal(callsOf('ok-cf-budget'), BATCHES)
    assert.equal(new Set(sent()).size, expected.length)
    assert.equal(sent().length, expected.length)

    const fourth = await isolate({ persist, HELPER_BUDGET: '1' })
    assert.equal((await track(fourth, path)).kept, COMPLETE)
    assert.equal(callsOf('ok-cf-budget'), BATCHES)
    await fourth.close()
  })

  test('names: the brief is made once and kept with the work in progress, so a new isolate does not ask again', async () => {
    const persist = await mkdtemp(join(tmpdir(), 'tarjuman-kv-'))
    const cfg = settings('ok-cf-names', { nm: 1, sdh: 0, cc: 1 })
    const first = await isolate({ persist, HELPER_BUDGET: '2' })   // the brief and one batch
    const path = await firstTrack(first, cfg)
    assert.equal((await track(first, path)).arabic, 40)
    assert.equal(ai.briefsOf('ok-cf-names').length, 1)
    assert.equal((await first.kvProgress()).brief.names[0].arabic, 'ماري')
    await first.close()

    const second = await isolate({ persist, HELPER_BUDGET: '9' })
    const whole = await track(second, path)
    assert.equal(whole.notes.length, 0)
    assert.equal(ai.briefsOf('ok-cf-names').length, 1)
    const batches = ai.callsOf('ok-cf-names').map(call => JSON.parse(call.messages[1].content))
    assert.equal(batches.length, Math.ceil(whole.lines.length / 40))
    assert.ok(batches.every(batch => batch.names?.Mary?.arabic === 'ماري' && batch.names.Mary.is === 'woman'))
    await second.close()
  })

  test('a show known to AniList: one name dictionary in KV, reused by the next isolate (ideas 14 + 17)', async () => {
    const persist = await mkdtemp(join(tmpdir(), 'tarjuman-kv-'))
    const cfg = settings('ok-cf-dict', { nm: 1, sdh: 0, cc: 1 })
    const first = await isolate({ persist, HELPER_BUDGET: '3', ANILIST_URL: anilist.url })
    const path = await firstTrack(first, cfg, 'series/tt0000204%3A1%3A5')
    await track(first, path)
    const [brief] = ai.briefsOf('ok-cf-dict')
    assert.equal(ai.briefsOf('ok-cf-dict').length, 1)
    assert.match(brief.messages[0].content, /The characters of this work, known from its database/)
    assert.match(brief.messages[0].content, /- Mary \(メアリー\) — man/)
    const batches = ai.callsOf('ok-cf-dict').map(call => JSON.parse(call.messages[1].content))
    const mary = batches.map(batch => batch.names?.Mary).filter(Boolean)
    assert.equal(mary.every(entry => entry.is === 'man'), true, 'the gender from the database wins')
    await first.close()

    // the next isolate reads the dictionary from KV: AniList is not asked again, and Mary's spelling is already in it
    const before2 = anilist.hits.length
    const second = await isolate({ persist, HELPER_BUDGET: '9' })
    const path3 = await firstTrack(second, settings('ok-cf-dict-3', { nm: 1, sdh: 0, cc: 1 }), 'series/tt0000204%3A1%3A3')
    await track(second, path3)
    const [brief3] = ai.briefsOf('ok-cf-dict-3')
    assert.equal(ai.briefsOf('ok-cf-dict-3').length, 1)
    assert.match(brief3.messages[0].content, /These have a spelling already chosen for this work/)
    assert.match(brief3.messages[0].content, /Mary → ماري/)
    assert.equal(anilist.hits.length, before2, 'the second isolate did not ask AniList again')
    await second.close()
  })

  test('without KV it still translates, and says that nothing is kept', async () => {
    const worker = await isolate({ kv: false })
    assert.equal((await (await worker.get('/api/status')).json()).storage, 'none')
    const path = await firstTrack(worker, settings('ok-cf-nokv'))
    assert.equal((await track(worker, path)).arabic, expected.length)
    assert.equal((await track(worker, path)).kept, COMPLETE)   // from the isolate's memory, for as long as it lives
    assert.equal(callsOf('ok-cf-nokv'), BATCHES)
    await worker.close()
  })

  test('a line the provider will not take: found across requests cut short and new isolates, left as written, and kept', async () => {
    const persist = await mkdtemp(join(tmpdir(), 'tarjuman-kv-'))
    const rough = tidy(parseSubtitle(sampleSrt(130, ROUGH)))
    const at = rough.findIndex(cue => cue.text.includes('FLAGGED'))
    const cfg = settings('strict-cf', { cc: 1 })
    let path, last, rounds = 0, seenAsWritten = false
    // each request may send eight requests to the model, and each comes to a new isolate: what the one before found out
    // is known only from what was saved. (Eight is what it takes, at most, to get from a batch down to one line.)
    for (; rounds < 6 && last?.notes.length !== 0; rounds++) {
      const worker = await isolate({ persist, HELPER_BUDGET: '8' })
      path ??= await firstTrack(worker, cfg, 'movie/tt0000066')
      last = await track(worker, path)
      const saved = await worker.kvProgress()
      // what is saved never shows the line as translated without saying that it was left as written
      if (saved.out[at] !== null) {
        assert.deepEqual([saved.out[at], saved.asWritten], [rough[at].text, [at]])
        seenAsWritten = true
      }
      await worker.close()
    }
    assert.ok(rounds >= 2, 'it took more than one request')
    assert.ok(seenAsWritten, 'the line left as written was saved with the work in progress')
    assert.equal(last.notes.length, 0)
    assert.equal(last.lines.length, rough.length)
    last.lines.forEach((line, i) => assert.equal(line, i === at ? rough[at].text : RLM + fake(i + 1), `line ${i + 1}`))

    const calls = callsOf('strict-cf')
    const fresh = await isolate({ persist })
    const served = await track(fresh, path)
    assert.equal(served.kept, COMPLETE)
    assert.deepEqual(served.lines, last.lines)
    assert.equal(callsOf('strict-cf'), calls)
    await fresh.close()
  })

  test('a provider that turns the whole video down: said on screen, and nothing kept as translated', async () => {
    const persist = await mkdtemp(join(tmpdir(), 'tarjuman-kv-'))
    const worker = await isolate({ persist })
    const path = await firstTrack(worker, settings('refuses-all-cf'))
    const { notes, arabic, lines } = await track(worker, path)
    assert.match(notes[0].text, /توقفت الترجمة عند 0%: رفض المزود كل ما أُرسل إليه، فجرّب نموذجًا أو مزودًا آخر/)
    assert.equal(arabic, 0)
    assert.deepEqual(lines, expected.map(cue => cue.text))
    const sizes = ai.callsOf('refuses-all-cf').map(call => Object.keys(JSON.parse(call.messages[1].content).lines).length)
    assert.equal(sizes.filter(size => size === 1).length, 6)
    assert.ok(sizes.length <= 9, `requests of ${sizes} lines`)
    assert.ok(!(await worker.kvKeys()).includes('f'))
    const saved = await worker.kvProgress()
    assert.ok(saved.out.every(line => line === null))
    assert.deepEqual(saved.asWritten, [])
    await worker.close()
  })

  test('picked twice: the first pick is kept in KV, so the second one counts when it comes to another isolate', async () => {
    const persist = await mkdtemp(join(tmpdir(), 'tarjuman-kv-'))
    const cfg = settings('ok-cf-twice', { cf: undefined })   // on unless an address turns it off
    const first = await isolate({ persist, CONFIRM_GAP_MS: '200' })
    const path = await firstTrack(first, cfg)
    const asked = await track(first, path)
    assert.match(asked.notes[0].text, /اختر هذه الترجمة مرة ثانية لتبدأ الترجمة/)
    assert.equal(asked.lines.length, 0)
    assert.equal(asked.kept, 'no-store')
    assert.equal(callsOf('ok-cf-twice'), 0)
    assert.equal(await first.kvKeys(), 'a')   // the first pick, and nothing else: no subtitle read, no work saved
    await first.close()

    await pause(300)
    const second = await isolate({ persist, CONFIRM_GAP_MS: '200' })
    const made = await track(second, path)
    assert.equal(made.notes.length, 0)
    assert.equal(made.arabic, expected.length)
    assert.equal(callsOf('ok-cf-twice'), BATCHES)
    const { subtitles } = await (await second.get(`/${cfg}/subtitles/movie/tt0000001.json`)).json()
    assert.deepEqual(subtitles.map(entry => entry.id.slice(0, 7)), ['AI ✓ · ', 'AI ⏳ · '])
    await second.close()
  })

  test('picked twice: work that was saved half-way is taken up by a new isolate without asking again', async () => {
    const persist = await mkdtemp(join(tmpdir(), 'tarjuman-kv-'))
    const cfg = settings('ok-cf-twice-saved', { cf: undefined, cc: 1 })
    const limits = { persist, HELPER_BUDGET: '1', CONFIRM_GAP_MS: '150', CONFIRM_WINDOW_MS: '500' }
    const first = await isolate(limits)
    const path = await firstTrack(first, cfg)
    assert.match((await track(first, path)).notes[0].text, /اختر هذه الترجمة مرة ثانية/)
    await pause(200)
    const part = await track(first, path)   // the second pick: one batch, which is all this request may send
    assert.equal(part.arabic, 40)
    await first.close()

    await pause(700)   // the first pick is long forgotten
    const second = await isolate(limits)
    const more = await track(second, path)
    assert.doesNotMatch(more.notes[0]?.text ?? '', /اختر هذه الترجمة مرة ثانية/)
    assert.equal(more.arabic, 80)
    await second.close()
  })

  test('a refused key: the reason on screen, and nothing kept', async () => {
    const persist = await mkdtemp(join(tmpdir(), 'tarjuman-kv-'))
    const worker = await isolate({ persist })
    const path = await firstTrack(worker, settings('bad-key'))
    const { notes, arabic } = await track(worker, path)
    assert.match(notes[0].text, /توقفت الترجمة عند 0%: مفتاح الـAI مرفوض \(401\)/)
    assert.equal(arabic, 0)
    assert.ok(!(await worker.kvKeys()).includes('f'))
    await worker.close()
  })
})
