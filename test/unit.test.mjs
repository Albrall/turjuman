import assert from 'node:assert/strict'
import { after, before, describe, test } from 'node:test'
import { alive, anchorNotes, briefInput, briefPrompt, cacheKey, createBoard, makeBatches, misnamed, readBrief, readNotes, resumeBoard, startHelper, surelyName, systemPrompt } from '../lib/board.mjs'
import { mergeReport, monthKey, reportHtml } from '../lib/report.mjs'
import { ConfigError, assertProviderAllowed, decodeConfig, decodeText, encodeConfig, encodeText, normalize, readLimited, readTextLimited, MAX_SUBTITLE_BYTES } from '../lib/config.mjs'
import { failure, freshCaps, loosen, readMap } from '../lib/llm.mjs'
import { pickLanguage, rank, sourceSettings } from '../lib/sources.mjs'
import { buildVtt, parseSubtitle, stamp, tidy } from '../lib/subs.mjs'
import { BRIEF, fake, sampleSrt, startAi } from './mocks.mjs'
import { byName, embeddedVerdict, markersIn, packRange, parseVideoId, verdictFor } from '../lib/episode.mjs'
import { applySeriesNames, learnSeriesNames } from '../lib/series.mjs'
import { isSongCue } from '../lib/subs.mjs'
import { PACK_MIN_CUES, episodeLabel, packNotice, selectEpisode } from '../lib/pack.mjs'
import { unzipSubtitle, settleWithin, EXTRA_DEADLINE_MS } from '../lib/extraSources.mjs'
import { strToU8, zipSync } from 'fflate'

describe('reading subtitles', () => {
  test('plain SRT', () => {
    const cues = parseSubtitle('1\n00:00:01,000 --> 00:00:02,500\nHello\n\n2\n00:01:03,250 --> 00:01:04,000\nTwo\nlines\n')
    assert.deepEqual(cues, [{ start: 1, end: 2.5, text: 'Hello' }, { start: 63.25, end: 64, text: 'Two\nlines' }])
  })

  test('byte-order mark and Windows line ends', () => {
    const cues = parseSubtitle(sampleSrt(130))
    assert.equal(cues.length, 130)
    assert.equal(cues[0].text, 'Did you hear that noise outside?')
    assert.equal(cues[0].start, 4)
    assert.equal(cues[2].text, "- Who is it?\n- It's me, open up.")
  })

  test('no blank line between cues', () => {
    const cues = parseSubtitle('1\n00:00:01,000 --> 00:00:02,000\nHello\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n')
    assert.deepEqual(cues.map(cue => cue.text), ['Hello', 'World'])
  })

  test('a blank line inside a cue', () => {
    const cues = parseSubtitle('1\n00:00:01,000 --> 00:00:02,000\nLine A\n\nLine B\n\n2\n00:00:03,000 --> 00:00:04,000\nNext\n')
    assert.deepEqual(cues.map(cue => cue.text), ['Line A\nLine B', 'Next'])
  })

  test('a line of digits is dialogue, the counter is not', () => {
    const cues = parseSubtitle('1\n00:00:01,000 --> 00:00:02,000\n1984\n\n2\n00:00:03,000 --> 00:00:04,000\nYes\n')
    assert.deepEqual(cues.map(cue => cue.text), ['1984', 'Yes'])
  })

  test('WebVTT: header, notes, cue names, settings, short timestamps', () => {
    const cues = parseSubtitle('WEBVTT\n\nNOTE a comment\nover two lines\n\nintro\n00:01.000 --> 00:02.500 line:0 position:50%\nHello there\n\n00:00:03.000 --> 00:00:04.000\n<v Mary>Second</v>\n')
    assert.deepEqual(cues, [{ start: 1, end: 2.5, text: 'Hello there' }, { start: 3, end: 4, text: '<v Mary>Second</v>' }])
  })

  test('cues out of order come back in order; empty and backwards ones are left out', () => {
    const cues = parseSubtitle('1\n00:00:05,000 --> 00:00:06,000\nLater\n\n2\n00:00:01,000 --> 00:00:02,000\nSooner\n\n3\n00:00:09,000 --> 00:00:08,000\nBackwards\n\n4\n00:00:10,000 --> 00:00:11,000\n\n')
    assert.deepEqual(cues.map(cue => cue.text), ['Sooner', 'Later'])
  })

  test('not a subtitle', () => assert.deepEqual(parseSubtitle('<html>not found</html>'), []))
})

describe('tidying', () => {
  const one = (text, options) => tidy([{ start: 0, end: 1, text }], options).map(cue => cue.text)

  test('style codes go, italics stay', () => {
    assert.deepEqual(one('{\\an8}Meet me at nine.'), ['Meet me at nine.'])
    assert.deepEqual(one('<font color="#ffff00">Keep your voice down.</font>'), ['Keep your voice down.'])
    assert.deepEqual(one('<i>We have been waiting.</i>'), ['<i>We have been waiting.</i>'])
    assert.deepEqual(one('<I CLASS="x">Hi</I> <v Mary>there</v>'), ['<i>Hi</i> there'])
  })

  test('adverts go', () => {
    assert.deepEqual(one('Subtitles by www.example-subs.com'), [])
    assert.deepEqual(one('Advertise your product or brand here'), [])
    assert.deepEqual(one('Downloaded from https://example.org'), [])
    assert.deepEqual(one('I work at the company on Main Street.'), ['I work at the company on Main Street.'])
  })

  test('sound descriptions go, the speech around them stays', () => {
    assert.deepEqual(one('[door creaks]'), [])
    assert.deepEqual(one("(sighs) I don't know."), ["I don't know."])
    assert.deepEqual(one('MARY: Where is the map?'), ['Where is the map?'])
    assert.deepEqual(one('- MAN ON TV: Good evening.\n- [laughs] Turn it off.'), ['- Good evening.\n- Turn it off.'])
    assert.deepEqual(one('<i>[music playing]</i>'), [])
    assert.deepEqual(one('♪♪'), [])
    assert.deepEqual(one('Be there at 10:30 sharp.'), ['Be there at 10:30 sharp.'])
  })

  test('sound descriptions stay when asked', () => {
    assert.deepEqual(one('[door creaks]', { dropSounds: false }), ['[door creaks]'])
    assert.deepEqual(one('MARY: Where is the map?', { dropSounds: false }), ['MARY: Where is the map?'])
  })

  test('a change of speaker keeps its dashes; an arrow cannot break the file', () => {
    assert.deepEqual(one("- Who is it?\n- It's me."), ["- Who is it?\n- It's me."])
    assert.deepEqual(one('go --> there'), ['go → there'])
  })
})

describe('writing WebVTT', () => {
  test('timestamps', () => {
    assert.equal(stamp(0), '00:00:00.000')
    assert.equal(stamp(3661.5), '01:01:01.500')
    assert.equal(stamp(1.9996), '00:00:02.000')
    assert.equal(stamp(-3), '00:00:00.000')
  })

  test('order, right-to-left mark, top-of-screen notes', () => {
    const vtt = buildVtt([
      { start: 5, end: 6, text: 'Plain' },
      { start: 1, end: 2, text: '- مرحبا\n- أهلا', rtl: true },
      { start: 3, end: 4, text: 'ملاحظة', rtl: true, top: true },
    ])
    assert.equal(vtt, 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\n\u200F- مرحبا\n\u200F- أهلا\n\n00:00:03.000 --> 00:00:04.000 line:0\n\u200Fملاحظة\n\n00:00:05.000 --> 00:00:06.000\nPlain\n')
  })
})

describe("reading the model's answer", () => {
  test('a clean object', () => assert.deepEqual(readMap('{"1":"أ","2":"ب"}'), { 1: 'أ', 2: 'ب' }))
  test('wrapped in prose and code fences', () => assert.deepEqual(readMap('Sure!\n```json\n{"1": "أ"}\n```\nDone.'), { 1: 'أ' }))
  test('nested one level down', () => assert.deepEqual(readMap('{"translations":{"1":"أ","2":"ب"}}'), { 1: 'أ', 2: 'ب' }))
  test('a single line is not mistaken for a wrapper', () => assert.deepEqual(readMap('{"5":"أ"}'), { 5: 'أ' }))
  test('cut off mid-way: the complete pairs are kept', () => assert.deepEqual(readMap('{"1":"أ","2":"قال \\"نعم\\"","3":"نص غير مكت'), { 1: 'أ', 2: 'قال "نعم"' }))
  test('no JSON at all', () => assert.deepEqual(readMap('I cannot help with that.'), {}))
})

describe('dropping refused request fields', () => {
  test('the one the error names', () => {
    const caps = freshCaps('low')
    assert.equal(loosen(caps, "Unsupported value: 'temperature'"), true)
    assert.deepEqual(caps, { effort: true, temperature: false, json: true })
  })
  test('otherwise one at a time, until none is left', () => {
    const caps = freshCaps('low')
    assert.equal(loosen(caps, 'invalid request'), true)
    assert.equal(caps.effort, false)
    assert.equal(loosen(caps, 'invalid request'), true)
    assert.equal(caps.temperature, false)
    assert.equal(loosen(caps, 'invalid request'), true)
    assert.equal(caps.json, false)
    assert.equal(loosen(caps, 'invalid request'), false)
  })
  test('no effort set: nothing to drop there', () => assert.equal(freshCaps('').effort, false))
})

describe('batches', () => {
  const cues = length => Array.from({ length }, () => ({ text: 'A line of ordinary length.' }))
  test('every line once, in order', () => {
    const batches = makeBatches(cues(130), [...Array(130).keys()], 40)
    assert.deepEqual(batches.map(batch => batch.length), [40, 40, 40, 10])
    assert.deepEqual(batches.flat(), [...Array(130).keys()])
  })
  test('long lines make smaller batches', () => {
    const long = Array.from({ length: 30 }, () => ({ text: 'x'.repeat(500) }))
    assert.deepEqual(makeBatches(long, [...Array(30).keys()], 40).map(batch => batch.length), [8, 8, 8, 6])
  })
  test('only the lines still waiting', () => assert.deepEqual(makeBatches(cues(10), [2, 3, 9], 2), [[2, 3], [9]]))
})

describe('choosing the subtitle to translate', () => {
  const subs = [
    { url: 'a', lang: 'eng', movieReleaseName: 'Some.Film.2020.CAM.XviD-GRP' },
    { url: 'b', lang: 'eng', movieReleaseName: 'Some.Film.2020.1080p.WEB-DL.x264-OTHER' },
    { url: 'c', lang: 'eng', movieReleaseName: 'Some.Film.2020.1080p.BluRay.x264-SPARKS' },
  ]
  const order = (list, filename) => rank(list, filename).map(sub => sub.url).join('')

  test('the file name decides', () => assert.equal(order(subs, 'Some.Film.2020.1080p.BluRay.x264-SPARKS.mkv'), 'cba'))
  test('no file name: the given order, cinema recordings last', () => assert.equal(order(subs, ''), 'bca'))
  test('a cinema recording is right for a cinema recording', () => assert.equal(order(subs, 'Some.Film.2020.CAM.XviD-GRP.avi'), 'abc'))
  test('a match by the file hash beats the name', () => assert.equal(order([...subs, { url: 'd', lang: 'eng', movieReleaseName: 'whatever', m: 'h' }], 'Some.Film.2020.1080p.BluRay.x264-SPARKS.mkv'), 'dcba'))

  test('language: the chosen one, else another, never Arabic', () => {
    const langs = (...codes) => codes.map(lang => ({ lang }))
    assert.equal(pickLanguage(langs('spa', 'eng'), 'eng', true), 'eng')
    assert.equal(pickLanguage(langs('ara', 'spa', 'fre'), 'eng', true), 'fre')
    assert.equal(pickLanguage(langs('ara', 'tha'), 'eng', true), 'tha')
    assert.equal(pickLanguage(langs('spa'), 'eng', false), null)
    assert.equal(pickLanguage(langs('ara'), 'eng', true), null)
    assert.equal(pickLanguage([], 'eng', true), null)
  })
})

describe('settings', () => {
  const base = { b: 'https://api.example.com/v1/', k: ' key ', m: ' model-x ' }

  test('round trip through the address, with defaults filled in', () => {
    assert.deepEqual(decodeConfig(encodeConfig(base)), { b: 'https://api.example.com/v1', k: 'key', m: 'model-x', r: '', src: 'eng', any: true, warm: true, pn: true, sdh: true, nm: true, cf: true, gd: true, pk: true, nt: true, na: false, ca: false, ex: '', fb: '', fk: '', fm: '', sd: '', jm: '', n: 2, wait: 50, bs: 80, cc: 4 })
    assert.equal(normalize({ ...base, nt: 0 }).nt, false)
    // the backup provider: empty by default, refused politely when malformed, kept trimmed otherwise
    assert.equal(normalize({ ...base, fb: 'https://openrouter.ai/api/v1/', fk: ' k2 ', fm: ' m2 ' }).fb, 'https://openrouter.ai/api/v1')
    assert.throws(() => normalize({ ...base, fb: 'not a url' }), ConfigError)
    assert.throws(() => normalize({ ...base, fb: 'ftp://example.com/v1' }), ConfigError)
    assert.equal(normalize({ ...base, nm: 0 }).nm, false)
    // translating only on the second pick is on unless it is turned off: an address made before the option existed has it
    assert.equal(normalize({ ...base, cf: 0 }).cf, false)
    // the wrong-episode guard is on unless it is turned off: an address made before the option existed has it
    assert.equal(normalize({ ...base, gd: 0 }).gd, false)
  })
  test('values out of range are pulled back in', () => {
    const config = normalize({ ...base, n: 99, wait: 999, bs: 1000, cc: 0, r: 'extreme', src: 'English', any: 0, warm: '0', sdh: false })
    assert.deepEqual({ n: config.n, wait: config.wait, bs: config.bs, cc: config.cc, r: config.r, src: config.src, any: config.any, warm: config.warm, sdh: config.sdh },
      { n: 3, wait: 120, bs: 200, cc: 1, r: '', src: 'eng', any: false, warm: false, sdh: false })
    assert.equal(normalize({ ...base, wait: 0 }).wait, 0)
  })
  test('what cannot work is refused', () => {
    assert.throws(() => normalize({ ...base, b: 'not a url' }), ConfigError)
    assert.throws(() => normalize({ ...base, b: 'ftp://example.com' }), ConfigError)
    assert.throws(() => normalize({ ...base, m: '' }), ConfigError)
    assert.throws(() => decodeConfig('!!!'), ConfigError)
    assert.throws(() => decodeConfig('AAAAAAAAAAAAAAAA'), ConfigError)
  })
  test('text in an address: any script, no padding, no characters an address would change', () => {
    for (const sample of ['', 'a', 'ab', 'abc', 'ترجمان · Tarjuman', '{"u":"https://x/y?z=1&w=2","l":"eng"}', '😀🎬']) {
      const encoded = encodeText(sample)
      assert.match(encoded, /^[A-Za-z0-9_-]*$/)
      assert.equal(decodeText(encoded), sample)
    }
    assert.equal(encodeText('ترجمان'), Buffer.from('ترجمان').toString('base64url'))
  })

  test('a public server only calls public https providers', async () => {
    for (const address of ['http://api.example.com/v1', 'https://127.0.0.1/v1', 'https://10.1.2.3/v1', 'https://192.168.1.5/v1', 'https://172.20.0.1/v1', 'https://169.254.169.254/latest', 'https://[::1]/v1', 'https://localhost/v1', 'https://ollama.local/v1', 'https://nas.home.arpa/v1']) {
      await assert.rejects(assertProviderAllowed(address), ConfigError, address)
    }
    await assertProviderAllowed('https://1.1.1.1/v1')
    await assertProviderAllowed('https://api.example.com/v1')
    await assertProviderAllowed('http://127.0.0.1:11434/v1', { allowLocal: true })
  })
  test('where names can be resolved, a name that points inside is refused too', async () => {
    const lookup = async host => (host === 'inside.example.org' ? ['10.0.0.7'] : host === 'gone.example.org' ? [] : ['93.184.216.34'])
    await assert.rejects(assertProviderAllowed('https://inside.example.org/v1', { lookup }), /شبكة داخلية/)
    await assert.rejects(assertProviderAllowed('https://gone.example.org/v1', { lookup }), ConfigError)
    await assert.rejects(assertProviderAllowed('https://broken.example.org/v1', { lookup: async () => { throw new Error('ENOTFOUND') } }), /تعذّر الوصول/)
    await assertProviderAllowed('https://outside.example.org/v1', { lookup })
  })

  test('where the subtitles come from can be set, and has safe defaults', () => {
    const defaults = sourceSettings(() => undefined)
    assert.equal(defaults.source, 'https://opensubtitles-v3.strem.io')
    assert.ok(defaults.allow.test('https://subs5.strem.io/en/download/file/1'))
    assert.ok(!defaults.allow.test('https://evil.example/strem.io/'))
    assert.ok(!defaults.allow.test('http://subs5.strem.io/x'))
    assert.equal(defaults.extraMs, EXTRA_DEADLINE_MS)
    const custom = sourceSettings(name => ({ SUBS_SOURCE: 'http://127.0.0.1:9/', SUBS_ALLOW: '^http://127\\.0\\.0\\.1:9/' })[name])
    assert.equal(custom.source, 'http://127.0.0.1:9')
    assert.ok(custom.allow.test('http://127.0.0.1:9/file/1'))
  })
})

describe('a translation, worked on by helpers', () => {
  let ai
  before(async () => { ai = await startAi() })
  after(() => ai.close())

  const cues = count => Array.from({ length: count }, (_, i) => ({ start: i * 3, end: i * 3 + 2, text: `Line number ${i + 1} of the test` }))
  const llm = (model, effort = '', concurrency = 3) => ({ baseUrl: ai.url, apiKey: 'secret-key', model, effort, concurrency })
  const boardFor = (model, count = 25) => createBoard({ key: model, cues: cues(count), from: 'English', about: 'a test', batchSize: 10 })
  // Requests are counted by the model's name: a translation that stops at once cancels its other requests, and those can
  // still reach the stand-in provider after it is over
  const run = async (model, effort) => {
    const from = ai.callsOf(model).length
    const board = boardFor(model)
    await startHelper(board, llm(model, effort), { fast: true }).finished
    return { board, calls: ai.callsOf(model).slice(from) }
  }
  const allTranslated = board => board.cues.every((_, i) => board.out[i] === fake(i + 1))

  test('every line translated, in its place', async () => {
    const { board, calls } = await run('ok')
    assert.equal(board.state, 'done')
    assert.ok(allTranslated(board))
    assert.equal(board.translated, 25)
    assert.equal(calls.length, 3)
    assert.equal(board.helpers.size, 0)
    assert.equal(board.claims.size, 0)
  })

  test('what a request holds', async () => {
    const { calls } = await run('ok-shape', 'minimal')
    const second = calls.find(call => JSON.parse(call.messages[1].content).lines['11'])
    assert.equal(second.model, 'ok-shape')
    assert.equal(second.temperature, 0.2)
    assert.deepEqual(second.response_format, { type: 'json_object' })
    assert.equal(second.reasoning_effort, 'minimal')
    assert.equal(second.messages[0].role, 'system')
    assert.match(second.messages[0].content, /from English into Arabic/)
    assert.match(second.messages[0].content, /What you are translating: a test\./)
    const sent = JSON.parse(second.messages[1].content)
    assert.deepEqual(Object.keys(sent.lines), ['11', '12', '13', '14', '15', '16', '17', '18', '19', '20'])
    assert.deepEqual(sent.context_before, [7, 8, 9, 10].map(n => `Line number ${n} of the test`))
    assert.deepEqual(sent.context_after, [21, 22].map(n => `Line number ${n} of the test`))
    const first = calls.find(call => JSON.parse(call.messages[1].content).lines['1'])
    assert.deepEqual(JSON.parse(first.messages[1].content).context_before, [])
    assert.equal((await run('ok-no-effort')).calls[0].reasoning_effort, undefined)
  })

  for (const model of ['rate-429', 'rate-402', 'overloaded', 'empty']) {
    test(`asks again after a refusal that passes: ${model}`, async () => {
      const { board, calls } = await run(model)
      assert.equal(board.state, 'done')
      assert.ok(allTranslated(board))
      assert.equal(calls.length, 6)
    })
  }

  for (const model of ['fenced', 'nested', 'parts']) {
    test(`reads an answer in an unusual shape: ${model}`, async () => {
      const { board, calls } = await run(model)
      assert.equal(board.state, 'done')
      assert.ok(allTranslated(board))
      assert.equal(calls.length, 3)
    })
  }

  for (const model of ['drop', 'cut', 'garbage', 'echo']) {
    test(`asks again for the lines that did not come back: ${model}`, async () => {
      const { board, calls } = await run(model)
      assert.equal(board.state, 'done')
      assert.ok(allTranslated(board))
      assert.ok(calls.length > 3 && calls.length <= 6, `${calls.length} requests`)
    })
  }

  test('a model that hands the lines back untranslated never yields a finished translation', async () => {
    const { board, calls } = await run('no-arabic')
    assert.equal(board.state, 'failed')
    assert.equal(board.fatal, false)
    assert.equal(board.translated, 0)
    assert.match(board.error, /بلا ترجمة/)
    assert.equal(calls.length, 3 * 6)   // each of the three batches gets its six tries, and no more
  })

  test('a line or two that stay as they are (a brand, a sound) are asked for once more, then taken', async () => {
    const { board, calls } = await run('keeps-two')
    assert.equal(board.state, 'done')
    assert.equal(board.out[3], 'Line number 4 of the test')
    assert.equal(board.out[6], 'Line number 7 of the test')
    assert.equal(board.out[4], fake(5))
    assert.equal(calls.length, 4)
    assert.deepEqual(Object.keys(JSON.parse(calls.at(-1).messages[1].content).lines), ['4', '7'])
  })

  test('asking again sends only the missing lines', async () => {
    const { calls } = await run('cut')   // seen above, and cut short again: every full batch loses its tail
    const sizes = calls.map(call => Object.keys(JSON.parse(call.messages[1].content).lines).length).sort((a, b) => b - a)
    assert.deepEqual(sizes.slice(0, 2), [10, 10])
    assert.ok(sizes.slice(3).every(size => size < 10), `sizes ${sizes}`)
    assert.equal(sizes.reduce((sum, size) => sum + size, 0) < 50, true)
  })

  test('drops the request fields a provider refuses, one by one', async () => {
    const json = await run('no-json')
    assert.equal(json.board.state, 'done')
    assert.deepEqual(json.board.caps, { effort: false, temperature: true, json: false })
    const temperature = await run('no-temperature')
    assert.equal(temperature.board.state, 'done')
    assert.deepEqual(temperature.board.caps, { effort: false, temperature: false, json: true })
    const effort = await run('no-effort', 'low')
    assert.equal(effort.board.state, 'done')
    assert.deepEqual(effort.board.caps, { effort: false, temperature: true, json: true })
    const picky = await run('picky', 'low')
    assert.equal(picky.board.state, 'done')
    assert.ok(allTranslated(picky.board))
    assert.deepEqual(picky.board.caps, { effort: false, temperature: false, json: false })
  })

  for (const [model, status] of [['bad-key', '401'], ['no-credit', '402'], ['missing-model', '404']]) {
    test(`stops at once when trying again cannot help: ${model}`, async () => {
      const { board, calls } = await run(model)
      assert.equal(board.state, 'failed')
      assert.equal(board.fatal, true)
      assert.match(board.error, new RegExp(status))
      assert.equal(board.translated, 0)
      assert.ok(calls.length <= 3, `${calls.length} requests`)
    })
  }

  test('a stopped translation is picked up where it stopped', async () => {
    ai.failNext(1)
    const board = boardFor('flaky-key')
    await startHelper(board, llm('flaky-key', '', 1), { fast: true }).finished
    assert.equal(board.state, 'failed')
    assert.equal(board.translated, 0)
    const from = ai.callsOf('flaky-key').length
    resumeBoard(board, 10)
    assert.equal(board.state, 'running')
    await startHelper(board, llm('flaky-key', '', 1), { fast: true }).finished
    assert.equal(board.state, 'done')
    assert.ok(allTranslated(board))
    assert.equal(ai.callsOf('flaky-key').length - from, 3)
    // and a finished one is left alone
    resumeBoard(board, 10)
    assert.equal(board.state, 'done')
    await startHelper(board, llm('flaky-key'), { fast: true }).finished
    assert.equal(ai.callsOf('flaky-key').length - from, 3)
  })

  test('a translation that starts with some lines already in only asks for the rest', async () => {
    const out = new Array(25)
    for (let i = 0; i < 12; i++) out[i] = fake(i + 1)
    const board = createBoard({ key: 'ok-rest', cues: cues(25), out, from: 'English', about: 'a test', batchSize: 10 })
    assert.equal(board.translated, 12)
    await startHelper(board, llm('ok-rest'), { fast: true }).finished
    assert.equal(board.state, 'done')
    assert.ok(allTranslated(board))
    const asked = ai.callsOf('ok-rest').flatMap(call => Object.keys(JSON.parse(call.messages[1].content).lines).map(Number))
    assert.deepEqual(asked.sort((a, b) => a - b), Array.from({ length: 13 }, (_, i) => i + 13))
  })

  test('the key goes in the Authorization header, never in the body', async () => {
    const { calls } = await run('ok-key')
    assert.ok(!JSON.stringify(calls).includes('secret-key'))
  })

  describe('several requests on one translation', () => {
    test('two helpers at once: every batch is sent once, and never more at a time than one helper would', async () => {
      const board = boardFor('lag-two', 65)   // 7 batches
      const first = startHelper(board, llm('lag-two', '', 2), { fast: true })
      const second = startHelper(board, llm('lag-two', '', 2), { fast: true })
      assert.equal(board.helpers.size, 2)
      await Promise.all([first.finished, second.finished])
      assert.equal(board.state, 'done')
      assert.ok(allTranslated(board))
      assert.equal(ai.callsOf('lag-two').length, 7)
      assert.equal(ai.peakOf('lag-two'), 2)
      assert.equal(first.requests + second.requests, 7)
    })

    test('a helper that was cut off: the others take its batches back', async () => {
      const board = boardFor('ok-cut-off', 45)   // 5 batches
      // a request that claimed two batches and then went silent, as one cut off by the platform does
      board.helpers.set(-1, Date.now() - 60_000)
      board.claims.set(-1, { helper: -1, task: board.queue.shift() })
      board.claims.set(-2, { helper: -1, task: board.queue.shift() })
      assert.equal(alive(board), false)
      assert.equal(board.queue.length, 5)
      await startHelper(board, llm('ok-cut-off'), { fast: true }).finished
      assert.equal(board.state, 'done')
      assert.ok(allTranslated(board))
      assert.equal(ai.callsOf('ok-cut-off').length, 5)
    })

    test('a helper that is still beating keeps its batches', async () => {
      const board = boardFor('ok-busy', 25)   // 3 batches
      board.helpers.set(-1, Date.now())
      board.claims.set(-1, { helper: -1, task: board.queue.shift() })
      const helper = startHelper(board, llm('ok-busy'), { fast: true, stopAt: Date.now() + 300 })
      await helper.finished
      // it did the two batches that were free, then left the third to the helper that holds it
      assert.equal(board.state, 'running')
      assert.equal(board.translated, 15)
      assert.equal(ai.callsOf('ok-busy').length, 2)
      assert.equal(board.claims.size, 1)
    })

    test('a helper with a budget stops there, and the next one carries on', async () => {
      const board = boardFor('ok-budget', 45)   // 5 batches
      const saved = []
      const options = { fast: true, budget: 2, onProgress: (current, leaving) => { if (leaving) saved.push(current.translated) }, onDone: () => { saved.push('done') } }
      const first = startHelper(board, llm('ok-budget', '', 1), options)
      await first.finished
      assert.equal(first.requests, 2)
      assert.equal(board.state, 'running')
      assert.equal(board.translated, 20)
      assert.equal(alive(board), false)
      await startHelper(board, llm('ok-budget', '', 1), options).finished
      assert.equal(board.translated, 40)
      await startHelper(board, llm('ok-budget', '', 1), options).finished
      assert.equal(board.state, 'done')
      assert.ok(allTranslated(board))
      assert.equal(ai.callsOf('ok-budget').length, 5)
      assert.deepEqual(saved, [20, 40, 'done'])
    })

    test('a helper past its time takes nothing', async () => {
      const board = boardFor('ok-late', 25)
      await startHelper(board, llm('ok-late'), { fast: true, stopAt: Date.now() - 1 }).finished
      assert.equal(board.state, 'running')
      assert.equal(board.translated, 0)
      assert.equal(ai.callsOf('ok-late').length, 0)
    })

    test('the result is stored once, however many helpers were there', async () => {
      const board = boardFor('lag-store', 45)
      let stored = 0
      const options = { fast: true, onDone: () => { stored++ } }
      await Promise.all([1, 2, 3].map(() => startHelper(board, llm('lag-store', '', 2), options).finished))
      assert.equal(board.state, 'done')
      assert.equal(stored, 1)
    })

    test('a store that fails does not stop the translation', async () => {
      const board = boardFor('ok-store-fails', 25)
      const broken = () => { throw new Error('store is down') }
      await startHelper(board, llm('ok-store-fails'), { fast: true, onProgress: broken, onDone: broken }).finished
      assert.equal(board.state, 'done')
      assert.ok(allTranslated(board))
    })

    test('"too many requests" does not count against a batch, up to a point', async () => {
      const original = globalThis.fetch
      let requests = 0
      const provider = refusals => async (url, init) => {
        requests++
        if (requests <= refusals) return new Response(JSON.stringify({ error: { message: 'Too many requests' } }), { status: 429, headers: { 'retry-after': '1' } })
        const lines = JSON.parse(JSON.parse(init.body).messages[1].content).lines
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(Object.fromEntries(Object.keys(lines).map(id => [id, fake(id)]))) } }] }), { status: 200 })
      }
      try {
        // refused ten times in a row, more than the six tries a wrong answer gets: still translated
        globalThis.fetch = provider(10)
        const patient = createBoard({ key: 'x', cues: cues(8), from: 'English', about: 'a test', batchSize: 10 })
        await startHelper(patient, llm('limited', '', 1), { fast: true }).finished
        assert.equal(patient.state, 'done')
        assert.equal(requests, 11)
        // refused for ever: it gives up, and says why
        requests = 0
        globalThis.fetch = provider(Infinity)
        const hopeless = createBoard({ key: 'y', cues: cues(8), from: 'English', about: 'a test', batchSize: 10 })
        await startHelper(hopeless, llm('limited', '', 1), { fast: true }).finished
        assert.equal(hopeless.state, 'failed')
        assert.equal(hopeless.fatal, false)
        assert.match(hopeless.error, /429/)
        assert.equal(requests, 13)
      } finally {
        globalThis.fetch = original
      }
    })

    test('lines that keep failing are left for a later try, and the rest is kept', async () => {
      // "always-drop" never returns line 3: after six tries the translation stops, with every other line in
      const board = createBoard({ key: 'x', cues: cues(12), from: 'English', about: 'a test', batchSize: 10 })
      const original = globalThis.fetch
      let requests = 0
      globalThis.fetch = async (url, init) => {
        requests++
        const lines = JSON.parse(JSON.parse(init.body).messages[1].content).lines
        const answer = Object.fromEntries(Object.keys(lines).filter(id => id !== '3').map(id => [id, fake(id)]))
        return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(answer) } }] }), { status: 200 })
      }
      try {
        await startHelper(board, llm('always-drop'), { fast: true }).finished
      } finally {
        globalThis.fetch = original
      }
      assert.equal(board.state, 'failed')
      assert.equal(board.fatal, false)
      assert.equal(board.translated, 11)
      assert.equal(board.out[2], undefined)
      assert.match(board.error, /لم ترجع من النموذج/)
      assert.equal(requests, 2 + 5)   // two batches, then five more tries for the one line
    })
  })
})

describe('names: the subtitle is read once before it is translated', () => {
  let ai
  before(async () => { ai = await startAi() })
  after(() => ai.close())

  // 25 lines in three batches of ten. Names sit in known places; "hopeless", "stonewall" and "also" hold a name's letters without being one.
  const SCRIPT = {
    1: 'Hope, come over here.', 3: 'I saw Mr. Stone in Paris.', 5: 'It is hopeless, we also tried.',
    14: 'HOPE! Where are you?', 16: 'They will stonewall us.', 18: 'We take the long road.',
    24: 'Nothing but rain today.',
  }
  const cues = Array.from({ length: 25 }, (_, i) => ({ start: i * 3, end: i * 3 + 2, text: SCRIPT[i + 1] || `An ordinary line, number ${i + 1}.` }))
  const llm = (model, concurrency = 3) => ({ baseUrl: ai.url, apiKey: 'secret-key', model, effort: '', concurrency })
  const boardFor = (model, extra = {}) => createBoard({ key: model, cues, from: 'English', about: 'Some Film (2020), a Drama film', batchSize: 10, wantBrief: true, ...extra })
  const sentIn = (model, id) => JSON.parse(ai.callsOf(model).find(call => JSON.parse(call.messages[1].content).lines[id]).messages[1].content)

  test('one request for the brief, with the whole subtitle; then every batch gets the names that occur in it, and only those', async () => {
    const board = boardFor('ok-brief')
    await startHelper(board, llm('ok-brief'), { fast: true }).finished
    assert.equal(board.state, 'done')
    assert.equal(ai.callsOf('ok-brief').length, 3)

    const [asked] = ai.briefsOf('ok-brief')
    assert.equal(ai.briefsOf('ok-brief').length, 1)
    assert.match(asked.messages[0].content, /translator's brief for the Arabic subtitles of: Some Film \(2020\), a Drama film\./)
    assert.equal(asked.messages[1].content, cues.map(cue => cue.text).join('\n'))

    const first = sentIn('ok-brief', '1')
    assert.deepEqual(first.names, { Hope: { arabic: 'هوب', is: 'woman' }, 'Mr. Stone': { arabic: 'السيد ستون', is: 'man' }, Paris: { arabic: 'باريس', is: 'place' } })
    assert.equal(first.terms, undefined)
    // "HOPE!" is Hope; "stonewall" is not Stone; a kind the model made up is left out
    const second = sentIn('ok-brief', '11')
    assert.deepEqual(second.names, { Hope: { arabic: 'هوب', is: 'woman' } })
    assert.deepEqual(second.terms, { 'the long road': 'الطريق الطويل' })
    // the third batch has no name of its own, but the line before it does
    const third = sentIn('ok-brief', '21')
    assert.equal(third.names, undefined)
    assert.deepEqual(third.terms, { 'the long road': 'الطريق الطويل' })
    assert.deepEqual(board.brief.names.find(entry => entry.name === 'Al'), { name: 'Al', arabic: 'آل', kind: 'other' })
  })

  test('the batches wait for it', async () => {
    const board = boardFor('lag-brief')
    await startHelper(board, llm('lag-brief'), { fast: true }).finished
    assert.equal(board.state, 'done')
    assert.ok(ai.callsOf('lag-brief').every(call => JSON.parse(call.messages[1].content).terms || JSON.parse(call.messages[1].content).names), 'every batch was briefed')
    assert.equal(ai.peakOf('lag-brief'), 3)
  })

  test('helpers that arrive together ask for it once', async () => {
    const board = boardFor('lag-brief-once')
    await Promise.all([1, 2, 3].map(() => startHelper(board, llm('lag-brief-once', 2), { fast: true }).finished))
    assert.equal(board.state, 'done')
    assert.equal(ai.briefsOf('lag-brief-once').length, 1)
    assert.equal(ai.callsOf('lag-brief-once').length, 3)
  })

  test('a brief that takes too long is not waited for', async () => {
    const board = boardFor('brief-slow')
    await startHelper(board, llm('brief-slow'), { fast: true }).finished
    assert.equal(board.state, 'done')
    assert.equal(ai.callsOf('brief-slow').length, 3)
    assert.equal(sentIn('brief-slow', '1').names, undefined)
    assert.equal(board.brief.names.length, 4 + 1)   // it came in the end, too late for these lines
  })

  test('a brief that cannot be had: three tries, then the translation goes ahead without', async () => {
    const board = boardFor('brief-down')
    await startHelper(board, llm('brief-down'), { fast: true }).finished
    assert.equal(board.state, 'done')
    assert.equal(ai.briefsOf('brief-down').length, 3)
    assert.deepEqual(board.brief, { names: [], terms: [] })
    assert.equal(sentIn('brief-down', '1').names, undefined)
  })

  test('a brief that says nothing useful', async () => {
    const board = boardFor('brief-garbage')
    await startHelper(board, llm('brief-garbage'), { fast: true }).finished
    assert.equal(board.state, 'done')
    assert.deepEqual(board.brief, { names: [], terms: [] })
  })

  test('a refused key stops everything at the brief', async () => {
    const board = boardFor('bad-key')
    await startHelper(board, llm('bad-key'), { fast: true }).finished
    assert.equal(board.state, 'failed')
    assert.equal(board.fatal, true)
    assert.equal(board.translated, 0)
    assert.equal(ai.callsOf('bad-key').length, 0)
  })

  test('a provider that refuses a field of the request refuses it for the brief too', async () => {
    const board = boardFor('no-json')
    await startHelper(board, llm('no-json'), { fast: true }).finished
    assert.equal(board.state, 'done')
    assert.equal(board.brief.names.length, 5)
    assert.equal(board.caps.json, false)
  })

  test('a name that came back translated or misspelt is asked for once more, that line alone', async () => {
    const board = boardFor('names-slip')
    await startHelper(board, llm('names-slip'), { fast: true }).finished
    assert.equal(board.state, 'done')
    const requests = ai.callsOf('names-slip').map(call => JSON.parse(call.messages[1].content))
    assert.equal(requests.length, 4)
    const again = requests.find(request => request.note)
    // line 3, "I saw Mr. Stone in Paris.", is the only one where a name stands where only a name can
    assert.deepEqual(Object.keys(again.lines), ['3'])
    assert.match(again.note, /letter for letter/)
    assert.equal(board.out[2], `${fake(3)} السيد ستون باريس`)
    assert.equal(board.out[0], fake(1))   // "Hope, come over here." starts a sentence: not judged
  })

  test('a name that still comes back wrong is taken as it is: no third try', async () => {
    const board = boardFor('names-never')
    await startHelper(board, llm('names-never'), { fast: true }).finished
    assert.equal(board.state, 'done')
    assert.equal(ai.callsOf('names-never').length, 4)
    assert.equal(board.out[2], fake(3))
  })

  test('where a word can only be a name, and where nothing can be said', () => {
    const sure = [
      ['I saw Mr. Stone in Paris.', 'Paris'], ['I saw Mr. Stone in Paris.', 'Mr. Stone'], ['Wait for me, Hope!', 'Hope'],
      ['- Where is Hunter?\n- He went out with Grace.', 'Hunter'], ['- Where is Hunter?\n- He went out with Grace.', 'Grace'],
      ['<i>Tell Summer I am back.</i>', 'Summer'], ['He said "Hope is here" and Will laughed.', 'Will'],
    ]
    const open = [
      ['Hope is all we have left.', 'Hope'], ['- Hope is here.', 'Hope'], ['<i>Hope, wait.</i>', 'Hope'], ['It ended. Stone left.', 'Stone'],
      ['First line\nRose came back.', 'Rose'], ['MARY: Hope called.', 'Hope'], ['It is hopeless.', 'Hope'], ['They will stonewall us.', 'Stone'],
      ['we hope so', 'Hope'],
    ]
    for (const [line, name] of sure) assert.equal(surelyName(line, name), true, `${name} in ${JSON.stringify(line)}`)
    for (const [line, name] of open) assert.equal(surelyName(line, name), false, `${name} in ${JSON.stringify(line)}`)
  })

  test('how a name is looked for in the Arabic line', () => {
    const hope = [{ name: 'Hope', arabic: 'هوب', kind: 'woman' }], stone = [{ name: 'Mr. Stone', arabic: 'السيد ستون', kind: 'man' }]
    assert.equal(misnamed('Did you see Hope?', 'هل رأيت هوب؟', hope), false)
    assert.equal(misnamed('Did you see Hope?', 'هل رأيت أمل؟', hope), true)      // translated
    assert.equal(misnamed('Did you see Hope?', 'هل رأيت هووب؟', hope), true)     // spelt another way
    assert.equal(misnamed('Give it to Hope.', 'أعطه لهوب.', hope), false)        // with a letter joined in front
    assert.equal(misnamed('Ask Mr. Stone.', 'اسأل السيّد ستون.', stone), false)   // vowel marks do not matter
    assert.equal(misnamed('Ask Mr. Stone.', 'اسأل مستر ستون.', stone), false)    // the title may be worded freely; the name may not
    assert.equal(misnamed('Ask Mr. Stone.', 'اسأل السيد حجر.', stone), true)
    assert.equal(misnamed('Hope is all we have left.', 'الأمل كل ما بقي لنا.', hope), false)   // not judged: starts the sentence
    assert.equal(misnamed('Did you see Hope?', 'هل رأيت أمل؟', []), false)
    assert.equal(misnamed('I went to the hope chest.', 'ذهبت إلى الصندوق.', [{ name: 'hope', arabic: 'هوب', kind: 'other' }]), false)   // listed without a capital: not judged
  })

  test('a translation picked up again keeps the brief it had', async () => {
    const board = boardFor('ok-brief-kept', { brief: { names: [{ name: 'Hope', arabic: 'هوووب', kind: 'woman' }], terms: [] } })
    await startHelper(board, llm('ok-brief-kept'), { fast: true }).finished
    assert.equal(ai.briefsOf('ok-brief-kept').length, 0)
    assert.deepEqual(sentIn('ok-brief-kept', '1').names, { Hope: { arabic: 'هوووب', is: 'woman' } })
  })

  test('not wanted: not asked for', async () => {
    const board = boardFor('ok-no-brief', { wantBrief: false })
    await startHelper(board, llm('ok-no-brief'), { fast: true }).finished
    assert.equal(board.state, 'done')
    assert.equal(board.brief, null)
    assert.equal(ai.briefsOf('ok-no-brief').length, 0)
  })

  test("reading the model's brief", () => {
    assert.deepEqual(readBrief(JSON.stringify(BRIEF)).names.map(entry => entry.kind), ['woman', 'woman', 'man', 'place', 'other'])
    assert.deepEqual(readBrief(JSON.stringify(BRIEF)).terms, [{ term: 'the long road', arabic: 'الطريق الطويل' }])
    // wrapped in prose and fences
    assert.deepEqual(readBrief('Here you go:\n```json\n{"names":[{"name":"Cobb","arabic":"كوب","kind":"man"}],"terms":[]}\n```').names, [{ name: 'Cobb', arabic: 'كوب', kind: 'man' }])
    // cut off before its end: what is whole is kept
    assert.deepEqual(readBrief('{"names":[{"name":"Ann","arabic":"آن","kind":"woman"},{"name":"Bob","arabic":"بوب","kind":"man"},{"name":"Carl","ara').names.map(entry => entry.name), ['Ann', 'Bob'])
    // no Arabic, nothing at all, the same name twice, a wrong type: left out
    assert.deepEqual(readBrief('{"names":[{"name":"Ann","arabic":"Ann"},{"name":"","arabic":"آن"},{"name":"Bob","arabic":"بوب"},{"name":"BOB","arabic":"بووب"},{"name":7,"arabic":"سبعة"}]}').names, [{ name: 'Bob', arabic: 'بوب', kind: 'other' }])
    assert.deepEqual(readBrief('no idea'), { names: [], terms: [] })
    assert.deepEqual(readBrief(''), { names: [], terms: [] })
    const many = { names: Array.from({ length: 300 }, (_, i) => ({ name: `Name${i}`, arabic: 'اسم', kind: 'man' })), terms: Array.from({ length: 100 }, (_, i) => ({ term: `term ${i}`, arabic: 'مصطلح' })) }
    assert.equal(readBrief(JSON.stringify(many)).names.length, 120)
    assert.equal(readBrief(JSON.stringify(many)).terms.length, 30)
  })

  test('what the brief is made from: the whole of a short subtitle, evenly spaced runs of a long one', () => {
    const short = briefInput([{ text: 'One\nline' }, { text: 'Another' }])
    assert.deepEqual(short, { text: 'One line\nAnother', sampled: false })
    const long = Array.from({ length: 3000 }, (_, i) => ({ text: `Line ${i + 1} of a very long film, with enough words to weigh something.` }))
    const sample = briefInput(long)
    assert.equal(sample.sampled, true)
    assert.ok(sample.text.length > 30_000 && sample.text.length < 52_000, `${sample.text.length} characters`)
    assert.ok(sample.text.startsWith('Line 1 of'))
    assert.ok(sample.text.includes('\n[…]\n'))
    assert.ok(sample.text.includes('Line 3000 of'), 'the end is in it too')
  })

  test('both prompts carry the rule, with its examples', () => {
    for (const prompt of [systemPrompt({ from: 'English', about: 'a film' }), briefPrompt({ from: 'English', about: 'a film' }, false)]) {
      assert.match(prompt, /its meaning is never translated/)
      assert.match(prompt, /A woman called Hope is "هوب", never "أمل"/)
      assert.match(prompt, /even when it is also an ordinary word/)
      // someone called by what they are is not a name ("Old-timer" in anime subtitles), and no rule says that a word
      // people are called by is one
      assert.match(prompt, /A word that only says what someone is .* is not a name, with or without a capital letter and even when they are spoken to by it/)
      assert.match(prompt, /A nickname that someone goes by in the story is a name all the same \(Red, Baby\)/)
      assert.match(prompt, /"Who are you, Old-timer\?" → "من أنت أيها العجوز؟"/)
      assert.doesNotMatch(prompt, /used to call or address someone, is a name/)
      // the people of a known work by the names viewers know, and Japanese names spelt one way
      assert.match(prompt, /the way Arabic-speaking viewers know them \(Goku → غوكو/)
      assert.match(prompt, /a hard g is غ, ch is تش, ts is تس/)
      // Japanese honorifics stay, in Arabic letters
      assert.match(prompt, /A Japanese honorific after a name is kept, in Arabic letters, wherever the line has it: -san is سان, -kun is كن/)
    }
    assert.match(briefPrompt({ from: 'English', about: 'a film' }, false), /Leave out the words that only say what someone is and by which they are spoken to .*: they are not names\./)
    assert.match(systemPrompt({ from: 'English', about: 'a film' }), /for the gender of verbs, pronouns and adjectives/)
    assert.match(briefPrompt({ from: 'French', about: 'a film' }, true), /in French \(a sample of them/)
  })
})

describe('the name a translation is kept under', () => {
  test('32 hex characters, the same for the same parts, different when any part differs', async () => {
    const key = await cacheKey(['https://example/file/1', 'host', 'model', true, 1])
    assert.match(key, /^[0-9a-f]{32}$/)
    assert.equal(key, await cacheKey(['https://example/file/1', 'host', 'model', true, 1]))
    assert.notEqual(key, await cacheKey(['https://example/file/1', 'host', 'other-model', true, 1]))
    assert.notEqual(key, await cacheKey(['https://example/file/1', 'host', 'model', false, 1]))
  })
})

describe("what a provider's refusal means", () => {
  const kind = (status, body, retryAfter) => failure(status, typeof body === 'string' ? body : JSON.stringify(body), retryAfter).kind
  const flagged = 'Invalid prompt: your prompt was flagged as potentially violating our usage policy. Please try again with a different prompt: https://platform.openai.com/docs/guides/reasoning#advice-on-prompting'

  test('a filter that turned the request down for what it says', () => {
    // OpenAI. Its message ends in an address with the word "reasoning" in it, which must not be read as a refused request field
    assert.equal(kind(400, { error: { message: flagged, type: 'invalid_request_error', param: null, code: 'invalid_prompt' } }), 'content')
    // OpenRouter: moderation, then a guardrail
    assert.equal(kind(403, { error: { code: 403, message: 'openai/gpt-6-luna requires moderation on OpenAI. Your input was flagged for "violence".', metadata: { reasons: ['violence'], flagged_input: 'I will…' } } }), 'content')
    assert.equal(kind(403, { error: { code: 403, message: 'Request blocked: prompt injection patterns detected', metadata: { patterns: ['ignore all previous instructions'] } } }), 'content')
    // Azure, by code and by words
    assert.equal(kind(400, { error: { code: 'content_filter', message: 'The response was filtered.' } }), 'content')
    assert.equal(kind(400, { error: { message: "The response was filtered due to the prompt triggering Azure OpenAI's content management policy." } }), 'content')
  })

  test('a refused key or a closed account is not taken for it', () => {
    assert.equal(kind(403, { error: { message: 'You do not have access to this model' } }), 'fatal')
    assert.equal(kind(403, { error: { code: 403, message: 'Budget limit exceeded (weekly limit). $52.00 of $50.00 used', metadata: { limit_source: 'openrouter_key_limit' } } }), 'fatal')
    assert.equal(kind(401, { error: { message: 'Your account was flagged; the request was blocked' } }), 'fatal')
    assert.equal(kind(403, '<html>Sorry, you have been blocked</html>'), 'fatal')
  })

  test('a refused request field stays what it was', () => {
    assert.equal(kind(400, { error: { message: "Unsupported parameter: 'temperature' is not supported with this model.", param: 'temperature', code: null } }), 'shape')
    assert.equal(kind(400, { error: { message: "Unsupported value: 'reasoning_effort' does not support 'minimal' with this model.", param: 'reasoning_effort', code: 'unsupported_value' } }), 'shape')
    assert.equal(kind(400, { error: { message: "'messages' must contain the word 'json' in some form, to use 'response_format' of type 'json_object'." } }), 'shape')
  })

  test('an account with nothing left to spend: waiting does not help, though the status says "slow down"', () => {
    const spent = failure(429, JSON.stringify({ error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', param: null, code: 'insufficient_quota' } }))
    assert.equal(spent.kind, 'fatal')
    assert.match(spent.message, /رصيد/)
    assert.equal(kind(429, { error: { message: 'Your credit balance is exhausted.', code: 'credit_balance_exhausted' } }), 'fatal')
    // the same words from a provider that means "slow down" by them (Gemini's free allowance): it says when to come back
    const slow = failure(429, JSON.stringify([{ error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details.', status: 'RESOURCE_EXHAUSTED' } }]), 31)
    assert.equal(slow.kind, 'retry')
    assert.equal(slow.retryAfter, 31)
  })

  test('the rest as before', () => {
    assert.equal(kind(404, { error: { message: 'The model does not exist' } }), 'fatal')
    assert.equal(kind(402, { error: { message: 'Insufficient credits' } }), 'fatal')
    assert.equal(kind(402, { error: 'Free limit reached' }, 45), 'retry')
    assert.equal(kind(429, { error: { message: 'Rate limit reached' } }, 2), 'retry')
    assert.equal(kind(500, '<html>Bad gateway</html>'), 'retry')
    assert.match(failure(400, JSON.stringify([{ error: { code: 400, message: 'Invalid value at generation_config' } }])).message, /Invalid value at generation_config/)   // Gemini's list
  })
})

describe('a provider that turns down what a request says', () => {
  let ai
  before(async () => { ai = await startAi() })
  after(() => ai.close())

  // A subtitle whose lines at the given positions hold what the filter objects to
  const rough = (count, flagged) => Array.from({ length: count }, (_, i) => ({ start: i * 3, end: i * 3 + 2, text: flagged.includes(i) ? `Line number ${i + 1} is FLAGGED` : `Line number ${i + 1} of the test` }))
  const translate = async (model, count, flagged, { effort = '', concurrency = 3, wantBrief = false, budget, batchSize = 10 } = {}) => {
    const from = ai.callsOf(model).length, fromBriefs = ai.briefsOf(model).length
    const board = createBoard({ key: model, cues: rough(count, flagged), from: 'English', about: 'a test', batchSize, wantBrief })
    await startHelper(board, { baseUrl: ai.url, apiKey: 'secret-key', model, effort, concurrency }, { fast: true, budget }).finished
    return { board, calls: ai.callsOf(model).slice(from), briefs: ai.briefsOf(model).slice(fromBriefs) }
  }
  const linesOf = call => Object.keys(JSON.parse(call.messages[1].content).lines).map(id => Number(id) - 1)
  // every line translated, but those at the given positions, which are as they were written
  const assertAllBut = (board, asWritten) => {
    board.cues.forEach((cue, i) => assert.equal(board.out[i], asWritten.includes(i) ? cue.text : fake(i + 1), `line ${i + 1}`))
    assert.deepEqual([...board.asWritten].sort((a, b) => a - b), asWritten)
    assert.equal(board.translated, board.cues.length)
    assert.equal(board.unproven.size, 0)
  }

  for (const [model, how] of [['strict-openai', 'OpenAI: 400 invalid_prompt'], ['strict-openrouter', 'OpenRouter: 403 with the reasons'], ['strict-inband', 'an answer withheld by content_filter'], ['strict-declines', 'an answer that is a refusal']]) {
    test(`one line it objects to stays as written, the rest is translated (${how})`, async () => {
      const { board, calls } = await translate(model, 50, [22])
      assert.equal(board.state, 'done')
      assertAllBut(board, [22])
      // the batch of ten, then two lines of it, then the line: each request with the line in it is turned down, and no other
      const refused = calls.filter(call => call.turnedDown)
      assert.deepEqual(refused.map(call => linesOf(call).length), [10, 2, 1])
      assert.ok(refused.every(call => linesOf(call).includes(22)))
      assert.equal(calls.length, 5 + 5 + 2)
      // what a request field refusal would have cost is untouched
      assert.deepEqual(board.caps, { effort: false, temperature: true, json: true })
    })
  }

  test('its neighbours are not lost with it: the pieces go without the lines around them', async () => {
    // line 10 closes the first batch, so the second batch has it among the lines it is given to follow the conversation
    const { board, calls } = await translate('strict-edge', 50, [9])
    assert.equal(board.state, 'done')
    assertAllBut(board, [9])
    const refused = calls.filter(call => call.turnedDown)
    assert.equal(refused.filter(call => !linesOf(call).includes(9)).length, 1)   // the second batch, once
    const pieces = calls.filter(call => !call.turnedDown && linesOf(call).length < 10)
    assert.ok(pieces.length >= 5)
    for (const call of pieces) {
      const request = JSON.parse(call.messages[1].content)
      assert.deepEqual([request.context_before, request.context_after], [[], []])
    }
  })

  test('once it is known, the line is kept out of what the other requests are given', async () => {
    // one request at a time, and the line closes the second batch: it is settled before the third batch is asked for
    const { board, calls } = await translate('strict-one-by-one', 40, [19], { concurrency: 1 })
    assert.equal(board.state, 'done')
    assertAllBut(board, [19])
    const third = calls.find(call => linesOf(call).includes(20) && linesOf(call).length === 10)
    assert.equal(third.turnedDown, undefined)
    assert.deepEqual(JSON.parse(third.messages[1].content).context_before, ['Line number 17 of the test', 'Line number 18 of the test', 'Line number 19 of the test'])
    assert.equal(calls.filter(call => call.turnedDown).length, 3)
  })

  test('turned down before anything was answered: a few single lines are asked for first, and one answer is enough to go on', async () => {
    // one request at a time, and the line is in the first batch
    const { board, calls } = await translate('strict-first', 40, [9], { concurrency: 1 })
    assert.equal(board.state, 'done')
    assertAllBut(board, [9])
    assert.deepEqual([linesOf(calls[0]).length, calls[0].turnedDown], [10, true])
    // a line from further on, alone and without its neighbours; it is answered, and the others need not be asked
    const probe = JSON.parse(calls[1].messages[1].content)
    assert.deepEqual([Object.keys(probe.lines), probe.context_before, probe.context_after, calls[1].turnedDown], [['4'], [], [], undefined])
    assert.deepEqual(calls.filter(call => linesOf(call).length === 1).map(call => linesOf(call)[0]), [3, 8, 9])
    // what came back for it was not kept: the line is asked for again among its neighbours
    assert.equal(calls.filter(call => linesOf(call).includes(3)).length, 3)
    assert.deepEqual(calls.slice(2, 4).map(linesOf), [[0, 1], [2, 3]])
  })

  test('lines it objects to in every batch are not a provider that refuses the video', async () => {
    // fifteen batches and a line in each: every batch is turned down, and still it is lines, not the video
    const flagged = Array.from({ length: 15 }, (_, k) => 7 + k * 20)
    const { board, calls } = await translate('strict-all-over', 300, flagged, { batchSize: 20 })
    assert.equal(board.state, 'done')
    assertAllBut(board, flagged)
    assert.equal(calls.filter(call => linesOf(call).length === 20 && call.turnedDown).length, 15)
  })

  test('a line that was turned down alone is not sent again with its batch', async () => {
    // as after a single line came back turned down, and before anything was answered
    const board = createBoard({ key: 'strict-known', cues: rough(10, [2]), from: 'English', about: 'a test', batchSize: 10 })
    board.unproven.add(2)
    board.probe = { left: new Set() }
    await startHelper(board, { baseUrl: ai.url, apiKey: 'k', model: 'strict-known', effort: '', concurrency: 1 }, { fast: true }).finished
    assert.equal(board.state, 'done')
    assertAllBut(board, [2])
    const calls = ai.callsOf('strict-known')
    assert.equal(calls.length, 1)
    assert.deepEqual(linesOf(calls[0]), [0, 1, 3, 4, 5, 6, 7, 8, 9])
  })

  test('several such lines, far apart and side by side', async () => {
    const { board } = await translate('strict-several', 80, [0, 1, 37, 79])
    assert.equal(board.state, 'done')
    assertAllBut(board, [0, 1, 37, 79])
  })

  test('a provider that turns everything down: it stops soon, and not one line counts as translated', async () => {
    const saved = []
    const model = 'refuses-all'
    const board = createBoard({ key: model, cues: rough(50, []), from: 'English', about: 'a test', batchSize: 10 })
    await startHelper(board, { baseUrl: ai.url, apiKey: 'k', model, effort: '', concurrency: 3 }, { fast: true, onProgress: current => { saved.push(current.translated) } }).finished
    assert.equal(board.state, 'failed')
    assert.equal(board.fatal, true)
    assert.match(board.error, /كل ما أُرسل/)
    assert.match(board.error, /flagged as potentially violating/)
    assert.equal(board.translated, 0)
    assert.ok(board.out.every(line => line === undefined))
    assert.deepEqual([board.asWritten.size, board.unproven.size], [0, 0])
    assert.ok(saved.every(count => count === 0), 'nothing was ever there to save as translated')
    // three batches at once, then six single lines from all over the subtitle: all turned down. A batch or two more may
    // have left while the last of the six were out.
    const sent = () => ai.callsOf(model).map(call => Object.keys(JSON.parse(call.messages[1].content).lines).map(id => Number(id) - 1))
    assert.deepEqual(sent().slice(0, 3).map(lines => lines.length), [10, 10, 10])
    assert.deepEqual(sent().filter(lines => lines.length === 1).map(lines => lines[0]).sort((a, b) => a - b), [4, 12, 20, 29, 37, 45])
    assert.ok(sent().every(lines => lines.length === 1 || lines.length === 10), 'no batch was cut up')
    assert.ok(sent().length <= 11, `${sent().length} requests`)
    // asked again, it tries again, and stops as soon
    resumeBoard(board, 10)
    await startHelper(board, { baseUrl: ai.url, apiKey: 'k', model, effort: '', concurrency: 3 }, { fast: true }).finished
    assert.equal(board.state, 'failed')
    assert.equal(board.translated, 0)
    assert.equal(sent().filter(lines => lines.length === 1).length, 12)
    assert.ok(sent().every(lines => lines.length === 1 || lines.length === 10), 'no batch was cut up')
    assert.ok(sent().length <= 22, `${sent().length} requests`)
  })

  test('the same on three lines, as the settings page sends them: no "it works" over lines left in English', async () => {
    const { board, calls } = await translate('refuses-all-short', 3, [], { concurrency: 1 })
    assert.equal(board.state, 'failed')
    assert.match(board.error, /كل ما أُرسل/)
    assert.equal(board.translated, 0)
    assert.ok(board.out.every(line => line === undefined))
    assert.equal(calls.length, 4)   // the three together, then each alone
  })

  test('one line of three turned down: the other two are translated, and it is said to work', async () => {
    const { board, calls } = await translate('strict-short', 3, [0], { concurrency: 1 })
    assert.equal(board.state, 'done')
    assertAllBut(board, [0])
    assert.ok(calls.length <= 8, `${calls.length} requests`)   // what the settings page's test allows itself
  })

  test('slow answers are waited for before anything is concluded', async () => {
    // "lag": the model takes a while to answer, where the filter turns a request down at once. Six lines it objects to open
    // the film: cut up on its own, with nothing answered yet, the first batch alone would be twelve refusals in a row
    const { board, calls } = await translate('lag-strict', 40, [0, 1, 2, 3, 4, 5], { concurrency: 2 })
    assert.equal(board.state, 'done')
    assertAllBut(board, [0, 1, 2, 3, 4, 5])
    assert.ok(calls.filter(call => call.turnedDown).length >= 9)
  })

  test('too many lines turned down: the translation stops and says so, also when it is picked up again', async () => {
    const many = Array.from({ length: 13 }, (_, k) => 3 + k * 7)   // 13 of 100 lines, where 12 may stay as written
    const { board } = await translate('strict-many', 100, many)
    assert.equal(board.state, 'failed')
    assert.equal(board.asWritten.size, 13)
    assert.match(board.error, /13 سطرًا/)
    const before = ai.callsOf('strict-many').length
    resumeBoard(board, 10)
    await startHelper(board, { baseUrl: ai.url, apiKey: 'k', model: 'strict-many', effort: '', concurrency: 3 }, { fast: true }).finished
    assert.equal(board.state, 'failed')
    assert.equal(ai.callsOf('strict-many').length, before)
    // one fewer, and it is a translation
    const fewer = await translate('strict-fewer', 100, many.slice(1))
    assert.equal(fewer.board.state, 'done')
    assertAllBut(fewer.board, many.slice(1))
  })

  test('a translation picked up from what was saved knows which lines were left as written', async () => {
    const cues = rough(30, [9])
    const out = new Array(30)
    for (let i = 0; i < 10; i++) out[i] = i === 9 ? cues[9].text : fake(i + 1)
    const board = createBoard({ key: 'strict-saved', cues, out, asWritten: [9], from: 'English', about: 'a test', batchSize: 10 })
    assert.deepEqual([...board.asWritten], [9])
    await startHelper(board, { baseUrl: ai.url, apiKey: 'k', model: 'strict-saved', effort: '', concurrency: 3 }, { fast: true }).finished
    assert.equal(board.state, 'done')
    assertAllBut(board, [9])
    assert.equal(ai.callsOf('strict-saved').length, 2)   // nothing was turned down: the line was not sent along
  })

  test('the brief: the part of the subtitle it objects to is left out, and the names of the rest are kept', async () => {
    const { board, calls, briefs } = await translate('strict-brief', 40, [12], { wantBrief: true })
    assert.equal(board.state, 'done')
    assertAllBut(board, [12])
    // the whole, then its four quarters: the one with the line in it is turned down, and left at that
    assert.equal(briefs.length, 5)
    assert.equal(briefs.filter(call => call.turnedDown).length, 2)
    assert.deepEqual(board.brief.names.map(entry => entry.name), BRIEF.names.map(entry => entry.name))
    assert.deepEqual(board.brief.terms, BRIEF.terms)
    assert.equal(board.briefDraft, null)
    assert.equal(calls.length, 4 + 5 + 2)
  })

  test('a brief turned down in every part: the translation goes ahead without it', async () => {
    const { board, briefs } = await translate('refuses-everything-brief-only', 20, [], { wantBrief: true })
    // every request is turned down here, the batches too: what matters is that the brief ended, and did not hold them up
    assert.deepEqual(board.brief, { names: [], terms: [] })
    assert.equal(briefs.length, 5)
    assert.equal(board.state, 'failed')
    assert.match(board.error, /كل ما أُرسل/)
  })

  test("OpenAI's models as they answer today: no temperature while they think, then the filter", async () => {
    const low = await translate('openai-5.6-terra', 50, [22], { effort: 'low' })
    assert.equal(low.board.state, 'done')
    assertAllBut(low.board, [22])
    assert.deepEqual(low.board.caps, { effort: true, temperature: false, json: true })
    const through = low.calls.filter(call => !call.turnedDown && call.temperature === undefined)
    assert.ok(through.length >= 5 && through.every(call => call.reasoning_effort === 'low' && call.response_format))
    // "minimal" is not an effort they know: it is dropped, and they think as much as they do by default
    const minimal = await translate('openai-5.6-luna', 50, [22], { effort: 'minimal' })
    assert.equal(minimal.board.state, 'done')
    assertAllBut(minimal.board, [22])
    assert.deepEqual(minimal.board.caps, { effort: false, temperature: false, json: true })
  })

  test('an account with nothing left to spend stops at once, and says so', async () => {
    const { board, calls } = await translate('no-quota', 30, [])
    assert.equal(board.state, 'failed')
    assert.equal(board.fatal, true)
    assert.match(board.error, /رصيد/)
    assert.ok(calls.length <= 3, `${calls.length} requests`)
  })
})

describe('the wrong-episode guard', () => {
  test('reading season and episode from the id', () => {
    assert.deepEqual(parseVideoId('tt2560140:3:12'), { imdb: 'tt2560140', season: 3, episode: 12 })
    assert.deepEqual(parseVideoId('tt1375666'), { imdb: 'tt1375666', season: null, episode: null })
    assert.equal(parseVideoId('kitsu:123'), null)
    assert.equal(parseVideoId(''), null)
  })

  test('markers in release names', () => {
    assert.deepEqual(markersIn('Some.Show.S03E12.1080p.WEB'), [{ season: 3, episode: 12 }])
    assert.deepEqual(markersIn('Show.3x12.1080p'), [{ season: 3, episode: 12 }])
    assert.deepEqual(markersIn('الموسم ٣ الحلقة ١٢'), [{ season: 3, episode: 12 }])
    assert.deepEqual(markersIn('Show.Season.2.Episode.7.1080p'), [{ season: 2, episode: 7 }])
    assert.deepEqual(markersIn('1920x1080.S03.E12'), [{ season: 3, episode: 12 }])   // the resolution never passes for an episode
    assert.deepEqual(markersIn('Show.1080p.WEB'), [])
  })

  test('the verdict', () => {
    const want = { imdb: 'tt2560140', season: 3, episode: 12 }
    assert.equal(verdictFor('Show.S03E12.1080p', want), 'same')
    assert.equal(verdictFor('Show.s03e12.1080p', want), 'same')
    assert.equal(verdictFor('Show.S03E10-E12.1080p', want), 'same', 'a range carries this episode')
    assert.equal(verdictFor('Show.S03E11.1080p', want), 'wrong')
    assert.equal(verdictFor('Show.S02E12.1080p', want), 'wrong', 'same episode, wrong season')
    assert.equal(verdictFor('Show.S03.1080p', want), 'unknown')
  })

  test('an episode name is a witness for, never against', () => {
    const want = { imdb: 'tt2560140', season: 3, episode: 12 }
    assert.equal(byName('Attack.on.Titan.The.Long.Road.1080p.WEB', want, 'the long road'), 'same')
    assert.equal(byName('Attack.on.Titan.1080p.WEB', want, 'the long road'), 'unknown')
    assert.equal(byName('Attack.on.Titan.1080p.WEB', want, ''), 'unknown')
    assert.equal(byName('Attack.on.Titan.1080p.WEB', want), 'unknown')
  })

  test('the lines inside the file convict only on explicit markers', () => {
    const want = { imdb: 'tt2560140', season: 3, episode: 12 }
    assert.equal(embeddedVerdict([{ start: 0, end: 1, text: 'S03E12' }], want), 'same')
    assert.equal(embeddedVerdict([{ start: 0, end: 1, text: 'الحلقة ١١ من الموسم الثالث' }], want), 'unknown')   // no season+episode pair, no verdict
    assert.equal(embeddedVerdict([{ start: 0, end: 1, text: 'S03E11' }], want), 'wrong')
    assert.equal(embeddedVerdict([{ start: 0, end: 1, text: 'Attack on Titan' }], want), 'unknown')
  })
})


describe('a show’s own name dictionary (ideas 14 + 17)', () => {
  const series = [
    { name: 'Mary', native: 'メアリー', arabic: 'ماريا', kind: 'woman' },
    { name: 'Zoro', native: 'ゾロ', arabic: '', kind: 'man' },
    { name: 'Cindy', native: 'シンディ', arabic: '', kind: 'other' },
  ]

  test('the stored spelling and gender win, every time', () => {
    const merged = applySeriesNames({ name: 'Mary', arabic: 'ماري', kind: 'man' }, series)
    assert.deepEqual(merged.entry, { name: 'Mary', arabic: 'ماريا', kind: 'woman' })
    assert.equal(merged.learned, null, 'a name with a stored spelling teaches nothing')
  })

  test('a spelling that is not in the store is passed on to be kept', () => {
    const merged = applySeriesNames({ name: 'Zoro', arabic: 'زورو', kind: 'man' }, series)
    assert.equal(merged.entry.arabic, 'زورو', 'used this once')
    assert.deepEqual(merged.learned, { name: 'Zoro', arabic: 'زورو', kind: 'man' })
  })

  test('a name the show does not know is left to the model', () => {
    const merged = applySeriesNames({ name: 'Someone Else', arabic: 'آخر', kind: 'woman' }, series)
    assert.deepEqual(merged.entry, { name: 'Someone Else', arabic: 'آخر', kind: 'woman' })
    assert.equal(merged.learned, null)
    assert.equal(applySeriesNames({ name: 'Mary', arabic: 'ماري' }, []).entry.arabic, 'ماري', 'no table at all: behaves as before')
    assert.equal(applySeriesNames({ name: 'Cindy', arabic: 'سيندي', kind: 'woman' }, series).entry.kind, 'woman', 'the database did not know the gender; the brief may')
  })

  test('a single first name finds the one stored name it starts', () => {
    const list = [
      { name: 'Eren Yeager', native: '', arabic: '', kind: 'man' },
      { name: 'Mikasa Ackerman', native: '', arabic: '', kind: 'woman' },
    ]
    const merged = applySeriesNames({ name: 'Eren', arabic: 'إيرين', kind: 'man' }, list)
    assert.equal(merged.entry.arabic, 'إيرين')
    assert.deepEqual(merged.learned, { name: 'Eren Yeager', arabic: 'إيرين', kind: 'man' }, 'the spelling lands on the full stored name')
    const untouched = applySeriesNames({ name: 'Ackerman', arabic: 'أكرمان', kind: 'woman' }, list)
    assert.equal(untouched.learned, null, 'a surname with two carriers is left to the model')
  })

  test('a single first name matches only when it is unambiguous', () => {
    const list = [
      { name: 'Eren Yeager', arabic: 'إيرين', kind: 'man' },
      { name: 'Eren Ximenes', arabic: 'إرين', kind: 'man' },
    ]
    const merged = applySeriesNames({ name: 'Eren', arabic: 'إيرين ييجر', kind: 'man' }, list)
    assert.equal(merged.entry.arabic, 'إيرين ييجر', 'two matching stored names: the model decides')
    assert.equal(merged.learned, null)
  })

  test('an exact stored name beats the first-name match', () => {
    const list = [
      { name: 'Eren', arabic: 'إرين', kind: 'man' },
      { name: 'Eren Yeager', arabic: 'إيري', kind: 'man' },
    ]
    assert.equal(applySeriesNames({ name: 'eren', arabic: 'ايرين', kind: 'woman' }, list).entry.arabic, 'إرين')
  })

  test('what is learned is kept beside the dictionary, without touching what was there', async () => {
    const kept = { names: [
      { name: 'Mary', arabic: 'ماريا', kind: 'woman' },
      { name: 'Zoro', arabic: '', kind: 'man' },
      { name: 'Cindy', arabic: '', kind: 'other' },
    ] }
    let stored = null
    const store = { getNames: async () => kept, putNames: async (key, data) => { stored = data } }
    const learned = await learnSeriesNames('tt0000204', [
      { name: 'Zoro', arabic: 'زورو', kind: 'woman' },   // gender is kept as learned only to fill the gap of 'other'; kind stays 'man'
      { name: 'Cindy', arabic: 'سيندي', kind: 'woman' },
    ], store)
    assert.equal(learned, 2)
    assert.equal(stored.names[1].arabic, 'زورو')
    assert.equal(stored.names[1].kind, 'man')
    assert.equal(stored.names[2].kind, 'woman', 'an unknown gender is filled from the brief')
    assert.equal(stored.names[0].arabic, 'ماريا', 'the first spelling stays')
  })

  test('a store that fails costs nothing', async () => {
    const learned = await learnSeriesNames('tt1', [{ name: 'Mary', arabic: 'ماري' }], { getNames: async () => { throw new Error('down') }, putNames: async () => { throw new Error('down') } })
    assert.equal(learned, 0)
  })
})


describe('an opening theme is left as it was written, not translated (idea 5)', () => {
  const song = i => ({ start: i * 4, end: i * 4 + 2.5, text: `♪ line ${i} of the theme ♪` })
  const dialog = i => ({ start: i * 4, end: i * 4 + 2.5, text: `Dialogue line ${i}` })

  test('a run of at least three lyric cues is skipped; the rest is sent', () => {
    const cues = [dialog(0), ...[10, 11, 12, 13].map(song), dialog(20)]
    const board = createBoard({ key: 'k1', cues, from: 'English', about: 'a show', batchSize: 40 })
    assert.deepEqual(board.cues.map(cue => cue.text), cues.map(cue => cue.text))
    for (const i of [1, 2, 3, 4]) assert.equal(board.out[i], cues[i].text)
    assert.deepEqual([...board.asWritten].sort(), [1, 2, 3, 4])
    assert.equal(board.song, 4)
    assert.equal(board.translated, 4)
    const waiting = []
    for (let i = 0; i < board.out.length; i++) if (board.out[i] === undefined) waiting.push(i)
    assert.deepEqual(waiting, [0, 5])
  })

  test('two song lines in a row are not enough to call it a theme', () => {
    const cues = [dialog(0), song(10), song(11), dialog(20)]
    const board = createBoard({ key: 'k2', cues, from: 'English', about: 'a show', batchSize: 40 })
    for (let i = 0; i < board.out.length; i++) assert.equal(board.out[i], undefined)
    assert.equal(board.song || 0, 0)
  })

  test('a theme split by a spoken line restarts the run', () => {
    const cues = [song(1), song(2), dialog(3), song(4), song(5), song(6), song(7)]
    const board = createBoard({ key: 'k3', cues, from: 'English', about: 'a show', batchSize: 40 })
    assert.deepEqual([...board.asWritten].sort(), [3, 4, 5, 6])
    assert.deepEqual([0, 1, 2, 6].map(i => board.out[i]), [undefined, undefined, undefined, cues[6].text])
  })

  test('isSongCue looks for a music note, not for emptiness', () => {
    assert.equal(isSongCue('♪ Hello ♪'), true)
    assert.equal(isSongCue('<i>♪ Hello ♪</i>'), true)
    assert.equal(isSongCue('no notes here'), false)
  })
})

describe('the translator’s notes (idea 27)', () => {
  test('reading the model’s answer: an array of notes, at most three, clean and bounded', () => {
    assert.deepEqual(readNotes('no array here'), [])
    assert.deepEqual(readNotes('{"not": "an array"}'), [])
    assert.deepEqual(readNotes('[]'), [])
    const many = JSON.stringify([
      { find: 'الأول', note: 'ملاحظة' }, { find: 'الثاني', note: 'ملاحظة' },
      { find: 'الثالث', note: 'ملاحظة' }, { find: 'الرابع', note: 'ملاحظة' },
    ])
    assert.equal(readNotes(many).length, 3)
    assert.deepEqual(readNotes('[{"find": "فقط", "note": "واحدة"}]'), [{ find: 'فقط', note: 'واحدة' }])
    assert.deepEqual(readNotes('[{"find": "", "note": "ما لها anchor"}]'), [])
    const long = 'x'.repeat(200)
    const [note] = readNotes(JSON.stringify([{ find: long, note: long }]))
    assert.equal(note.find.length, 120)
    assert.equal(note.note.length, 80)
    // wrapped in prose or cut off mid-array still gives the whole first notes
    assert.deepEqual(readNotes('إليك الملاحظات: [{"find": "ترجمة 3", "note": "نكتة"}] انتهيت'), [{ find: 'ترجمة 3', note: 'نكتة' }])
  })

  test('anchoring a note on the line it asks for, wherever the diacritics differ', () => {
    const cues = [{ start: 10, end: 20, text: 'x' }, { start: 30, end: 40, text: 'x' }]
    const out = ['السَّلامُ عليكم ورحمة الله', 'نَشُكُر الطَّريق الطَّويل']
    const [note] = anchorNotes([{ find: 'نشكر الطريق الطويل', note: 'نكتة عن الرحلة' }], cues, out)
    assert.equal(note.start, 30)
    assert.equal(note.end, Math.min(30 + 5, 40 + 4))
    assert.equal(note.text, 'ملاحظة المترجم: نكتة عن الرحلة')
    // diacritics and direction marks on the find side do not stop the match
    const [note2] = anchorNotes([{ find: '\u200Fالسَّلامُ', note: 'تحية' }], cues, out)
    assert.equal(note2.start, 10)
    // a phrase that occurs in no line is dropped, never guessed
    assert.deepEqual(anchorNotes([{ find: 'عبارة غير موجودة أصلًا هنا', note: 'تختفي' }], cues, out), [])
    // at most three notes survive, in the order the model gave them
    const anchored = anchorNotes([
      { find: 'السلام', note: '١' }, { find: 'نشكر', note: '٢' },
      { find: 'الطويل', note: '٣' }, { find: 'ورحمة', note: '٤' },
    ], cues, out)
    assert.equal(anchored.length, 3)
    assert.deepEqual(anchored.map(note => note.text), ['ملاحظة المترجم: ١', 'ملاحظة المترجم: ٢', 'ملاحظة المترجم: ٣'])
  })

  test('a note is never longer than the line it explains, on screen for at most five seconds', () => {
    const cues = [{ start: 100, end: 100.04, text: 'x' }]
    const out = ['نشكر الطريق']
    const [note] = anchorNotes([{ find: 'نشكر الطريق', note: 'قصيرة' }], cues, out)
    assert.ok(note.end - note.start <= 5.5)
  })
})

describe('the monthly report (idea 38)', () => {
  test('the ledger adds itself up, and an empty month reads as zeros', () => {
    assert.deepEqual(mergeReport(null, {}), { episodes: 0, tv: 0, film: 0, lines: 0, requests: 0, tokensP: 0, tokensC: 0, withUsage: 0, hits: 0 })
    const one = mergeReport(null, { episodes: 1, tv: 1, lines: 40, requests: 3, tokensP: 100, tokensC: 200, withUsage: 1 })
    const two = mergeReport(one, { episodes: 2, film: 2, lines: 10, requests: 1, tokensP: 5, tokensC: 7, withUsage: 1, hits: 4 })
    assert.deepEqual(two, { episodes: 3, tv: 1, film: 2, lines: 50, requests: 4, tokensP: 105, tokensC: 207, withUsage: 2, hits: 4 })
    assert.equal(mergeReport(undefined, { hits: 2 }).hits, 2)
  })

  test('the month key is the current month, the report page renders numbers or the honest absence of them', () => {
    assert.match(monthKey(), /^\d{4}-(0[1-9]|1[0-2])$/)
    const empty = reportHtml(null, 'نوفمبر 2026')
    assert.match(empty, /ما في شي لهذا الشهر/)
    const page = reportHtml({ episodes: 2, tv: 1, film: 1, lines: 1530, requests: 12, tokensP: 120000, tokensC: 34000, withUsage: 12, hits: 5 }, 'نوفمبر 2026')
    assert.match(page, /نوفمبر 2026/)
    assert.match(page, /التوكنز/)
    assert.match(page, /خُدمت/)
    assert.ok(page.length > 500 && page.includes('<html'))
    const noUsage = reportHtml({ episodes: 1, tv: 0, film: 1, lines: 10, requests: 1, tokensP: 0, tokensC: 0, withUsage: 0, hits: 0 }, 'نوفمبر 2026')
    assert.match(noUsage, /ما يرسل إحصاءات/)
  })
})

describe('سقوف الحجم على الخطة المجانية', () => {
  test('content-length كبير يُرفض قبل لمس الجسم', async () => {
    const response = new Response('x'.repeat(10), { headers: { 'content-length': String(MAX_SUBTITLE_BYTES + 1) } })
    await assert.rejects(readTextLimited(response), /الحد المسموح/)
  })

  test('التدفق يتوقف عند تجاوز السقف ولا يُخزّن الملف كاملاً', async () => {
    const response = new Response('x'.repeat(MAX_SUBTITLE_BYTES + 100))
    await assert.rejects(readLimited(response), /الحد المسموح/)
  })

  test('ملف صحيح ضمن السقف يُقرأ كاملاً', async () => {
    const response = new Response('مرحباً بالعالم')
    assert.equal(await readTextLimited(response), 'مرحباً بالعالم')
  })

  test('حزمة تعلن حجماً خادعاً تُرفض قبل فك الضغط', () => {
    const bomb = zipSync({ 'big.srt': strToU8('A'.repeat(5_000_000)) })
    assert.ok(bomb.byteLength < 100_000, 'الحزمة المضغوطة صغيرة لكنها تدّعي 5 MB')
    assert.throws(() => unzipSubtitle(Buffer.from(bomb)), /الحزمة|الحد المسموح/)
  })
})

describe('مهلة المصادر الإضافية', () => {
  test('ما وصل قبل المهلة يُعرض، والمصدر المعلّق لا يعطّل القائمة', async () => {
    const started = Date.now()
    const slow = new Promise(() => {})            // مصدر لا يرد أبداً
    const values = await settleWithin([Promise.resolve([{ url: 'a' }]), Promise.reject(new Error('x')), slow], 40)
    assert.deepEqual(values, [[{ url: 'a' }]])
    assert.ok(Date.now() - started < 500, 'يجب ألا ننتظر المصدر المعلّق')
  })

  test('كل المصادر ترد قبل المهلة ⇒ لا نفقد شيئاً', async () => {
    const values = await settleWithin([Promise.resolve([1]), Promise.resolve([2])], 1000)
    assert.equal(values.flat().length, 2)
  })
})

describe('حزم الحلقات (1–13 في ملف واحد)', () => {
  const stamp = seconds => {
    const ms = Math.round(seconds * 1000)
    const pad = (n, w = 2) => String(n).padStart(w, '0')
    return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
  }
  // Each episode lasts 10 minutes: 60 cues × 10 s. In a reset pack every episode starts again at 00:00.
  const packSrt = ({ episodes = 3, per = 60, continuous = false, lang = 'eng' } = {}) =>
    Array.from({ length: episodes * per }, (_, i) => {
      const episode = Math.floor(i / per) + 1
      const line = i % per
      const start = (continuous ? (episode - 1) * 600 : 0) + line * 10
      const text = lang === 'ara' ? `سطر ${episode} رقم ${line}` : `PART${episode} LINE ${line}`
      return `${i + 1}\n${stamp(start)} --> ${stamp(start + 2.5)}\n${text}\n`
    }).join('\n')

  test('القراءة بترتيب الملف تحفظ حدود الحلقات، والقراءة المرتّبة تدمجها', () => {
    const raw = packSrt({ episodes: 3 })
    const ordered = parseSubtitle(raw, { ordered: true })
    const sorted = parseSubtitle(raw)
    assert.equal(ordered.length, sorted.length)
    assert.ok(ordered[0].text.startsWith('PART1'))
    assert.ok(ordered.at(-1).text.startsWith('PART3'))
    assert.ok(sorted.every((cue, i) => i === 0 || sorted[i - 1].start <= cue.start), 'default parse is time-sorted')
    assert.ok(ordered.some((cue, i) => i > 0 && cue.start < ordered[i - 1].start), 'file order keeps the restarts')
  })

  test('اسم الحزمة يُقرأ كمدى، ولا يُحكم عليه كحلقة خاطئة', () => {
    assert.deepEqual(packRange('Overlord.S01E01-E13.1080p.WEB-PACK'), { season: 1, from: 1, to: 13 })
    assert.deepEqual(packRange('Overlord.1-13.Complete.BluRay'), { season: null, from: 1, to: 13 })
    assert.equal(packRange('Some.Show.S01E03.1080p'), null)
    assert.equal(packRange('Some.Film.2020.1080p.BluRay'), null)
    const want = { imdb: 'tt1234567', season: 1, episode: 3 }
    assert.equal(verdictFor('Overlord.S01E01-E13.1080p', want), 'same', 'E03 is inside the pack')
    assert.equal(byName('Overlord.S01E01-E13.1080p', want, ''), 'same')
    assert.equal(verdictFor('Overlord.S02E01-E13.1080p', want), 'wrong', 'another season is still wrong')
  })

  test('حزمة تُعيد التوقيت: تُفصل الحلقة 3 وحدها ويُصفّر توقيتها', () => {
    const cues = parseSubtitle(packSrt({ episodes: 3 }), { ordered: true })
    const result = selectEpisode(cues, { id: 'tt1234567:1:3', name: 'Overlord.S01E01-E03.1080p.WEB-PACK' })
    assert.equal(result.pack, true)
    assert.equal(result.ok, true)
    assert.equal(result.method, 'reset')
    assert.equal(result.confidence, 'high')
    assert.equal(result.episode, 3)
    assert.equal(result.parts, 3)
    assert.equal(result.cues.length, 60)
    assert.equal(result.cues[0].start, 0)
    assert.ok(result.cues.every(cue => cue.text.startsWith('PART3 ')), 'no episode 1 or 2 lines')
    assert.ok(result.cues.at(-1).end < 700)
  })

  test('حزمة متصلة التوقيت مع اسم 1–13: تُقسّم زمنياً للحلقة المطلوبة', () => {
    const cues = parseSubtitle(packSrt({ episodes: 13, continuous: true }), { ordered: true })
    assert.ok(cues.length >= PACK_MIN_CUES)
    const result = selectEpisode(cues, { id: 'tt1234567:1:3', name: 'Overlord.S01E01-E13.1080p.WEB-PACK' })
    assert.equal(result.ok, true)
    assert.equal(result.method, 'division')
    assert.equal(result.parts, 13)
    assert.equal(result.cues.length, 60)
    assert.ok(result.cues.every(cue => cue.text.startsWith('PART3 ')))
    assert.ok(result.cues[0].start < 3, 'the requested episode is re-based to its own zero')
  })

  test('عناوين «Episode N» داخل الملف تفصل الحزمة المتصلة بلا اسم مدى', () => {
    const raw = packSrt({ episodes: 6, continuous: true, per: 60 })
    const withHeaders = raw.replace(/PART(\d) LINE 0\n/g, 'Episode $1\n')
    const cues = parseSubtitle(withHeaders, { ordered: true })
    assert.equal(episodeLabel('Episode 3'), 3)
    assert.equal(episodeLabel('第4話'), 4)
    const result = selectEpisode(cues, { id: 'tt1234567:1:2' })
    assert.equal(result.ok, true)
    assert.equal(result.method, 'labels')
    assert.ok(result.cues.every(cue => !cue.text.startsWith('PART1 ')))
    assert.ok(result.cues.some(cue => cue.text.startsWith('PART2 ')))
  })

  test('فيلم طويل بلا دليل حلقات لا يُرفض بالخطأ', () => {
    const cues = Array.from({ length: 200 }, (_, i) => ({ start: i * 20, end: i * 20 + 3, text: `Scene ${i}` }))
    const result = selectEpisode(cues, { id: 'tt1234567', name: 'A.Long.Film.2020.1080p.BluRay' })
    assert.equal(result.pack, false)
    assert.equal(result.cues.length, 200)
  })

  test('حزمة لفيلم، أو حلقة خارج المدى، أو خيار معطّل ⇒ رفض واضح لا ترجمة خاطئة', () => {
    const cues = parseSubtitle(packSrt({ episodes: 3 }), { ordered: true })
    const movie = selectEpisode(cues, { id: 'tt1234567', name: 'Overlord.S01E01-E03.1080p' })
    assert.equal(movie.ok, false); assert.equal(movie.reason, 'movie')
    const missing = selectEpisode(cues, { id: 'tt1234567:1:9', name: 'Overlord.S01E01-E03.1080p' })
    assert.equal(missing.ok, false); assert.equal(missing.reason, 'out-of-range')
    const off = selectEpisode(cues, { id: 'tt1234567:1:3', name: 'Overlord.S01E01-E03.1080p', enabled: false })
    assert.equal(off.ok, false); assert.equal(off.reason, 'disabled')
    for (const failure of [movie, missing, off]) assert.match(packNotice(failure), /ترجمان/)
  })
})
