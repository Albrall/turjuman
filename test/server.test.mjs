// The addon as a player sees it, over HTTP, on the Node server, with stand-ins for the AI provider and the subtitles source.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { encodeConfig, encodeText } from '../lib/config.mjs'
import { parseSubtitle, tidy } from '../lib/subs.mjs'
import { ROUGH, fake, sampleSrt, startAi, startAniList, startJimaku, startKitsu, startSource, startSubdl } from './mocks.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const RLM = '\u200F'
const expected = tidy(parseSubtitle(sampleSrt()))   // the lines a translation of the made-up subtitle must have
const BATCHES = Math.ceil(expected.length / 40)

let ai, source, anilist, kitsu, subdl, jimaku, app, base

before(async () => {
  ai = await startAi()
  source = await startSource()
  anilist = await startAniList()
  kitsu = await startKitsu()
  subdl = await startSubdl()
  jimaku = await startJimaku()
  Object.assign(process.env, {
    SUBS_SOURCE: source.url, META_SOURCE: source.url, SUBS_ALLOW: '^http://127\\.0\\.0\\.1:\\d+/', ANILIST_URL: anilist.url, KITSU_URL: kitsu.url, SUBDL_URL: subdl.url, JIMAKU_URL: jimaku.url,
    ALLOW_LOCAL_AI: '1', TRUST_PROXY: '1', FAST_RETRIES: '1', RETRY_COOLDOWN_MS: '0', QUIET: '1', TEST_TIMEOUT_MS: '5000', TRICKLE_MS: '500',
    CONFIRM_GAP_MS: '250', CONFIRM_WINDOW_MS: '1500',
    CACHE_DIR: await mkdtemp(join(tmpdir(), 'tarjuman-test-')),
  })
  const { createApp } = await import('../server.mjs')
  app = createApp()
  await new Promise(resolve => app.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${app.address().port}`
})

after(async () => {
  app.closeAllConnections()
  await new Promise(resolve => app.close(resolve))
  await ai.close()
  await source.close()
  await anilist.close()
  await kitsu.close()
  await subdl.close()
  await jimaku.close()
})

// nm (reading the subtitle first, for its names) is off here, so that each test counts only the requests it is about
// cf (translate only when picked a second time) is off as well, and has tests of its own
const settings = (model, extra = {}) => encodeConfig({ b: ai.url, k: 'secret-key', m: model, src: 'eng', any: 1, warm: 0, cf: 0, sdh: 1, nm: 0, nt: 0, n: 2, wait: 3, bs: 40, cc: 2, ...extra })
const get = (path, options) => fetch(`${base}${path}`, options)
const listed = async (cfg, title, options) => (await (await get(`/${cfg}/subtitles/${title}.json`, options)).json()).subtitles
const callsOf = model => ai.callsOf(model).length
const link = ref => encodeText(JSON.stringify(ref))
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const COMPLETE = 'public, max-age=86400'
const HELD = 'no-store, no-transform'

// A track as { top: a note at the top of the screen, text }. Blank lines between cues may be many: a held answer adds them.
const read = vtt => {
  assert.ok(vtt.startsWith('WEBVTT\n\n'), 'starts as WebVTT')
  return vtt.slice(8).trim().split(/\n{2,}/).filter(Boolean).map(block => {
    const [timing, ...lines] = block.split('\n')
    assert.match(timing, /^\d\d:\d\d:\d\d\.\d{3} --> \d\d:\d\d:\d\d\.\d{3}( line:0)?$/)
    return { top: timing.endsWith(' line:0'), text: lines.join('\n') }
  })
}
const track = async (url, options) => {
  const response = await fetch(url, options)
  const cues = read(await response.text())
  return { response, kept: response.headers.get('cache-control'), notes: cues.filter(cue => cue.top), lines: cues.filter(cue => !cue.top).map(cue => cue.text) }
}
const translated = index => RLM + fake(index + 1)
const assertAllArabic = lines => assert.deepEqual(lines, expected.map((_, i) => translated(i)))
const countArabic = lines => lines.filter((line, i) => line === translated(i)).length
const untilComplete = async url => {
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await track(url)
    if (result.kept === COMPLETE) return result
    await pause(300)
  }
  assert.fail('the translation never completed')
}

describe('what a player asks first', () => {
  test('the manifest, before and after settings', async () => {
    const bare = await get('/manifest.json')
    assert.equal(bare.headers.get('access-control-allow-origin'), '*')
    assert.match(bare.headers.get('content-type'), /application\/json/)
    const plain = await bare.json()
    assert.equal(plain.behaviorHints.configurationRequired, true)
    assert.equal(plain.behaviorHints.configurable, true)
    assert.deepEqual(plain.resources, ['subtitles'])
    assert.deepEqual(plain.types, ['movie', 'series'])
    assert.deepEqual(plain.catalogs, [])
    assert.deepEqual(plain.idPrefixes, ['tt', 'kitsu', 'mal', 'anilist'])
    assert.equal(plain.logo, `${base}/logo.png`)
    for (const field of ['id', 'version', 'name', 'description']) assert.ok(plain[field], field)

    const configured = await (await get(`/${settings('ok')}/manifest.json`)).json()
    assert.equal(configured.behaviorHints.configurationRequired, false)
    assert.equal(configured.id, plain.id)
  })

  test('the settings page, the logo, a health check', async () => {
    for (const path of ['/', '/configure', `/${settings('ok')}/configure`]) {
      const response = await get(path)
      assert.equal(response.status, 200, path)
      assert.match(response.headers.get('content-type'), /text\/html/)
      assert.match(await response.text(), /<html lang="ar" dir="rtl">/)
    }
    const logo = await get('/logo.png')
    assert.equal(logo.headers.get('content-type'), 'image/png')
    assert.deepEqual([...new Uint8Array(await logo.arrayBuffer()).slice(0, 4)], [0x89, 0x50, 0x4e, 0x47])
    assert.deepEqual(await (await get('/health')).json(), { ok: true, version: '0.9.8' })
  })

  test("the operator's notice on the settings page, when there is one", async () => {
    const plain = await (await get('/')).text()
    assert.ok(!plain.includes('role="alert"') && !plain.includes('<!--NOTICE-->'))
    process.env.NOTICE = 'معاينة <b>مؤقتة</b> & "تجربة"'
    try {
      const noted = await (await get('/configure')).text()
      assert.ok(noted.includes('<p class="notice warn" role="alert">معاينة &#60;b&#62;مؤقتة&#60;/b&#62; &#38; &#34;تجربة&#34;</p>'))
      assert.ok(!noted.includes('<b>مؤقتة</b>'))
    } finally {
      delete process.env.NOTICE
    }
  })

  test('what the server can do: it keeps translations, and reaches the subtitles source', async () => {
    const response = await get('/api/status')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const status = await response.json()
    assert.deepEqual({ ...status, source: { ...status.source, ms: 0 } }, { ok: true, version: '0.9.8', runtime: 'node', storage: 'disk', source: { ok: true, status: 200, ms: 0 } })
    process.env.SUBS_SOURCE = 'http://127.0.0.1:9'
    try {
      assert.deepEqual((await (await get('/api/status')).json()).source.ok, false)
    } finally {
      process.env.SUBS_SOURCE = source.url
    }
  })

  test('a browser checking first (OPTIONS), and what is not there', async () => {
    const preflight = await get(`/${settings('ok')}/subtitles/movie/tt0000001.json`, { method: 'OPTIONS' })
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*')
    assert.equal((await get('/nothing/here')).status, 404)
    assert.equal((await get(`/${settings('ok')}/manifest.json`, { method: 'POST' })).status, 405)
    assert.equal((await get('/manifest.json', { method: 'PUT', body: 'x' })).status, 405)
    assert.equal((await get('/manifest.json', { method: 'DELETE' })).status, 405)
    const head = await get('/manifest.json', { method: 'HEAD' })
    assert.equal(head.status, 200)
    assert.equal(await head.text(), '')
  })

  test('installed from its bare address, without the settings: it says so where the viewer looks', async () => {
    const callsBefore = ai.calls.length
    // Nuvio adds /manifest.json to whatever address is pasted, and installs what it finds
    const bare = await (await get('/manifest.json')).json()
    assert.equal(bare.name, 'Tarjuman AI | ترجمان (بلا إعدادات)')
    assert.match(bare.description, /مثبّتة بلا إعدادات/)
    assert.equal((await (await get(`/${settings('ok')}/manifest.json`)).json()).name, 'Tarjuman AI | ترجمان')
    // asked for subtitles the way players ask, with and without what they know of the file
    for (const path of ['/subtitles/movie/tt0000001.json', '/subtitles/series/tt0000001%3A2%3A3.json', '/subtitles/series/tt0000001%3A2%3A3/videoHash=abc&videoSize=12&filename=Some.Film.mkv.json']) {
      const response = await get(path)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('cache-control'), 'no-cache')
      const { subtitles } = await response.json()
      assert.deepEqual(subtitles, [{ id: '⚠️ ترجمان: ناقصها الإعدادات', lang: 'ara', label: '⚠️ ترجمان: ناقصها الإعدادات', url: `${base}/notice/setup.vtt` }])
    }
    const shown = await track(`${base}/notice/setup.vtt`)
    assert.equal(shown.kept, 'no-store')
    assert.equal(shown.lines.length, 0)
    assert.match(shown.notes[0].text, /ترجمان مثبّتة بلا إعدادات، فلا تترجم\n.*انسخ الرابط، وثبّته بدل هذه النسخة/)
    // and nothing else answers under these names
    assert.equal((await get('/notice/other.vtt')).status, 404)
    assert.equal((await get('/notice/constructor.vtt')).status, 404)
    assert.equal((await get('/subtitles/movie.json')).status, 404)
    assert.equal(ai.calls.length, callsBefore)
  })

  test('settings that cannot be read', async () => {
    assert.equal((await get('/AAAAAAAAAAAAAAAA/manifest.json')).status, 400)
    // in the list of subtitles it says so, in an entry of its own: an empty list would only look like an addon that is not there
    const [said, ...others] = await listed('AAAAAAAAAAAAAAAA', 'movie/tt0000001')
    assert.equal(others.length, 0)
    assert.deepEqual([said.lang, said.id, said.label, said.url], ['ara', '⚠️ ترجمان: رابط الإضافة غير مقروء', '⚠️ ترجمان: رابط الإضافة غير مقروء', `${base}/notice/link.vtt`])
    const shown = await track(said.url)
    assert.equal(shown.kept, 'no-store')
    assert.match(shown.notes[0].text, /رابط إضافة ترجمان غير مقروء\n.*انسخ الرابط من جديد/)
    const { response, kept, notes, lines } = await track(`${base}/AAAAAAAAAAAAAAAA/t/${link({ u: `${source.url}/file/3`, l: 'eng', t: 'movie', i: 'tt0000001' })}.vtt`)
    assert.equal(response.status, 200)
    assert.equal(kept, 'no-store')
    assert.equal(lines.length, 0)
    assert.match(notes[0].text, /الإعدادات غير مقروءة/)
  })
})

describe('the list of subtitles', () => {
  test('offered as Arabic, best match for the file first, named after the release', async () => {
    const cfg = settings('ok-list')
    const before = source.hits.list.length
    // the path as Nuvio builds it: hash, size, then the file name with everything but letters and digits escaped
    const extra = 'videoHash=abc123&videoSize=1000&filename=Some.Film.2020.1080p.BluRay.x264-SPARKS.mkv'
    const subtitles = await listed(cfg, `movie/tt0000001/${extra}`)
    assert.equal(subtitles.length, 2)
    for (const subtitle of subtitles) {
      assert.equal(subtitle.lang, 'ara')
      assert.equal(subtitle.id, subtitle.label)   // Nuvio shows the id, Stremio the label
      assert.ok(subtitle.url.startsWith(`${base}/${cfg}/t/`) && subtitle.url.endsWith('.vtt'), subtitle.url)
    }
    assert.equal(subtitles[0].label, 'AI ⏳ · Some.Film.2020.1080p.BluRay.x264-SPARKS')
    assert.equal(subtitles[1].label, 'AI ⏳ · Some.Film.2020.1080p.WEB-DL.x264-OTHER')
    // what the player knows about the file is passed on to the source, so it can match by hash
    assert.equal(source.hits.list.length, before + 1)
    assert.ok(source.hits.list.at(-1).endsWith(`/subtitles/movie/tt0000001/${extra}.json`))
    // the same title again is answered from memory
    await listed(cfg, `movie/tt0000001/${extra}`)
    assert.equal(source.hits.list.length, before + 1)
  })

  test('two subtitles of one release get different names', async () => {
    const subtitles = await listed(settings('ok-list'), 'movie/tt0000022')
    assert.deepEqual(subtitles.map(subtitle => subtitle.id), ['AI ⏳ · Twin.Film.2021.1080p.WEB', 'AI ⏳ · Twin.Film.2021.1080p.WEB #2'])
  })

  test('how many are listed is a setting', async () => {
    assert.equal((await listed(settings('ok-list', { n: 1 }), 'movie/tt0000001')).length, 1)
    // three English ones exist; a fourth sits on a host that is not allowed and is never offered
    assert.equal((await listed(settings('ok-list', { n: 3 }), 'movie/tt0000001')).length, 3)
  })

  test('an episode, with its id escaped as players send it', async () => {
    const subtitles = await listed(settings('ok-list'), 'series/tt0000007%3A2%3A3')
    assert.equal(subtitles.length, 2)
    assert.ok(source.hits.list.at(-1).endsWith('/subtitles/series/tt0000007%3A2%3A3.json'))
    assert.deepEqual(JSON.parse(Buffer.from(subtitles[0].url.split('/t/')[1].slice(0, -4), 'base64url').toString()).i, 'tt0000007:2:3')
    assert.equal((await listed(settings('ok-list'), 'series/tt0000007:2:3')).length, 2)
  })

  test('no subtitle in the chosen language: another one, if allowed', async () => {
    // tt0000033: fre (real) + ara (real Arabic at /file/32) → Arabic ready shows first, then AI fre
    const other = await listed(settings('ok-list', { any: 1 }), 'movie/tt0000033')
    assert.equal(other.length, 2)
    assert.ok(other[0].label.startsWith('عربي جاهز'), JSON.stringify(other.map(s => s.label)))
    assert.ok(other[1].label.startsWith('AI'), JSON.stringify(other.map(s => s.label)))
    // any: 0 → لا ترجمة آلية، لكن الترجمة العربية الجاهزة تبقى معروضة
    const readyOnly = await listed(settings('ok-list', { any: 0 }), 'movie/tt0000033')
    assert.equal(readyOnly.length, 1)
    assert.ok(readyOnly[0].label.startsWith('عربي جاهز'))
  })

  test('ترجمة عربية مزيفة (محتوى إنكليزي) تُستبعد من «عربي جاهز»', async () => {
    // tt0000040: ara at /file/999 has English content → fails Arabic verification → excluded
    const subs = await listed(settings('ok-list', { any: 1, n: 3 }), 'movie/tt0000040')
    assert.ok(subs.length >= 1, JSON.stringify(subs.map(s => s.label)))
    assert.ok(subs.every(s => !s.label.startsWith('عربي جاهز')), 'fake Arabic should not appear: ' + JSON.stringify(subs.map(s => s.label)))
    assert.ok(subs.some(s => s.label.startsWith('AI')), 'AI fallback should appear: ' + JSON.stringify(subs.map(s => s.label)))
  })

  test('ترجمة عربية متعددة الحلقات تُستبعد من «عربي جاهز»', async () => {
    // tt0000045: ara at /file/888 has 200 cues spanning 65 minutes → multi-episode → excluded
    const subs = await listed(settings('ok-list', { any: 1, n: 3 }), 'movie/tt0000045')
    assert.ok(subs.length >= 1, JSON.stringify(subs.map(s => s.label)))
    assert.ok(subs.every(s => !s.label.startsWith('عربي جاهز')), 'multi-episode Arabic should not appear: ' + JSON.stringify(subs.map(s => s.label)))
    assert.ok(subs.some(s => s.label.startsWith('AI')), 'AI fallback should appear: ' + JSON.stringify(subs.map(s => s.label)))
  })

  test('ترجمة عربية جاهزة تظهر أولًا، وترجمة AI بعدها', async () => {
    const subs = await listed(settings('ok-list', { any: 1, n: 3 }), 'movie/tt0000033')
    assert.equal(subs.length, 2)
    assert.ok(subs[0].label.startsWith('عربي جاهز'), JSON.stringify(subs.map(s => s.label)))
    assert.ok(subs[0].url.includes('/r/'), JSON.stringify(subs[0].url))
    assert.ok(subs[1].label.startsWith('AI'), JSON.stringify(subs.map(s => s.label)))
    assert.ok(subs[1].url.includes('/t/'), JSON.stringify(subs[1].url))
  })

  test('عند na: 1 يُعرض العربي الجاهز فقط بدون خيار الترجمة', async () => {
    const subs = await listed(settings('ok-list', { any: 1, n: 3, na: 1 }), 'movie/tt0000033')
    assert.equal(subs.length, 1)
    assert.ok(subs[0].label.startsWith('عربي جاهز'), JSON.stringify(subs.map(s => s.label)))
    assert.ok(subs[0].url.includes('/r/'), JSON.stringify(subs[0].url))
  })

  test('الترجمة العربية الجاهزة تُجلب عبر /r/ من غير ترجمة', async () => {
    const subs = await listed(settings('ok-list', { any: 1, n: 3 }), 'movie/tt0000033')
    const ready = subs.find(s => s.url.includes('/r/'))
    assert.ok(ready, 'no ready Arabic subtitle found')
    const { response, lines } = await track(ready.url)
    assert.equal(response.status, 200)
    assert.ok(lines.join('\n').includes('مرحباً'), 'Arabic content should be in VTT')
  })

  test('عند ca: 1 يقارن الذكاء بين الترجمات الجاهزة ويختار أفضل واحدة', async () => {
    const subs = await listed(settings('ok-list', { any: 1, n: 3, ca: 1 }), 'movie/tt0000033')
    assert.ok(subs.length >= 1, JSON.stringify(subs.map(s => s.label)))
    const ready = subs.find(s => s.label.includes('اختارته AI'))
    assert.ok(ready, 'no AI-chosen Arabic subtitle found: ' + JSON.stringify(subs.map(s => s.label)))
    assert.ok(ready.url.includes('/r/'), JSON.stringify(ready.url))
  })

  test('عند ca: 1 مع ترجمة عربية واحدة فقط لا يقارن', async () => {
    const subs = await listed(settings('ok-list', { any: 1, n: 3, ca: 1 }), 'movie/tt0000033')
    assert.ok(subs.length >= 1, JSON.stringify(subs.map(s => s.label)))
  })

  test('nothing to offer', async () => {
    // لا ترجمة للعنوان → يخبر المستخدم صراحةً أنه ما لقي ترجمة عربية
    const noSubs = await listed(settings('ok-list'), 'movie/tt0000404')
    assert.equal(noSubs.length, 1)
    assert.ok(noSubs[0].label.includes('ما لقي ترجمة عربية'), JSON.stringify(noSubs.map(s => s.label)))
    // المصدر معطل → نفس الرسالة
    const down = await listed(settings('ok-list'), 'movie/tt0000500')
    assert.equal(down.length, 1)
    assert.ok(down[0].label.includes('ما لقي ترجمة عربية'), JSON.stringify(down.map(s => s.label)))
    const before = source.hits.list.length
    // معرّفات كتالوجات الأنمي تصير صالحة وتصل للمصدر (فكرة 24) — هنا المصدر التجريبي يرد بالقائمة الافتراضية
    assert.equal((await listed(settings('ok-list'), 'movie/kitsu%3A123')).length, 2)
    assert.equal(source.hits.list.length, before + 1)
    // أما «channel» فليست نوع/معرّف مفهومًا: لا تصل للمصدر أصلًا
    assert.deepEqual(await listed(settings('ok-list'), 'channel/tt0000001'), [])
    assert.equal(source.hits.list.length, before + 1, 'ids it cannot serve never reach the source')
  })

  test('links point at the address the viewer came through', async () => {
    const cfg = settings('ok-list')
    const first = async headers => (await listed(cfg, 'movie/tt0000001', { headers }))[0].url
    assert.ok((await first({ 'x-forwarded-host': 'addon.example.com' })).startsWith(`https://addon.example.com/${cfg}/t/`))
    assert.ok((await first({ 'x-forwarded-host': 'addon.example.com', 'x-forwarded-proto': 'http' })).startsWith('http://addon.example.com/'))
    assert.ok((await first({ 'x-forwarded-host': 'evil.example/"><script>' })).startsWith('http://127.0.0.1/'))
    process.env.PUBLIC_URL = 'https://my-addon.example.org/'
    try {
      assert.ok((await first({})).startsWith(`https://my-addon.example.org/${cfg}/t/`))
    } finally {
      delete process.env.PUBLIC_URL
    }
  })

  test('translating starts when the list is asked for, if set so', async () => {
    await listed(settings('ok-cold', { warm: 0 }), 'movie/tt0000001')
    await pause(300)
    assert.equal(callsOf('ok-cold'), 0)
    const [{ url }] = await listed(settings('ok-warm', { warm: 1 }), 'movie/tt0000001')
    await pause(300)
    assert.equal(callsOf('ok-warm'), BATCHES)
    // and the subtitle, when picked, is there already
    const { kept, lines } = await track(url)
    assert.equal(kept, COMPLETE)
    assertAllArabic(lines)
    assert.equal(callsOf('ok-warm'), BATCHES)
  })
})

describe('a translated subtitle', () => {
  test('complete: every line in Arabic; kept by players once finished; never translated twice', async () => {
    const cfg = settings('ok-full')
    const [{ url }] = await listed(cfg, 'movie/tt0000001')
    const first = await track(url)
    assert.equal(first.response.status, 200)
    assert.equal(first.response.headers.get('content-type'), 'text/vtt; charset=utf-8')
    assert.equal(first.response.headers.get('access-control-allow-origin'), '*')
    assert.equal(first.kept, HELD)   // it was sent while the translation ran
    assert.equal(first.notes.length, 0)
    assertAllArabic(first.lines)
    assert.equal(callsOf('ok-full'), BATCHES)
    const again = await track(url)
    assert.equal(again.kept, COMPLETE)
    assertAllArabic(again.lines)
    assert.equal(callsOf('ok-full'), BATCHES)
    assert.equal((await readdir(process.env.CACHE_DIR)).filter(name => name.endsWith('.vtt')).length >= 1, true)
  })

  test('the model is told what it is translating', async () => {
    const [{ url }] = await listed(settings('ok-about'), 'series/tt0000007%3A2%3A3')
    await track(url)
    const system = ai.calls.find(call => call.model === 'ok-about').messages[0].content
    assert.match(system, /What you are translating: Some Film \(2020\), a Drama, Mystery series, season 2 episode 3 "The Long Road"\. The story: Two friends cross the country to find a lost map\. This episode: The bridge is out\.\n?$/)
  })

  test('an opening theme is left as it was written, and nothing is paid for it (idea 5)', async () => {
    const cfg = settings('ok-song', { nm: 0, sdh: 1 })
    const [{ url }] = await listed(cfg, 'series/tt0000205%3A1%3A5')
    const { lines } = await untilComplete(url)
    assert.equal(lines[7], '♪ The hero sings his name ♪')
    assert.equal(lines[10], '♪ We walk into the night ♪')
    assert.equal(lines[0], `${RLM}${fake(1)}`)
    // 60 cues − 11 dropped (ad, signs, sounds) − 4 song lines = 45 translated lines → 2 batches of 40
    assert.equal(ai.callsOf('ok-song').length, Math.ceil(45 / 40))
    assert.equal(lines.length, 49)
  })

  test('a picked series: the next episode is prepared once the current one is (idea 10)', async () => {
    const cfg = settings('ok-next', { nm: 0, sdh: 1, warm: 1, pn: 1 })
    const [{ url }] = await listed(cfg, 'series/tt0000205%3A1%3A5')
    await untilComplete(url)
    const deadline = Date.now() + 30_000
    let ready = false
    while (Date.now() < deadline && !ready) {
      const listed6 = await (await get(`/${cfg}/subtitles/series/tt0000205%3A1%3A6.json`)).json()
      ready = listed6.subtitles?.[0]?.id?.startsWith('AI ✓') ?? false
      if (!ready) await pause(250)
    }
    assert.equal(ready, true, 'the next episode got prepared in the background')
    // a pick for the next episode is answered from the kept translation, without paying for it again
    const callsBefore = ai.callsOf('ok-next').length
    const [{ url: nextUrl }] = await listed(cfg, 'series/tt0000205%3A1%3A6')
    const done = await track(nextUrl)
    assert.equal(done.kept, 'public, max-age=86400')
    assert.equal(ai.callsOf('ok-next').length, callsBefore, 'the next episode was already translated')
  })

  test('a show known to AniList gets one name dictionary for good, and the next episode reuses its spellings (ideas 14 + 17)', async () => {
    const cfg = settings('ok-dict', { nm: 1, sdh: 0 })
    const [{ url }] = await listed(cfg, 'series/tt0000204%3A1%3A5')
    await track(url)
    const [brief] = ai.briefsOf('ok-dict')
    assert.equal(ai.briefsOf('ok-dict').length, 1)
    assert.match(brief.messages[0].content, /The characters of this work, known from its database/)
    assert.match(brief.messages[0].content, /- Mary \(メアリー\) — man/)
    assert.match(brief.messages[0].content, /- Zoro \(ゾロ\) — man/)
    const batches = ai.callsOf('ok-dict').map(call => JSON.parse(call.messages[1].content))
    assert.equal(batches.every(batch => batch.names?.notAName === undefined), true)
    const mary = batches.map(batch => batch.names?.Mary).filter(Boolean)
    assert.ok(mary.length > 0)
    assert.equal(mary.every(entry => entry.is === 'man'), true, 'the database gender wins — the model said "woman"')
    assert.equal(ai.briefsOf('ok-dict')[0].messages[0].content.includes('already chosen'), false, 'nothing stored yet for this show')
    // the dictionary was kept, with the spelling this brief chose: Mary → ماري
    const kept = JSON.parse(await readFile(join(process.env.CACHE_DIR, 'series-tt0000204.json'), 'utf8'))
    assert.equal(kept.names.find(entry => entry.name === 'Mary').arabic, 'ماري')
    assert.deepEqual(anilist.hits, ['search', 'characters'])
    // a new episode of the same show: what was chosen is reused without asking AniList again
    const [{ url: url3 }] = await listed(settings('ok-dict-3', { nm: 1, sdh: 0 }), 'series/tt0000204%3A1%3A3')
    await track(url3)
    const [brief3] = ai.briefsOf('ok-dict-3')
    assert.match(brief3.messages[0].content, /These have a spelling already chosen for this work/)
    assert.match(brief3.messages[0].content, /Mary → ماري/)
    const batches3 = ai.callsOf('ok-dict-3').map(call => JSON.parse(call.messages[1].content))
    assert.equal(batches3.every(batch => !batch.names?.Mary || batch.names.Mary.arabic === 'ماري'), true)
    assert.deepEqual(anilist.hits, ['search', 'characters'], 'the dictionary came from storage, not from AniList again')
  })

  test('names: the subtitle is read once first, and every batch is told the names in it', async () => {
    const cfg = settings('ok-names', { nm: 1, sdh: 0 })   // sdh off keeps the line "MARY: Where did you put the map?"
    const [{ url }] = await listed(cfg, 'series/tt0000007%3A2%3A3')
    const { lines } = await track(url)
    assert.equal(lines.length, tidy(parseSubtitle(sampleSrt()), { dropSounds: false }).length)
    const [brief] = ai.briefsOf('ok-names')
    assert.equal(ai.briefsOf('ok-names').length, 1)
    assert.match(brief.messages[0].content, /translator's brief for the Arabic subtitles of: Some Film \(2020\), a Drama, Mystery series, season 2 episode 3 "The Long Road"\. The story: Two friends cross the country to find a lost map\. This episode: The bridge is out\./)
    assert.ok(brief.messages[1].content.includes('MARY: Where did you put the map?'))
    const batches = ai.callsOf('ok-names').map(call => JSON.parse(call.messages[1].content))
    assert.equal(batches.length, Math.ceil(lines.length / 40))
    for (const batch of batches) {
      assert.deepEqual(batch.names, { Mary: { arabic: 'ماري', is: 'woman' } })
      assert.deepEqual(batch.terms, { 'the long road': 'الطريق الطويل' })
    }
    // the same subtitle without the brief is another translation, kept apart
    const [{ url: plain }] = await listed(settings('ok-names', { nm: 0, sdh: 0 }), 'series/tt0000007%3A2%3A3')
    await track(plain)
    assert.equal(ai.callsOf('ok-names').length, batches.length * 2)
    assert.equal(ai.briefsOf('ok-names').length, 1)
  })

  test('sound descriptions are left out, or kept, as set', async () => {
    const [{ url }] = await listed(settings('ok-sounds', { sdh: 0 }), 'movie/tt0000001')
    const { lines } = await track(url)
    assert.equal(lines.length, tidy(parseSubtitle(sampleSrt()), { dropSounds: false }).length)
    assert.ok(lines.length > expected.length)
  })

  test('while it waits, the answer has started and keeps the line alive', async () => {
    // Nuvio's first download gives up after 15 silent seconds and mpv after 60: a held answer is never silent
    const [{ url }] = await listed(settings('slow-trickle', { cc: 1, wait: 20 }), 'movie/tt0000001')
    const started = Date.now()
    const response = await fetch(url)
    assert.ok(Date.now() - started < 1000, 'the headers come at once')
    assert.equal(response.headers.get('cache-control'), HELD)
    const arrivals = []
    const decoder = new TextDecoder()
    let body = ''
    for await (const chunk of response.body) {
      const part = decoder.decode(chunk, { stream: true })
      arrivals.push({ at: Date.now() - started, part })
      body += part
    }
    assert.equal(arrivals[0].part, 'WEBVTT\n\n')
    assert.ok(arrivals[0].at < 1000)
    const blanks = arrivals.filter(arrival => arrival.part === '\n')
    assert.ok(blanks.length >= 5, `${blanks.length} blank lines in ${arrivals.at(-1).at} ms`)
    assert.ok(arrivals.at(-1).at >= 4000, 'the translation took its time')
    // and what it adds up to is a plain, complete subtitle
    const cues = read(body)
    assert.equal(cues.filter(cue => cue.top).length, 0)
    assertAllArabic(cues.map(cue => cue.text))
    assert.equal(callsOf('slow-trickle'), BATCHES)
  })

  test('not ready in time: what there is, the rest as it was, and a note; then the whole of it', async () => {
    const [{ url }] = await listed(settings('slow', { cc: 1, wait: 3 }), 'movie/tt0000001')
    const started = Date.now()
    const partial = await track(url)
    assert.ok(Date.now() - started < 4500, 'answers at the set wait')
    assert.equal(partial.kept, HELD)
    assert.ok(partial.notes.length >= 2)
    assert.match(partial.notes[0].text, /قيد التجهيز \(\d+%\)/)
    assert.equal(partial.lines.length, expected.length)
    const done = countArabic(partial.lines)
    assert.ok(done >= 40 && done < expected.length, `${done} of ${expected.length} lines translated`)
    partial.lines.forEach((line, i) => assert.ok(line === translated(i) || line === expected[i].text, `line ${i}`))

    // asked again right away, as Nuvio does when it hands the address to its player: the same, without another wait
    const again = Date.now()
    const second = await track(url)
    assert.ok(Date.now() - again < 500, 'no second wait')
    assert.equal(second.kept, 'no-store')
    assert.ok(countArabic(second.lines) >= done)

    const whole = await untilComplete(url)
    assert.equal(whole.notes.length, 0)
    assertAllArabic(whole.lines)
    assert.equal(callsOf('slow'), BATCHES)
  })

  test('asking again at once is answered at once; asking again later waits again', async () => {
    process.env.REPICK_MS = '1200'
    try {
      const [{ url }] = await listed(settings('slow-repick', { cc: 1, wait: 1 }), 'movie/tt0000001')
      const timed = async () => { const started = Date.now(); const result = await track(url); return { ...result, ms: Date.now() - started } }
      const first = await timed()
      assert.ok(first.ms >= 900 && first.ms < 1600, `${first.ms} ms`)
      // three quick ones in a row: none of them waits, and none of them keeps the others from waiting later
      for (let i = 0; i < 3; i++) assert.ok((await timed()).ms < 300)
      await pause(1300)
      const later = await timed()
      assert.ok(later.ms >= 900 || later.kept === COMPLETE, `${later.ms} ms`)
      assertAllArabic((await untilComplete(url)).lines)
      assert.equal(callsOf('slow-repick'), BATCHES)
    } finally {
      delete process.env.REPICK_MS
    }
  })

  test('a player that hangs up and asks again (Nuvio on iOS) joins the same translation', async () => {
    const [{ url }] = await listed(settings('slow-twice', { cc: 1, wait: 20 }), 'movie/tt0000001')
    const first = new AbortController()
    const dropped = fetch(url, { signal: first.signal }).then(response => response.text()).catch(error => error.name)
    await pause(1000)
    first.abort()
    assert.equal(await dropped, 'AbortError')
    const second = await track(url)
    assert.equal(second.notes.length, 0)
    assertAllArabic(second.lines)
    assert.equal(callsOf('slow-twice'), BATCHES, 'nothing was translated twice')
  })

  test('two players at once share one translation', async () => {
    const [{ url }] = await listed(settings('lag-pair', { cc: 2, wait: 20 }), 'movie/tt0000001')
    const [one, two] = await Promise.all([track(url), track(url)])
    assertAllArabic(one.lines)
    assertAllArabic(two.lines)
    assert.equal(callsOf('lag-pair'), BATCHES)
    assert.ok(ai.peakOf('lag-pair') <= 2)
  })

  test('a refused key: the reason on screen at once, the original lines underneath', async () => {
    const [{ url }] = await listed(settings('bad-key'), 'movie/tt0000001')
    const started = Date.now()
    const { kept, notes, lines } = await track(url)
    assert.ok(Date.now() - started < 2000)
    assert.equal(kept, HELD)
    assert.match(notes[0].text, /توقفت الترجمة عند 0%: مفتاح الـAI مرفوض \(401\)/)
    assert.deepEqual(lines, expected.map(cue => cue.text))
  })

  test('a line the provider will not take stays as it was written; the translation is complete, and kept', async () => {
    const rough = tidy(parseSubtitle(sampleSrt(130, ROUGH)))
    const at = rough.findIndex(cue => cue.text.includes('FLAGGED'))
    assert.ok(at > 0)
    const [{ url }] = await listed(settings('strict-film'), 'movie/tt0000066')
    const { lines, notes } = await untilComplete(url)
    assert.equal(notes.length, 0)
    assert.equal(lines.length, rough.length)
    // the line as it was written, left to right; every other line in Arabic
    lines.forEach((line, i) => assert.equal(line, i === at ? rough[at].text : translated(i), `line ${i + 1}`))
    const calls = callsOf('strict-film')
    assert.equal((await track(url)).kept, COMPLETE)
    assert.equal(callsOf('strict-film'), calls)
  })

  test('a provider that turns the whole video down: said on screen, the original lines underneath, and it stops soon', async () => {
    const [{ url }] = await listed(settings('refuses-all-film'), 'movie/tt0000001')
    const { kept, notes, lines } = await track(url)
    assert.equal(kept, HELD)
    assert.match(notes[0].text, /توقفت الترجمة عند 0%: رفض المزود كل ما أُرسل إليه، فجرّب نموذجًا أو مزودًا آخر/)
    assert.deepEqual(lines, expected.map(cue => cue.text))
    // the batches that were out, then six single lines from all over the subtitle; no batch was cut up
    const sizes = ai.callsOf('refuses-all-film').map(call => Object.keys(JSON.parse(call.messages[1].content).lines).length)
    assert.equal(sizes.filter(size => size === 1).length, 6)
    assert.ok(sizes.length <= 9 && sizes.every(size => size === 1 || size >= 20), `requests of ${sizes} lines`)
  })

  test('picking the subtitle again takes a stopped translation up again', async () => {
    ai.failNext(1)
    const [{ url }] = await listed(settings('flaky-key', { cc: 1 }), 'movie/tt0000001')
    const stopped = await track(url)
    assert.match(stopped.notes[0].text, /توقفت الترجمة/)
    const resumed = await track(url)
    assert.equal(resumed.notes.length, 0)
    assertAllArabic(resumed.lines)
  })

  test('a translation that just stopped is not tried again within the pause', async () => {
    const [{ url }] = await listed(settings('bad-key'), 'movie/tt0000001')
    await track(url)   // stops on the refused key
    const calls = callsOf('bad-key')
    process.env.RETRY_COOLDOWN_MS = '60000'
    try {
      const started = Date.now()
      const again = await track(url)
      assert.ok(Date.now() - started < 500)
      assert.match(again.notes[0].text, /توقفت الترجمة عند 0%: مفتاح الـAI مرفوض/)
      assert.equal(again.kept, 'no-store')
      assert.equal(callsOf('bad-key'), calls, 'no request to the model during the pause')
    } finally {
      process.env.RETRY_COOLDOWN_MS = '0'
    }
  })

  test('no waiting at all, if set so', async () => {
    const [{ url }] = await listed(settings('slow-nowait', { cc: 1, wait: 0 }), 'movie/tt0000001')
    const started = Date.now()
    const { kept, notes, lines } = await track(url)
    assert.ok(Date.now() - started < 1000)
    assert.equal(kept, 'no-store')
    assert.match(notes[0].text, /قيد التجهيز \(0%\)/)
    assert.deepEqual(lines, expected.map(cue => cue.text))
    assertAllArabic((await untilComplete(url)).lines)
    assert.equal(callsOf('slow-nowait'), BATCHES)
  })

  test('a file that is not a subtitle', async () => {
    const address = `${base}/${settings('ok-empty')}/t/${link({ u: `${source.url}/file/9`, l: 'eng', t: 'movie', i: 'tt0000001' })}.vtt`
    const files = source.hits.file
    const { kept, notes, lines } = await track(address)
    assert.equal(kept, 'no-store')
    assert.equal(lines.length, 0)
    assert.match(notes[0].text, /تعذّر تجهيز الترجمة: الترجمة الأصلية فارغة/)
    assert.equal(callsOf('ok-empty'), 0)
    // asked again at once (the second download): the same answer, without fetching the file again
    await track(address)
    assert.equal(source.hits.file, files + 1)
  })

  test('links that were tampered with fetch nothing', async () => {
    const files = source.hits.file
    for (const ref of [
      { u: 'http://169.254.169.254/latest/meta-data', l: 'eng', t: 'movie', i: 'tt0000001' },
      { u: 'https://elsewhere.example/file/5', l: 'eng', t: 'movie', i: 'tt0000001' },
      { u: `${source.url}/file/3`, l: 'eng', t: 'channel', i: 'tt0000001' },
      { u: `${source.url}/file/3`, l: 'english', t: 'movie', i: 'tt0000001' },
      { u: `${source.url}/file/3`, l: 'eng', t: 'movie', i: '../../etc/passwd' },
    ]) {
      assert.equal((await get(`/${settings('ok-tamper')}/t/${link(ref)}.vtt`)).status, 400, JSON.stringify(ref))
    }
    assert.equal((await get(`/${settings('ok-tamper')}/t/not-a-link.vtt`)).status, 400)
    assert.equal(source.hits.file, files)
    assert.equal(callsOf('ok-tamper'), 0)
  })

  test('a player that only checks the address (HEAD) starts nothing', async () => {
    const [{ url }] = await listed(settings('ok-head'), 'movie/tt0000001')
    const response = await fetch(url, { method: 'HEAD' })
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), 'text/vtt; charset=utf-8')
    assert.equal(await response.text(), '')
    await pause(200)
    assert.equal(callsOf('ok-head'), 0)
  })

  test('a server started afresh serves what was translated before, and keeps the key out of its log', async () => {
    const cfg = settings('ok-disk')
    const [{ url }] = await listed(cfg, 'movie/tt0000001')
    assertAllArabic((await track(url)).lines)
    const calls = callsOf('ok-disk')

    const port = await new Promise(resolve => {
      const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
    })
    const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), QUIET: '' } })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    try {
      for (let attempt = 0; attempt < 50 && !output.includes('listening'); attempt++) await pause(100)
      const fresh = await track(url.replace(base, `http://127.0.0.1:${port}`))
      assert.equal(fresh.kept, COMPLETE)
      assertAllArabic(fresh.lines)
      assert.equal(callsOf('ok-disk'), calls, 'nothing sent to the model again')
      await pause(100)
      assert.match(output, /GET \/<settings>\/t\/[\w-]{10}…\.vtt → 200/)
      assert.ok(!output.includes(cfg) && !output.includes('secret-key'), 'the settings stay out of the log')
    } finally {
      child.kill()
    }
  })
})

describe('picked twice: a translation is only made when the viewer asks for it', () => {
  const ASK = /اختر هذه الترجمة مرة ثانية لتبدأ الترجمة/
  // the option is on unless an address turns it off
  const twice = (model, extra = {}) => settings(model, { cf: undefined, ...extra })

  test('the first pick is answered at once with a line that says so, and costs nothing', async () => {
    const [{ url, id }] = await listed(twice('ok-twice'), 'movie/tt0000001')
    assert.ok(id.startsWith('AI ⏳ · Some.Film.2020'), id)
    const files = source.hits.file
    const started = Date.now()
    const first = await track(url)
    assert.ok(Date.now() - started < 1000)
    assert.equal(first.kept, 'no-store')
    assert.equal(first.lines.length, 0)
    assert.match(first.notes[0].text, ASK)
    // wherever the viewer is in the video, the line comes within seconds
    assert.ok(first.notes.length > 300)
    // the player asks again at once (it hands the address to its own player): still the same pick
    const echo = await track(url)
    assert.match(echo.notes[0].text, ASK)
    assert.equal(callsOf('ok-twice'), 0)
    assert.equal(source.hits.file, files)   // and the subtitle itself was not even fetched
  })

  test('the second pick translates; then the name in the list says it is ready', async () => {
    const cfg = twice('ok-twice-2')
    const [{ url }] = await listed(cfg, 'movie/tt0000001')
    const files = source.hits.file
    assert.match((await track(url)).notes[0].text, ASK)
    assert.equal(source.hits.file, files)
    await pause(300)
    const second = await track(url)
    assert.equal(second.notes.length, 0)
    assertAllArabic(second.lines)
    assert.equal(callsOf('ok-twice-2'), BATCHES)
    assert.equal((await track(url)).kept, COMPLETE)
    // the one that was translated says so; the other one of the same film does not
    const names = (await listed(cfg, 'movie/tt0000001')).map(entry => entry.id)
    assert.deepEqual(names.map(name => name.slice(0, 7)), ['AI ✓ · ', 'AI ⏳ · '])
    // a finished one is served to any request, the first included
    assert.equal(callsOf('ok-twice-2'), BATCHES)
  })

  test('a first pick that was not followed up is forgotten after a while', async () => {
    const [{ url }] = await listed(twice('ok-twice-3'), 'movie/tt0000001')
    assert.match((await track(url)).notes[0].text, ASK)
    await pause(1700)
    assert.match((await track(url)).notes[0].text, ASK)   // a first pick again
    assert.equal(callsOf('ok-twice-3'), 0)
    await pause(300)
    assertAllArabic((await track(url)).lines)
  })

  test('a translation that was begun needs no second pick: one started with the list, or one that stopped half-way', async () => {
    const warm = twice('ok-twice-warm', { warm: 1 })
    const [{ url }] = await listed(warm, 'movie/tt0000001')
    const picked = await track(url)   // the very first pick of it
    assert.equal(picked.notes.length, 0)
    assertAllArabic(picked.lines)
    assert.equal(callsOf('ok-twice-warm'), BATCHES)

    ai.failNext(1)
    const [stopped] = await listed(twice('flaky-key', { cc: 1 }), 'movie/tt0000022')
    assert.match((await track(stopped.url)).notes[0].text, ASK)
    await pause(300)
    assert.match((await track(stopped.url)).notes[0].text, /توقفت الترجمة/)
    // long after the first pick was forgotten, the next request takes the work up again without asking twice
    await pause(1700)
    const resumed = await track(stopped.url)
    assert.equal(resumed.notes.length, 0)
    assertAllArabic(resumed.lines)
  })

  test('each subtitle is asked for on its own', async () => {
    const [one, two] = await listed(twice('ok-twice-each'), 'movie/tt0000001')
    assert.match((await track(one.url)).notes[0].text, ASK)
    await pause(300)
    assert.match((await track(two.url)).notes[0].text, ASK)   // the first pick of the other one
    assert.equal(callsOf('ok-twice-each'), 0)
  })
})

describe("the settings page's test button", () => {
  const post = async body => (await get('/api/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body) })).json()

  test('a working provider: three lines back', async () => {
    const answer = await post({ b: ai.url, k: 'secret-key', m: 'ok-button', r: 'minimal' })
    assert.equal(answer.ok, true)
    assert.equal(typeof answer.seconds, 'number')
    assert.deepEqual(answer.lines.map(pair => pair.to), [fake(1), fake(2), fake(3)])
    assert.ok(answer.lines.every(pair => pair.from.length > 10))
    assert.equal(callsOf('ok-button'), 1)
  })

  test('a refused key, an unknown model: the reason', async () => {
    const refused = await post({ b: ai.url, k: 'wrong', m: 'bad-key' })
    assert.equal(refused.ok, false)
    assert.match(refused.error, /مفتاح الـAI مرفوض \(401\): Incorrect API key provided/)
    assert.match((await post({ b: ai.url, k: 'x', m: 'missing-model' })).error, /404/)
  })

  test("OpenAI's models as they answer today: the request is put right, and the lines come back", async () => {
    const answer = await post({ b: ai.url, k: 'x', m: 'openai-5.6-terra', r: 'low' })
    assert.equal(answer.ok, true)
    assert.deepEqual(answer.lines.map(pair => pair.to), [fake(1), fake(2), fake(3)])
    const sent = ai.callsOf('openai-5.6-terra')
    assert.equal(sent.length, 2)   // once with a temperature, which they refuse while they think; once without
    assert.deepEqual([sent[1].temperature, sent[1].reasoning_effort], [undefined, 'low'])
  })

  test('a provider that turns the test lines down: the reason, and never "it works" over lines left as they were', async () => {
    const answer = await post({ b: ai.url, k: 'x', m: 'refuses-all-button' })
    assert.equal(answer.ok, false)
    assert.match(answer.error, /رفض المزود كل ما أُرسل إليه/)
    assert.match(answer.error, /flagged as potentially violating/)
  })

  test('an account with nothing left to spend: the reason', async () => {
    const answer = await post({ b: ai.url, k: 'x', m: 'no-quota' })
    assert.equal(answer.ok, false)
    assert.match(answer.error, /رصيد حساب الـAI انتهى أو بلغ حد الصرف \(429\)/)
  })

  test('a provider that does not answer in time', async () => {
    process.env.TEST_TIMEOUT_MS = '600'
    try {
      const started = Date.now()
      const answer = await post({ b: ai.url, k: 'x', m: 'slow-button' })
      assert.equal(answer.ok, false)
      assert.match(answer.error, /لم يرد النموذج في الوقت المحدد/)
      assert.ok(Date.now() - started < 1400)
    } finally {
      process.env.TEST_TIMEOUT_MS = '5000'
    }
  })

  test('settings that make no sense, and a body too large', async () => {
    assert.equal((await post('{not json')).ok, false)
    assert.match((await post({ b: 'nope', k: 'x', m: 'y' })).error, /رابط مزود الـAI غير صحيح/)
    assert.match((await post({ b: ai.url, k: 'x', m: '' })).error, /اسم النموذج مطلوب/)
    assert.equal((await get('/api/test', { method: 'POST', body: 'x'.repeat(40_000) })).status, 413)
  })

  test('on a public server, a provider on the private network is refused before anything is sent', async () => {
    delete process.env.ALLOW_LOCAL_AI
    try {
      const calls = ai.calls.length
      const answer = await post({ b: ai.url, k: 'x', m: 'ok-private' })
      assert.equal(answer.ok, false)
      assert.match(answer.error, /https/)
      assert.match((await post({ b: 'https://127.0.0.1:1/v1', k: 'x', m: 'ok-private' })).error, /شبكة داخلية/)
      assert.equal(ai.calls.length, calls)
      // and the same guard stands in front of a translation
      const { notes } = await track(`${base}/${settings('ok-private')}/t/${link({ u: `${source.url}/file/3`, l: 'eng', t: 'movie', i: 'tt0000001' })}.vtt`)
      assert.match(notes[0].text, /تعذّر تجهيز الترجمة: رابط مزود الـAI يجب أن يبدأ بـ https/)
      assert.equal(ai.calls.length, calls)
    } finally {
      process.env.ALLOW_LOCAL_AI = '1'
    }
  })
})

describe('the wrong-episode guard', () => {
  test('a subtitle whose name says another episode is not listed; the rest are', async () => {
    const subtitles = await listed(settings('guard-list'), 'series/tt0000200%3A1%3A5')
    assert.deepEqual(subtitles.map(subtitle => subtitle.label), ['AI ⏳ · The.Quest.1080p.BluRay.x264-CLEAN'])
  })

  test('when every subtitle says another episode, the reason is said, and picking it translates nothing', async () => {
    const subtitles = await listed(settings('guard-allwrong'), 'series/tt0000201%3A1%3A5')
    assert.equal(subtitles.length, 1)
    assert.match(subtitles[0].label, /حلقة ثانية/)
    const calls = ai.calls.length
    const { notes, lines } = await track(subtitles[0].url)
    assert.deepEqual(lines, [])
    assert.match(notes[0].text, /ما تُترجم/)
    assert.equal(ai.calls.length, calls, 'the model is never asked')
  })

  test('a release named after the episode itself is accepted by name (anime wording)', async () => {
    const subtitles = await listed(settings('guard-name'), 'series/tt0000202%3A1%3A5')
    assert.deepEqual(subtitles.map(subtitle => subtitle.label), ['AI ⏳ · The.Quest.The.Long.Road.1080p.WEB-DL.x264-NAMEMATCH'])
  })

  test('an unsigned subtitle whose lines name another episode is refused; the neighbouring file is translated instead', async () => {
    const cfg = settings('guard-neighbour')
    const subtitles = await listed(cfg, 'series/tt0000200%3A1%3A5')
    const victim = subtitles.find(subtitle => subtitle.label.includes('CLEAN'))
    assert.ok(victim, 'the unsigned subtitle stays in the list')
    const before = source.hits.named.length
    const result = await untilComplete(victim.url)
    assertAllArabic(result.lines)
    assert.equal(result.kept, COMPLETE)
    const fetched = source.hits.named.slice(before)
    assert.ok(fetched.includes('/file/304'), 'the neighbour file that matches the episode is the one translated')
    assert.ok(!fetched.includes('/file/301'), 'the file for another episode is never read')
    assert.ok(ai.callsOf('guard-neighbour').some(call => JSON.stringify(call).includes('UNIQUE FOR THE RIGHT FILE')))
  })

  test('no matching file anywhere: the reason is said, and the model is never asked', async () => {
    const subtitles = await listed(settings('guard-nomatch'), 'series/tt0000203%3A1%3A5')
    assert.equal(subtitles.length, 1)
    const calls = ai.calls.length
    const { notes, lines } = await track(subtitles[0].url)
    assert.deepEqual(lines, [])
    assert.match(notes[0].text, /الملف الصح/)
    assert.equal(ai.calls.length, calls, 'the model is never asked')
  })

  test('the guard can be turned off', async () => {
    const cfg = settings('guard-off', { gd: 0 })
    const subtitles = await listed(cfg, 'series/tt0000200%3A1%3A5')
    const victim = subtitles.find(subtitle => subtitle.label.includes('CLEAN'))
    const result = await untilComplete(victim.url)
    assertAllArabic(result.lines)
    assert.ok(ai.callsOf('guard-off').length > 0)
  })
})

describe('المرحلة 5: ملاحظات المترجم، المزوّد الاحتياطي، والتقرير الشهري (27 · 34 · 38)', () => {
  test('with notes on, a finished translation carries the note on top of the screen — one extra request', async () => {
    const cfg = settings('ok-notes', { nt: 1 })
    const [{ url }] = await listed(cfg, 'movie/tt0000004')
    const result = await untilComplete(url)
    assert.equal(result.kept, COMPLETE)
    assertAllArabic(result.lines)
    const tops = result.notes.map(cue => cue.text)
    assert.deepEqual(tops.map(text => text.replace(/^\u200F/, '')), ['ملاحظة المترجم: نكتة يابانية ما تتترجم'])
    assert.equal(ai.notesOf('ok-notes').length, 1, 'one extra request for the notes, and exactly one')
  })

  test('with notes off, nothing extra is asked of the model', async () => {
    const cfg = settings('ok-nonotes')
    const [{ url }] = await listed(cfg, 'movie/tt0000005')
    const result = await untilComplete(url)
    assert.equal(result.kept, COMPLETE)
    assert.equal(result.notes.length, 0)
    assert.equal(ai.notesOf('ok-nonotes').length, 0)
  })

  test('a refused primary key: the backup finishes the episode on its own, without anyone doing anything', async () => {
    const backup = await startAi()
    try {
      const cfg = settings('bad-key', { fb: backup.url, fk: 'backup-key', fm: 'ok-backup' })
      const [{ url }] = await listed(cfg, 'movie/tt0000001')
      const result = await untilComplete(url)
      assert.equal(result.kept, COMPLETE)
      assertAllArabic(result.lines)
      assert.equal(backup.callsOf('ok-backup').length, BATCHES, 'the backup made the episode')
    } finally { await backup.close() }
  })

  test('a healthy primary never spends a token on the backup', async () => {
    const backup = await startAi()
    try {
      const cfg = settings('ok-backup-idle', { fb: backup.url, fk: 'backup-key', fm: 'ok-backup2' })
      const [{ url }] = await listed(cfg, 'movie/tt0000006')
      const result = await untilComplete(url)
      assert.equal(result.kept, COMPLETE)
      assert.equal(backup.calls.length, 0, 'not one request reached the backup')
    } finally { await backup.close() }
  })

  test('the monthly report: one episode counted, served-from-store counted, and the page rendered — all on this server alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tarjuman-report-'))
    const port = await new Promise(resolve => {
      const probe = createServer().listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)) })
    })
    const child = spawn(process.execPath, ['server.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port), QUIET: '', CACHE_DIR: dir } })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    try {
      for (let attempt = 0; attempt < 50 && !output.includes('listening'); attempt++) await pause(100)
      const freshBase = `http://127.0.0.1:${port}`
      const cfg = settings('ok-report')
      const list = await (await fetch(`${freshBase}/${cfg}/subtitles/movie/tt0000007.json`)).json()
      const url = list.subtitles[0].url.replace(base, freshBase)
      for (let attempt = 0; attempt < 40; attempt++) {         // first request translates; later ones are served from the store
        const response = await fetch(url); await response.text()
        if (response.headers.get('cache-control') === COMPLETE) break
        await pause(300)
      }
      const ledgerPath = join(dir, (await readdir(dir)).find(name => name.startsWith('report-')))
      const ledger = JSON.parse(await readFile(ledgerPath, 'utf8'))
      assert.equal(ledger.episodes, 1)
      assert.equal(ledger.film, 1)
      assert.equal(ledger.tv, 0)
      assert.equal(ledger.lines, expected.length)
      assert.equal(ledger.tokensP, ledger.requests * 10, 'the mock reports 10 prompt tokens per request')
      assert.equal(ledger.tokensC, ledger.requests * 20)
      assert.equal(ledger.withUsage, 1, 'the episode is counted once as a provider that reports usage')
      const hitsBefore = ledger.hits
      const cached = await fetch(url)                           // the cache serves it; nothing reaches the model
      assert.equal(cached.headers.get('cache-control'), COMPLETE)
      await cached.text()
      await pause(100)
      const again = JSON.parse(await readFile(ledgerPath, 'utf8'))
      assert.equal(again.hits, hitsBefore + 1, 'a serving from the store is one more time the memory saved the spend')
      const page = await (await fetch(`${freshBase}/${cfg}/report`)).text()
      assert.match(page, /تقرير ترجمان/)
      assert.match(page, /ترجمة مكتملة/)
      assert.match(page, /التوكنز/)
    } finally {
      child.kill()
    }
  })
})

describe('الأنمي والمصادر الإضافية (أفكار ٢٤ و٢٥)', () => {
  const decodeRef = url => JSON.parse(Buffer.from(url.split('/t/')[1].slice(0, -4), 'base64url').toString())

  test('معرّف أنمي من كتالوج Kitsu يُقبل ويُعرض ترجمات له', async () => {
    const subtitles = await listed(settings('kitsu-list'), 'series/kitsu%3A7442%3A1')
    assert.equal(subtitles.length, 2)
    assert.equal(decodeRef(subtitles[0].url).i, 'kitsu:7442:1')
  })

  test('SubDL يوسّع القائمة — مفتاح إضافي اختياري، بلا كسر', async () => {
    const subtitles = await listed(settings('subdl-merge', { sd: 'sd-key', n: 3 }), 'movie/tt0000999')
    assert.equal(subtitles.length, 3)
    const names = subtitles.map(s => s.id)
    assert.ok(names.some(name => name.includes('Attack.On.Titan.S01E01.1080p.WEB-DL')), JSON.stringify(names))
    // الرابط يحمل مفتاح SubDL لأن التنزيل يطلبه — داخل رابط الإضافة الذي لا يملكه غير صاحبه
    const extra = subtitles.find(s => s.id.includes('Attack.On.Titan'))
    assert.match(decodeRef(extra.url).u, /^https?:\/\/127\.0\.0\.1:\d+\/subtitle\/101\.zip\?api_key=sd-key/)
    assert.equal(decodeRef(extra.url).l, 'eng')
  })

  test('مفتاح SubDL خاطئ لا يُسقط القائمة — المصدر الرئيسي يكفي', async () => {
    const before = subdl.hits.length
    const subtitles = await listed(settings('subdl-fail', { sd: 'wrong-key', n: 3 }), 'movie/tt0000998')
    assert.equal(subtitles.length, 3)                       // المصدر الرئيسي وحده (3 إنجليزية في المحاكاة)
    assert.ok(subdl.hits.length > before, 'SubDL سُئل لكن فشله تُخطي بصمت')
  })

  test('Jimaku يعرض ملف الفانساب للحلقة — ويفهم kitsu مباشرة', async () => {
    const subtitles = await listed(settings('jimaku-list', { jm: 'jm-key', n: 3 }), 'series/kitsu%3A7442%3A1')
    const names = subtitles.map(s => s.id)
    assert.equal(subtitles.length, 3)
    assert.ok(names.some(name => name.includes('[SubsPlease] AoT - 01 (1080p)')), JSON.stringify(names))
    const jimakuSub = subtitles.find(s => s.id.includes('SubsPlease'))
    const ref = decodeRef(jimakuSub.url)
    assert.match(ref.u, /\/file\/77-1\.ass$/)
    assert.deepEqual({ i: ref.i, l: ref.l, t: ref.t }, { i: 'kitsu:7442:1', l: 'eng', t: 'series' })
    assert.ok(kitsu.hits.some(path => path.startsWith('/api/edge/anime/7442')), 'kitsu فُتحت لمعرفة anilist_id')
  })

  test('أنمي بمعرّف IMDb (tt2082624): SubDL باسم العمل + Jimaku عبر أنيلست — يطلع ولا شيء ينكسر', async () => {
    const subtitles = await listed(settings('imdb-anime', { sd: 'sd-key', jm: 'jm-key', n: 3 }), 'series/tt2082624%3A1%3A1')
    const names = subtitles.map(s => s.id)
    assert.ok(names.some(name => name.includes('Dog.Days.S01E01.1080p.TVRip')), JSON.stringify(names))
    assert.ok(names.some(name => name.includes('Dog Days - 01')), JSON.stringify(names))
    const dd = subtitles.find(su => su.id.includes('Dog Days - 01'))
    assert.match(decodeRef(dd.url).u, /\/file\/88-1\.ass$/)
  })

  test('تنزيل ملف Jimaku يحمل التصريح، والترجمة تكتمل', async () => {
    const subtitles = await listed(settings('jimaku-full', { jm: 'jm-key', n: 3 }), 'series/kitsu%3A7442%3A1')
    const jimakuSub = subtitles.find(s => s.id.includes('SubsPlease'))
    const { kept, lines } = await untilComplete(jimakuSub.url)
    assert.equal(kept, COMPLETE)
    assert.deepEqual(lines, [translated(0), translated(1)])   // سطران من حوار ASS
    assert.equal(jimaku.lastFileAuth, 'jm-key')
  })
})
