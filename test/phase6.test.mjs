// أفكار 24 و25: معرّفات كتالوجات الأنمي + مصادر الترجمة الإضافية (SubDL وJimaku) — كل شيء هنا ضد أوهام محلية
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { strToU8, zipSync } from 'fflate'
import { ID_OR_ANIME, animeEpisodeTitle, animeMeta, isAnimeId, parseAnimeId } from '../lib/anime.mjs'
import { decodeConfig, encodeConfig, normalize } from '../lib/config.mjs'
import { extraSubtitles, fetchExtraSubtitle, toLang3, unzipSubtitle } from '../lib/extraSources.mjs'
import { describeTitle } from '../lib/sources.mjs'
import { parseSubtitle, tidy } from '../lib/subs.mjs'
import { sampleSrt } from './mocks.mjs'

// fetch وهمي موزع بالاسم: يعطي كل مضيف استجابته — ولا يلمس الشبكة أبدًا
const withMockedFetch = async (handlers, run) => {
  const original = globalThis.fetch
  const DEBUG = process.env.DEBUG_FETCH === '1'
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url))
    if (DEBUG) console.log('FETCH →', u.host, u.pathname + u.search)
    const handler = handlers[u.host]
    if (!handler) throw new Error(`unmocked host: ${u.host}`)
    try {
      return await handler(u, init)
    } catch (error) {
      if (DEBUG) console.log('HANDLER-THREW:', error.message)
      throw error
    }
  }
  try { return await run() } finally { globalThis.fetch = original }
}
const json = body => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const kitsuHandlers = (anilistId = '16498') => ({
  'kitsu.test': u => {
    if (u.pathname === '/api/edge/anime/7442') {
      return json({ data: { id: '7442', attributes: { canonicalTitle: 'Attack on Titan', titles: { en: 'Attack on Titan', ja_jp: '進撃の巨人' }, startDate: '2013-04-07', synopsis: '<p>Humans fight <b>Titans</b>.</p>' } } })
    }
    if (u.pathname === '/api/edge/anime/7442/mappings') return json({ data: [{ attributes: { externalSite: 'anilist/anime', externalId: anilistId } }, { attributes: { externalSite: 'myanimelist/anime', externalId: '16498' } }] })
    if (u.pathname === '/api/edge/episodes') return json({ data: [{ attributes: { titles: { en_us: 'To You, in 2000 Years' } } }] })
    return new Response('nf', { status: 404 })
  },
  'graphql.anilist.co': (u, init) => {
    const query = String(JSON.parse(init.body || '{}').query || '')
    if (query.includes('Media(idMal:') || query.includes('Media(id:')) {
      return json({ data: { Media: { id: 16498, idMal: 16498, title: { romaji: 'Shingeki no Kyojin', english: 'Attack on Titan', native: '進撃の巨人' }, description: '<p>Walls.</p>', startDate: { year: 2013 } } } })
    }
    return json({ data: { Media: null } })
  },
})

describe('معرّفات كتالوجات الأنمي (فكرة ٢٤)', () => {
  test('الصيغ الثلاث مع ورقم الحلقة', () => {
    assert.deepEqual(parseAnimeId('kitsu:7442'), { family: 'kitsu', id: 7442, episode: null })
    assert.deepEqual(parseAnimeId('kitsu:7442:3'), { family: 'kitsu', id: 7442, episode: 3 })
    assert.deepEqual(parseAnimeId('mal:16498'), { family: 'mal', id: 16498, episode: null })
    assert.deepEqual(parseAnimeId('anilist:16498:12'), { family: 'anilist', id: 16498, episode: 12 })
    for (const bad of ['kitsu:', 'kitsu:7442:x', 'tt0000001', 'kitsu:7442:1:2', '', 'mal:9999999999']) assert.equal(parseAnimeId(bad), null, bad)
    assert.ok(isAnimeId('mal:16498') && !isAnimeId('tt0000001'))
  })

  test('ما يقبله الجدول مع tt<imdb>', () => {
    for (const good of ['tt0000001', 'tt1375666:3:12', 'kitsu:7442', 'kitsu:7442:1', 'mal:16498', 'anilist:16498:120']) assert.ok(ID_OR_ANIME.test(good), good)
    for (const bad of ['channel/tt0000001', 'kitsu:7442:1:2', 'xx:1', 'kitsu:', 'tt']) assert.ok(!ID_OR_ANIME.test(bad), bad)
  })

  test('animeMeta من Kitsu: العنوان والسنة وحلقة وربط anilist وmal', async () => {
    const meta = await withMockedFetch(kitsuHandlers('16498'), () => animeMeta('kitsu:7442:1', { kitsu: 'https://kitsu.test' }))
    assert.equal(meta.title, 'Attack on Titan')
    assert.equal(meta.year, 2013)
    assert.equal(meta.episode, 1)
    assert.equal(meta.anilistId, 16498)
    assert.equal(meta.malId, 16498)
    assert.equal(meta.about, 'Humans fight Titans.')          // وسوم HTML تُزال
  })

  test('animeMeta من MyAnimeList عبر أنيلست', async () => {
    const meta = await withMockedFetch(kitsuHandlers(), () => animeMeta('mal:16498:3', { anilist: 'https://graphql.anilist.co' }))
    assert.equal(meta.title, 'Attack on Titan')
    assert.equal(meta.anilistId, 16498)
    assert.equal(meta.malId, 16498)
    assert.equal(meta.episode, 3)
  })

  test('فشل الكتالوج لا يكسر — يعود أدنى معلومات والترجمة تكمل', async () => {
    const meta = await withMockedFetch({ 'kitsu.test': () => { throw new Error('down') } }, () => animeMeta('kitsu:7442:7', { kitsu: 'https://kitsu.test' }))
    assert.equal(meta.episode, 7)
    assert.equal(meta.title, '')
  })

  test('عنوان الحلقة من Kitsu (للحارس)', async () => {
    const title = await withMockedFetch(kitsuHandlers(), () => animeEpisodeTitle('kitsu:7442:1', { kitsu: 'https://kitsu.test' }))
    assert.equal(title, 'To You, in 2000 Years')
  })

  test('describeTitle يبني سطر «ما الذي تُترجمه» لأنمي', async () => {
    const about = await withMockedFetch(kitsuHandlers(), () => describeTitle({ type: 'series', id: 'kitsu:7442:1' }, { kitsu: 'https://kitsu.test' }))
    assert.match(about, /Attack on Titan \(2013\)/)
    assert.match(about, /episode 1/)
    assert.match(about, /Humans fight Titans/)
    assert.ok(!about.includes('<p>'), 'بلا وسوم HTML')
  })
})

describe('ملفات ASS (الفانساب)', () => {
  const ASS = `[Script Info]\nTitle: test\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.50,Default,,0,0,0,,Hello <i>world</i>!\nDialogue: 0,0:00:04.00,0:00:05.00,Signs,,0,0,0,,IGNORE THIS\nDialogue: 0,0:00:06.00,0:00:07.00,Default,,0,0,0,,First\\Nsecond line\nDialogue: 0,0:00:08.00,0:00:09.00,Default,,0,0,0,,note\\, with comma\nDialogue: 0,0:00:10.00,0:00:11.00,Default,,0,0,0,,{\\pos(100,200)}positioned line\n`

  test('الحوار فقط، بأوقات صحيحة، والإشارات تُستبعد', () => {
    const cues = parseSubtitle(ASS)
    assert.equal(cues.length, 4)
    assert.equal(cues[0].start, 1)
    assert.equal(cues[0].end, 3.5)
    assert.equal(cues[1].text, 'First\nsecond line')
    assert.equal(cues[2].text, 'note, with comma')
  })

  test('وسوم الموضع تُزال في التنظيف', () => {
    const cues = tidy(parseSubtitle(ASS), { dropSounds: true })
    assert.equal(cues.at(-1).text, 'positioned line')
  })

  test('ملف ليس ASS يظل يُقرأ كالمعتاد', () => {
    const cues = parseSubtitle('1\n00:00:01,000 --> 00:00:02,000\nHello\n')
    assert.equal(cues.length, 1)
  })
})

describe('حزم SubDL', () => {
  const srt = strToU8(sampleSrt(2))
  const ass = strToU8('[Events]\nFormat: Layer, Start, End, Style, Text\nDialogue: 0,0:00:01,0:00:02,Default,,hi\n')

  test('الأفضل srt أولًا، ومع تفضيل لغة', () => {
    const zip = zipSync({ 'show.fr.srt': strToU8('FRENCH-SUBTITLE'), 'show.en.srt': strToU8('ENGLISH-SUBTITLE'), 'show.ass': ass })
    assert.equal(unzipSubtitle(Buffer.from(zip)), 'ENGLISH-SUBTITLE')
    assert.equal(unzipSubtitle(Buffer.from(zip), 'fre'), 'FRENCH-SUBTITLE')
    const assOnly = zipSync({ 'show.ass': ass })
    assert.equal(unzipSubtitle(Buffer.from(assOnly)), new TextDecoder().decode(ass))
  })

  test('حزمة بلا ملف ترجمة مدعوم تُرفض بأدب', () => {
    const zip = zipSync({ 'readme.txt': strToU8('nope') })
    assert.throws(() => unzipSubtitle(Buffer.from(zip)), /الحزمة/)
  })
})

describe('المصادر الإضافية (فكرة ٢٥)', () => {
  test('بدون مفاتيح: قائمة فارغة ولا نداء شبكة إطلاقًا', async () => {
    const original = globalThis.fetch
    globalThis.fetch = () => { throw new Error('لا يُسمح بنداء شبكة') }
    try {
      assert.deepEqual(await extraSubtitles({ type: 'movie', id: 'tt0000001' }, {}), [])
      assert.deepEqual(await extraSubtitles({ type: 'series', id: 'kitsu:7442:1' }, {}), [])
    } finally { globalThis.fetch = original }
  })

  test('SubDL: البحث وما يُعاد منه وتخطي الأخطاء', async () => {
    const data = await withMockedFetch({
      'subdl.test': u => {
        assert.equal(u.searchParams.get('api_key'), 'sd-key')
        assert.equal(u.searchParams.get('imdb_id'), 'tt0000999')
        return json({ status: 200, subtitles: [
          { url: '/subtitle/101.zip', lang: 'EN', release_name: 'Attack.On.Titan.S01E01.WEB', file: 'aot.en.srt' },
          { url: '/subtitle/102.zip', lang: 'FR', release_name: 'French.Release', file: 'aot.fr.srt' },
          { url: '/subtitle/103.zip', lang: 'XX', release_name: 'Mystery', file: 'x.srt' },   // لغة غير معروفة: تُقبل كـ xx؟ لا — LANG3 ليس فيها، تُمرر كما هي؟ تُرفض
        ] })
      },
    }, () => extraSubtitles({ type: 'movie', id: 'tt0000999' }, { sd: 'sd-key' }, { subdl: 'https://subdl.test' }))
    const byLang = Object.fromEntries(data.map(d => [d.lang, d]))
    assert.match(byLang.eng.url, /^https:\/\/subdl\.test\/subtitle\/101\.zip\?api_key=sd-key/)
    assert.equal(byLang.fre.lang, 'fre')
    assert.equal(byLang.xx, undefined)   // رمز غير معروف يُسقط
  })

  test('SubDL بقائمة فاشلة لا يُسقط شيئًا — ترجع قائمة فارغة', async () => {
    const data = await withMockedFetch({ 'subdl.test': () => new Response('down', { status: 500 }) }, () => extraSubtitles({ type: 'movie', id: 'tt0000888' }, { sd: 'sd-key' }, { subdl: 'https://subdl.test' }))
    assert.deepEqual(data, [])
  })

  test('Jimaku: kitsu → anilist عبر أنيلست ثم قائمة الملفات', async () => {
    const data = await withMockedFetch({
      ...kitsuHandlers(),
      'jimaku.test': u => {
        if (u.pathname === '/api/entries/search') return json([{ id: 77, anilist_id: 16498, name: 'Shingeki no Kyojin' }])
        if (u.pathname === '/api/entries/77/files') {
          assert.equal(u.searchParams.get('episode'), '1')
          return json([{ name: '[SubsPlease] AoT - 01 (1080p).ass', size: 1000, url: '/file/77-1.ass' }])
        }
        return new Response('nf', { status: 404 })
      },
    }, () => extraSubtitles({ type: 'series', id: 'kitsu:7442:1' }, { jm: 'jm-key' }, { kitsu: 'https://kitsu.test', anilist: 'https://graphql.anilist.co', jimaku: 'https://jimaku.test' }))
    assert.equal(data.length, 1)
    assert.equal(data[0].lang, 'eng')
    assert.match(data[0].url, /^https:\/\/jimaku\.test\/file\/77-1\.ass$/)
  })

  test('fetchExtraSubtitle: فك حزمة SubDL وإرجاع النص', async () => {
    const zip = zipSync({ 'aot.en.srt': strToU8('1\n00:00:01,000 --> 00:00:02,000\nHello there\n') })
    const text = await withMockedFetch({
      'subdl.test': () => new Response(Buffer.from(zip), { status: 200 }),
    }, () => fetchExtraSubtitle('https://subdl.test/subtitle/101.zip?api_key=sd-key', { sd: 'sd-key' }, { allow: /^https:\/\// }, { subdl: 'https://subdl.test' }))
    assert.match(text, /Hello there/)
  })

  test('fetchExtraSubtitle: ملف Jimaku يُنزّل بترويسة التصريح', async () => {
    let seen = ''
    const text = await withMockedFetch({
      'jimaku.test': (u, init) => { seen = init.headers?.authorization || ''; return new Response('hello jimaku', { status: 200 }) },
    }, () => fetchExtraSubtitle('https://jimaku.test/file/77-1.ass', { jm: 'jm-key' }, { allow: /^https:\/\// }, { jimaku: 'https://jimaku.test' }))
    assert.equal(seen, 'jm-key')
    assert.equal(text, 'hello jimaku')
  })

  test('fetchExtraSubtitle يرفض مضيفًا غير مسموح', async () => {
    await assert.rejects(() => fetchExtraSubtitle('https://evil.example/x.srt', {}, { allow: /^https:\/\/allowed\.example\// }), /not allowed/)
  })
})

describe('اللغات والمفاتيح', () => {
  test('toLang3', () => {
    assert.equal(toLang3('EN'), 'eng')
    assert.equal(toLang3('english'), 'eng')
    assert.equal(toLang3('pt-br'), 'pob')
    assert.equal(toLang3('FR'), 'fre')
    assert.equal(toLang3('fra'), 'fre')
    assert.equal(toLang3('deu'), 'ger')
    assert.equal(toLang3('pob'), 'pob')
    assert.equal(toLang3('ara'), 'ara')
    assert.equal(toLang3(''), null)
    assert.equal(toLang3('klingon??'), null)
  })

  test('مفاتيح SubDL وJimaku تعبر الرابط والحفظ', () => {
    const cfg = normalize({ b: 'https://api.example.com/v1', m: 'model', sd: ' sd-key ', jm: ' jm-key ' })
    assert.equal(cfg.sd, 'sd-key')
    assert.equal(cfg.jm, 'jm-key')
    const round = decodeConfig(encodeConfig({ ...cfg }))
    assert.equal(round.sd, 'sd-key')
    assert.equal(round.jm, 'jm-key')
    assert.equal(normalize({ b: 'https://api.example.com/v1', m: 'model', sd: 'x'.repeat(200) }).sd.length, 120)   // الأطول يُقتصّ
  })
})

describe('أنمي بمعرّف IMDb — المسار العامل بأي كتالوج', () => {
  const imdbHandlers = (genres, name = 'Dog Days', year = '2011', id = 'tt2082624') => ({
    'subdl.test': u => {
      if (u.searchParams.has('imdb_id')) return json({ status: 200, subtitles: [] })   // Dog Days غير مربوط بـimdb في SubDL
      assert.equal(u.searchParams.get('film_name'), name)
      assert.equal(u.searchParams.get('year'), year)
      return json({ status: 200, subtitles: [{ url: '/subtitle/201.zip', lang: 'EN', release_name: 'Dog.Days.S01E01.1080p.TVRip', file: 'dd.en.srt' }] })
    },
    'cinemeta.test': u => u.pathname === `/meta/series/${id}.json`
      ? json({ meta: { name, releaseInfo: year, genres } })
      : new Response('nf', { status: 404 }),
    'graphql.anilist.co': (u, init) => {
      const q = String(JSON.parse(init.body || '{}').query || '')
      const search = /media\(search:/i.test(q) || q.includes('Media(search')
      if (search) return json({ data: { Page: { media: [{ id: 10155, title: { english: 'Dog Days' }, startDate: { year: 2011 } }] } } })
      return json({ data: { Page: { media: [] } } })
    },
    'jimaku.test': u => {
      if (u.pathname === '/api/entries/search') { assert.equal(u.searchParams.get('anilist_id'), '10155'); return json([{ id: 88, anilist_id: 10155, name: 'Dog Days' }]) }
      if (u.pathname === '/api/entries/88/files') return json([{ name: '[HorribleSubs] Dog Days - 01 [720p].ass', size: 1500, url: '/file/88-1.ass' }])
      return new Response('nf', { status: 404 })
    },
  })
  const urls = { subdl: 'https://subdl.test', meta: 'https://cinemeta.test', anilist: 'https://graphql.anilist.co', jimaku: 'https://jimaku.test' }

  test('النوع Animation ⇒ SubDL بالاسم والسنة + Jimaku عبر بحث أنيلست — وتطلع نتائج', async () => {
    const data = await withMockedFetch(imdbHandlers(['Animation', 'Action']), () =>
      extraSubtitles({ type: 'series', id: 'tt2082624:1:1', empty: true }, { sd: 'sd-key', jm: 'jm-key' }, urls))
    const names = data.map(d => d.movieReleaseName).join(' | ')
    assert.ok(names.includes('Dog.Days.S01E01'), names)
    assert.ok(names.includes('[HorribleSubs] Dog Days - 01'), names)
  })

  test('النوع Drama (مو أنمي) ⇒ Jimaku لا يُسأل، وSubDL يكتفي بالاسم والسنة', async () => {
    const handlers2 = imdbHandlers(['Drama'], 'Dog Days', '2011', 'tt2082625')
    handlers2['graphql.anilist.co'] = () => { throw new Error('أنيلست لا يُستدعى') }
    const data = await withMockedFetch(handlers2, () =>
      extraSubtitles({ type: 'series', id: 'tt2082625:1:1', empty: true }, { sd: 'sd-key', jm: 'jm-key' }, urls))
    assert.deepEqual(data.map(d => d.movieReleaseName), ['Dog.Days.S01E01.1080p.TVRip'])
  })

  test('empty=false ⇒ لا استعلام إضافي إطلاقًا (cinemeta/أنيلست ما تُلمس)', async () => {
    const handlers = imdbHandlers(['Animation'], 'Dog Days', '2011', 'tt2082626')
    handlers['cinemeta.test'] = () => { throw new Error('لا يُفترض أن يُطلب cinemeta') }
    handlers['graphql.anilist.co'] = () => { throw new Error('لا يُفترض أن يُطلب أنيلست') }
    const data = await withMockedFetch(handlers, () =>
      extraSubtitles({ type: 'series', id: 'tt2082626:1:1', empty: false }, { sd: 'sd-key', jm: 'jm-key' }, urls))
    assert.deepEqual(data, [])   // imdb فاضي ولا إعادة باسم ولا بحث أنيلست ⇒ فاضي بلا أي طلبات إضافية
  })

  test('فشل cinemeta لا يكسر — ترجع [] بأدب', async () => {
    const handlers = imdbHandlers(['Animation'], 'Dog Days', '2011', 'tt2082627')
    handlers['cinemeta.test'] = () => new Response('down', { status: 500 })
    const data = await withMockedFetch(handlers, () =>
      extraSubtitles({ type: 'series', id: 'tt2082627:1:1', empty: true }, { sd: 'sd-key', jm: 'jm-key' }, urls))
    assert.deepEqual(data, [])
  })
})
