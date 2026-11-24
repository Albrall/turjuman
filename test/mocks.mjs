// Stand-ins for the two outside services, so the tests run offline and the same way every time:
//  - an AI provider in the OpenAI format, whose behaviour is chosen by the model's name
//  - the subtitles source (list + file) and the titles catalogue

import { createServer } from 'node:http'

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)))
const readJson = req => new Promise(resolve => {
  let body = ''
  req.on('data', chunk => { body += chunk })
  req.on('end', () => resolve(JSON.parse(body || '{}')))
})

// What a correct model answers for line <id>
export const fake = id => `ترجمة ${id}`

// What the stand-in model makes of any subtitle it is asked to brief
export const BRIEF = {
  names: [
    { name: 'Mary', arabic: 'ماري', kind: 'woman' },
    { name: 'Hope', arabic: 'هوب', kind: 'woman' },
    { name: 'Mr. Stone', arabic: 'السيد ستون', kind: 'man' },
    { name: 'Paris', arabic: 'باريس', kind: 'place' },
    { name: 'Al', arabic: 'آل', kind: 'something else' },
  ],
  terms: [{ term: 'the long road', arabic: 'الطريق الطويل' }],
}

export const startAi = async () => {
  const calls = []          // every translation request received
  const briefs = []         // every request for a translator's brief
  const noteCalls = []      // every request for the translator's notes (idea 27)
  const seen = new Set()    // "model:id" pairs already asked for, to misbehave the first time only
  let failuresLeft = 0      // for the model "flaky-key"
  const open = {}, peaks = {}   // per model: requests being answered now, and the most there were at once
  const server = createServer(async (req, res) => {
    const body = await readJson(req)
    const brief = (body.messages?.[0]?.content || '').includes("translator's brief")
    const notes = (body.messages?.[0]?.content || '').includes("translator's editor")
    ;(notes ? noteCalls : brief ? briefs : calls).push(body)
    open[body.model] = (open[body.model] || 0) + 1
    peaks[body.model] = Math.max(peaks[body.model] || 0, open[body.model])
    res.on('close', () => { open[body.model]-- })
    const reply = (status, data, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(data)) }
    const refuse = (status, message, headers) => reply(status, { error: { message } }, headers)
    if (!req.url.endsWith('/chat/completions')) return refuse(404, 'no such route')

    const { model } = body
    const lines = brief || notes ? {} : JSON.parse(body.messages.at(-1).content).lines
    const ids = brief ? ['brief'] : Object.keys(lines)
    const firstTime = id => { const key = `${model}:${id}`; const fresh = !seen.has(key); seen.add(key); return fresh }
    // A good model writes the names it was given where they occur. "names-slip" forgets until it is asked again; "names-never" always does.
    const request = brief ? {} : JSON.parse(body.messages.at(-1).content)
    const forgets = model.startsWith('names-never') || (model.startsWith('names-slip') && !request.note)
    const named = id => Object.entries(forgets ? {} : request.names || {}).filter(([name]) => lines[id].includes(name)).map(([, entry]) => ` ${entry.arabic}`).join('')
    const answer = Object.fromEntries(ids.map(id => [id, brief ? '' : fake(id) + named(id)]))
    const content = text => reply(200, { choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } })

    // A provider with a filter in front of the model. The filter reads all that a request says — the lines and their
    // neighbours alike, without knowing it is a film — and turns the whole request down for one line. "…strict…" objects to
    // the word FLAGGED; "refuses-all…" to every batch; "refuses-everything…" to the brief as well. Each provider says it
    // in its own way: OpenAI (the default here), OpenRouter, or inside an answer that otherwise looks fine.
    const said = body.messages.at(-1).content
    const objects = model.startsWith('refuses-everything') || (model.startsWith('refuses-all') && !brief) || /FLAGGED/.test(said)
    const turnDown = () => {
      body.turnedDown = true
      if (model.includes('openrouter')) return reply(403, { error: { code: 403, message: 'openai/gpt-6-luna requires moderation on OpenAI. Your input was flagged for "violence". No credits were charged.', metadata: { reasons: ['violence'], flagged_input: 'Line number … is FLAGGED', provider_name: 'OpenAI', model_slug: 'openai/gpt-6-luna' } } })
      if (model.includes('inband')) return reply(200, { choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'content_filter' }] })
      if (model.includes('declines')) return reply(200, { choices: [{ message: { role: 'assistant', content: null, refusal: "I'm sorry, I can't help with that." }, finish_reason: 'stop' }] })
      return reply(400, { error: { message: 'Invalid prompt: your prompt was flagged as potentially violating our usage policy. Please try again with a different prompt: https://platform.openai.com/docs/guides/reasoning#advice-on-prompting', type: 'invalid_request_error', param: null, code: 'invalid_prompt' } })
    }
    // OpenAI's models of late 2026, as their answers are reported: they think by default, take no temperature while they
    // think, know the efforts none to max but not "minimal", and have the filter in front
    if (model.startsWith('openai-5.6')) {
      const efforts = ['none', 'low', 'medium', 'high', 'xhigh', 'max']
      const wrong = (message, param, code) => reply(400, { error: { message, type: 'invalid_request_error', param, code } })
      if (body.reasoning_effort !== undefined && !efforts.includes(body.reasoning_effort)) return wrong(`Unsupported value: 'reasoning_effort' does not support '${body.reasoning_effort}' with this model. Supported values are: 'none', 'low', 'medium', 'high', 'xhigh', and 'max'.`, 'reasoning_effort', 'unsupported_value')
      if (body.temperature !== undefined && (body.reasoning_effort ?? 'medium') !== 'none') return wrong("Unsupported parameter: 'temperature' is not supported with this model.", 'temperature', null)
      if (objects) return turnDown()
    }
    if ((model.includes('strict') || model.startsWith('refuses')) && objects) return turnDown()
    if (model === 'no-quota') return reply(429, { error: { message: 'You exceeded your current quota, please check your plan and billing details.', type: 'insufficient_quota', param: null, code: 'insufficient_quota' } })

    if (model === 'bad-key') return refuse(401, 'Incorrect API key provided')
    if (model === 'flaky-key' && failuresLeft-- > 0) return refuse(401, 'Incorrect API key provided')
    if (model === 'no-credit') return refuse(402, 'Insufficient credits')
    if (model === 'missing-model') return refuse(404, 'The model does not exist')
    if (model === 'no-json' && body.response_format) return refuse(400, 'response_format is not supported by this model')
    if (model === 'no-temperature' && body.temperature !== undefined) return refuse(400, "Unsupported value: 'temperature' does not support 0.2")
    if (model === 'no-effort' && body.reasoning_effort) return refuse(400, 'Unknown parameter: reasoning_effort')
    if (model === 'picky' && (body.response_format || body.temperature !== undefined || body.reasoning_effort)) return refuse(422, 'invalid request')
    if (model === 'rate-429' && firstTime(ids[0])) return refuse(429, 'Too many requests', { 'retry-after': '2' })
    if (model === 'rate-402' && firstTime(ids[0])) return refuse(402, 'Free limit reached: 1 reply every 45 seconds', { 'retry-after': '3' })
    if (model === 'overloaded' && firstTime(ids[0])) return refuse(503, 'The model is overloaded')
    if (model.startsWith('slow')) await new Promise(done => setTimeout(done, 1500))
    if (model.startsWith('lag')) await new Promise(done => setTimeout(done, 150))
    if (notes) return content(JSON.stringify([{ find: 'ترجمة 3', note: 'نكتة يابانية ما تتترجم' }]))
    if (brief) {
      if (model.startsWith('brief-down')) return refuse(500, 'The model is overloaded')
      if (model.startsWith('brief-slow')) await new Promise(done => setTimeout(done, 1200))
      if (model.startsWith('brief-garbage')) return content('I could not find any names, sorry.')
      return content(JSON.stringify(BRIEF))
    }
    if (model === 'drop') for (const id of ids) if (Number(id) % 3 === 0 && firstTime(id)) delete answer[id]
    if (model === 'echo' && firstTime(ids[0])) return content(JSON.stringify(lines))
    // "no-arabic" hands every line back as it came; "keeps-two" does so for lines 4 and 7 only, as for a brand or a sound
    if (model === 'no-arabic') return content(JSON.stringify(lines))
    if (model === 'keeps-two') for (const id of ids) if (id === '4' || id === '7') answer[id] = lines[id]
    if (model === 'fenced') return content(`Here is the translation you asked for:\n\`\`\`json\n${JSON.stringify(answer, null, 2)}\n\`\`\`\nLet me know if you need anything else.`)
    if (model === 'nested') return content(JSON.stringify({ translations: answer }))
    // cut off mid-answer, as when a model runs out of output tokens: only on full batches, so that asking for the rest works
    if (model === 'cut' && ids.length >= 10) return content(JSON.stringify(answer).slice(0, Math.floor(JSON.stringify(answer).length * 0.6)))
    if (model === 'parts') return reply(200, { choices: [{ message: { content: [{ type: 'text', text: JSON.stringify(answer) }] } }] })
    if (model === 'empty' && firstTime(ids[0])) return reply(200, { choices: [{ message: { content: null } }] })
    if (model === 'garbage' && firstTime(ids[0])) return content('I am sorry, I cannot help with that.')
    content(JSON.stringify(answer))
  })
  const url = await listen(server)
  return {
    url, calls,
    callsOf: model => calls.filter(call => call.model === model),
    briefsOf: model => briefs.filter(call => call.model === model),
    notesOf: model => noteCalls.filter(call => call.model === model),
    peakOf: model => peaks[model] || 0,
    failNext: count => { failuresLeft = count },
    close: () => new Promise(done => { server.closeAllConnections(); server.close(done) }),
  }
}

// ───────── a made-up subtitle ─────────

const LINES = [
  'Did you hear that noise outside?',
  'I think someone is at the door.',
  "- Who is it?\n- It's me, open up.",
  '<i>We have been waiting here for hours.</i>',
  '{\\an8}Meet me at the station at nine.',
  '[door creaks]',
  'MARY: Where did you put the map?',
  '♪♪',
  'The bridge is closed, so we take the long road.',
  '<font color="#ffff00">Keep your voice down.</font>',
  "(sighs) I don't know what to tell you.",
  'Nobody leaves until we find it.',
]
const AD = 'Subtitles by www.example-subs.com'

const srtStamp = seconds => {
  const ms = Math.round(seconds * 1000)
  const pad = (value, width = 2) => String(value).padStart(width, '0')
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`
}

// swaps: lines to put in place of the usual ones, by position
export const sampleSrt = (count = 130, swaps = {}) => '\uFEFF' + Array.from({ length: count }, (_, i) => {
  const start = 4 + i * 4
  return `${i + 1}\r\n${srtStamp(start)} --> ${srtStamp(start + 2.5)}\r\n${swaps[i] ?? (i === 1 ? AD : LINES[i % LINES.length])}\r\n`
}).join('\r\n')

// ملف متعدد الحلقات متصل التوقيت: 200 cue تمتد على ~66 دقيقة
export const multiEpisodeSrt = () => '\uFEFF' + Array.from({ length: 200 }, (_, i) => {
  const start = i * 20
  return `${i + 1}\r\n${srtStamp(start)} --> ${srtStamp(start + 19.5)}\r\n${LINES[i % LINES.length]}\r\n`
}).join('\r\n')

// حزمة 1–N في ملف واحد: إما أن يعيد التوقيت من الصفر عند كل حلقة، أو يستمر عبر الحلقات.
// 60 سطراً لكل حلقة × 10 ثوانٍ ⇒ 10 دقائق/حلقة، وأكثر من 150 سطراً في الملف الواحد.
export const packSrt = ({ episodes = 3, per = 60, continuous = false, lang = 'eng' } = {}) =>
  '\uFEFF' + Array.from({ length: episodes * per }, (_, i) => {
    const episode = Math.floor(i / per) + 1
    const line = i % per
    const start = (continuous ? (episode - 1) * 600 : 0) + line * 10
    const text = lang === 'ara' ? `سطر ${episode} رقم ${line}` : `PART${episode} LINE ${line}`
    return `${i + 1}\r\n${srtStamp(start)} --> ${srtStamp(start + 2.5)}\r\n${text}\r\n`
  }).join('\r\n')

// The subtitle of the title tt0000066: the usual one, with a line that a provider's filter objects to
export const ROUGH = { 40: 'Tell me how the FLAGGED thing is made.' }

export const startSource = async () => {
  const hits = { list: [], file: 0, meta: 0, named: [] }
  let origin
  const server = createServer((req, res) => {
    const reply = (status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)) }
    const path = req.url.split('?')[0]
    if (path.startsWith('/subtitles/')) {
      hits.list.push(path)
      if (path.includes('tt0000404')) return reply(200, { subtitles: [] })
      if (path.includes('tt0000500')) return reply(500, { error: 'down' })
      if (path.includes('tt2082624')) return reply(200, { subtitles: [] })
      const sub = (id, lang, release, extra = {}) => ({ id: String(id), url: `${origin}/file/${id}`, lang, movieReleaseName: release, subtitleFileName: `${release}.srt`, m: 'i', ...extra })
      if (path.includes('tt0000033')) return reply(200, { subtitles: [sub(31, 'fre', 'Le.Film.2020.1080p.BluRay'), sub(32, 'ara', 'Le.Film.2020.Arabic')] })
      // 번역: عنوان بعربية مزيفة (محتوى إنكليزي مصنف عربي) — تُستبعد بعد التحقق
      if (path.includes('tt0000040')) return reply(200, { subtitles: [sub(999, 'ara', 'Fake.Arabic.English.Content'), sub(31, 'fre', 'Fake.Arabic.English.Content')] })
      // فيلم بترجمة عربية متعددة الحلقات — تُستبعد بعد التحقق من عدد الإشارات
      if (path.includes('tt0000045')) return reply(200, { subtitles: [sub(888, 'ara', 'Multi.Episode.File.S01E01-E13'), sub(31, 'fre', 'Multi.Episode.File.S01E01-E13')] })
      if (path.includes('tt0000022')) return reply(200, { subtitles: [sub(21, 'eng', 'Twin.Film.2021.1080p.WEB'), sub(22, 'eng', 'Twin.Film.2021.1080p.WEB')] })
      if (path.includes('tt0000066')) return reply(200, { subtitles: [sub(66, 'eng', 'Rough.Film.2022.1080p.WEB')] })
      if (path.includes('tt0000200')) {
        // A series whose requests for season 1 episode 5 list: one subtitle clearly for episode 4, one clean but unsigned
        const id = decodeURIComponent(path.split('/subtitles/series/')[1].replace(/\.json$/, ''))
        if (id === 'tt0000200:1:5') return reply(200, { subtitles: [
          sub(301, 'eng', 'The.Quest.S01E04.1080p.BluRay.x264-WRONG'),
          sub(303, 'eng', 'The.Quest.1080p.BluRay.x264-CLEAN'),
        ] })
        // The file that IS episode 5, uploaded under episode 4's page — the "neighbouring episode" case
        if (id === 'tt0000200:1:4') return reply(200, { subtitles: [
          sub(304, 'eng', 'The.Quest.S01E05.1080p.WEB-DL.x264-RIGHT'),
        ] })
        return reply(200, { subtitles: [] })
      }
      // حزمة حلقات تُعيد التوقيت عند كل حلقة (S01E01-E03)، عربية جاهزة وإنجليزية للترجمة
      if (path.includes('tt0000210')) {
        const id = decodeURIComponent(path.split('/subtitles/series/')[1].replace(/\.json$/, ''))
        if (id === 'tt0000210:1:3') return reply(200, { subtitles: [
          sub(881, 'ara', 'Overlord.S01E01-E03.1080p.WEB-PACK'),
          sub(882, 'eng', 'Overlord.S01E01-E03.1080p.WEB-PACK'),
        ] })
        return reply(200, { subtitles: [] })
      }
      // حزمة حلقات بتوقيت متصل (S01E01-E13)
      if (path.includes('tt0000211')) {
        const id = decodeURIComponent(path.split('/subtitles/series/')[1].replace(/\.json$/, ''))
        if (id === 'tt0000211:1:3') return reply(200, { subtitles: [
          sub(884, 'ara', 'Overlord.S01E01-E13.1080p.WEB-PACK'),
          sub(883, 'eng', 'Overlord.S01E01-E13.1080p.WEB-PACK'),
        ] })
        return reply(200, { subtitles: [] })
      }
      // A series whose requests for season 1 episode 5 list only subtitles clearly for episode 4
      if (path.includes('tt0000201')) return reply(200, { subtitles: [sub(305, 'eng', 'The.Quest.S01E04.1080p.BluRay.x264-WRONG')] })
      if (path.includes('tt0000202')) {
        const id = decodeURIComponent(path.split('/subtitles/series/')[1].replace(/\.json$/, ''))
        if (id === 'tt0000202:1:5') return reply(200, { subtitles: [sub(306, 'eng', 'The.Quest.The.Long.Road.1080p.WEB-DL.x264-NAMEMATCH')] })
        return reply(200, { subtitles: [] })
      }
      // A series whose requested episode and every neighbouring one have only the unsigned file
      // A series whose theme song shows up in the subtitle file (idea 5), and a next episode (idea 10)
      if (path.includes('tt0000205')) {
        const id = decodeURIComponent(path.split('/subtitles/series/')[1].replace(/\.json$/, ''))
        if (id === 'tt0000205:1:5') return reply(200, { subtitles: [sub(403, 'eng', 'The.Quest.S01E05.1080p.WEB-DL.x264-SONGOP'), sub(405, 'eng', 'Song.Test.Show.Decoy.S01E05.1080p')] })
        if (id === 'tt0000205:1:6') return reply(200, { subtitles: [sub(404, 'eng', 'The.Quest.S01E06.1080p.WEB-DL.x264-NEXTEP')] })
        return reply(200, { subtitles: [] })
      }
      // A show with an entry in the stand-in AniList, for the name dictionary: two clean files, one per episode
      if (path.includes('tt0000204')) {
        const id = decodeURIComponent(path.split('/subtitles/series/')[1].replace(/\.json$/, ''))
        if (id === 'tt0000204:1:5') return reply(200, { subtitles: [sub(401, 'eng', 'The.Quest.S01E05.1080p.BluRay.x264-DICT1')] })
        if (id === 'tt0000204:1:3') return reply(200, { subtitles: [sub(402, 'eng', 'The.Quest.S01E03.1080p.BluRay.x264-DICT2')] })
        return reply(200, { subtitles: [] })
      }
      if (path.includes('tt0000203')) {
        const id = decodeURIComponent(path.split('/subtitles/series/')[1].replace(/\.json$/, ''))
        if (id === 'tt0000203:1:5') return reply(200, { subtitles: [sub(307, 'eng', 'The.Quest.1080p.BluRay.x264-CLEAN2')] })
        return reply(200, { subtitles: [] })
      }
      return reply(200, { subtitles: [
        sub(1, 'eng', 'Some.Film.2020.CAM.XviD-GRP'),
        sub(2, 'eng', 'Some.Film.2020.1080p.WEB-DL.x264-OTHER'),
        sub(3, 'eng', 'Some.Film.2020.1080p.BluRay.x264-SPARKS'),
        sub(4, 'spa', 'Some.Film.2020.1080p.BluRay.x264-SPARKS'),
        { id: '5', url: 'https://elsewhere.example/file/5', lang: 'eng', movieReleaseName: 'Some.Film.2020.1080p.BluRay.x264-SPARKS' },
      ] })
    }
    if (path.startsWith('/file/')) {
      hits.file++
      hits.named.push(path)
      if (path === '/file/9') return reply(200, 'this is not a subtitle', 'text/plain')
      if (path === '/file/66') return reply(200, sampleSrt(130, ROUGH), 'text/plain; charset=utf-8')
      if (path === '/file/403') return reply(200, sampleSrt(60, { 10: '♪ The hero sings his name ♪', 11: '♪ Through every mountain high ♪', 12: '♪ Nothing can stop the song ♪', 13: '♪ We walk into the night ♪' }), 'text/plain; charset=utf-8')
      if (path === '/file/404') return reply(200, sampleSrt(60), 'text/plain; charset=utf-8')
      if (path === '/file/303') return reply(200, sampleSrt(130, { 0: 'S01E04' }), 'text/plain; charset=utf-8')
      if (path === '/file/304') return reply(200, sampleSrt(130, { 0: 'UNIQUE FOR THE RIGHT FILE' }), 'text/plain; charset=utf-8')
      if (path === '/file/307') return reply(200, sampleSrt(130, { 0: 'S01E04' }), 'text/plain; charset=utf-8')
      if (path === '/file/32') return reply(200, '1\n00:00:01,000 --> 00:00:03,000\nمرحباً بالعالم\n', 'text/plain; charset=utf-8')
      if (path === '/file/999') return reply(200, sampleSrt(3), 'text/plain; charset=utf-8')
      // ملف متعدد الحلقات: 200 cue تمتد على أكثر من 60 دقيقة (مثل حلقات 1–13 في ملف واحد)
      if (path === '/file/888') return reply(200, multiEpisodeSrt(), 'text/plain; charset=utf-8')
      if (path === '/file/881') return reply(200, packSrt({ episodes: 3, lang: 'ara' }), 'text/plain; charset=utf-8')
      if (path === '/file/882') return reply(200, packSrt({ episodes: 3 }), 'text/plain; charset=utf-8')
      if (path === '/file/883') return reply(200, packSrt({ episodes: 13, continuous: true }), 'text/plain; charset=utf-8')
      if (path === '/file/884') return reply(200, packSrt({ episodes: 13, continuous: true, lang: 'ara' }), 'text/plain; charset=utf-8')
      return reply(200, sampleSrt(), 'text/plain; charset=utf-8')
    }
    if (path.startsWith('/meta/series/tt0000200')) return reply(200, { meta: {
      name: 'The Quest', releaseInfo: '2024', genres: ['Animation'], description: 'A quiet journey across the mountains to bring back the king.',
      videos: [
        { season: 1, episode: 3, name: 'The Way In', overview: 'The party sets off.' },
        { season: 1, episode: 4, name: 'The Bridge', overview: 'The bridge is out.' },
        { season: 1, episode: 5, name: 'The Long Road', overview: 'The hard part begins.' },
        { season: 1, episode: 6, name: 'The Return', overview: 'Home at last.' },
      ],
    } })
    if (path.startsWith('/meta/series/tt0000201')) return reply(200, { meta: {
      name: 'The Quest', releaseInfo: '2024', genres: ['Animation'], description: 'A quiet journey.',
      videos: [{ season: 1, episode: 5, name: 'The Long Road', overview: 'The hard part begins.' }],
    } })
    if (path.startsWith('/meta/series/tt0000202') || path.startsWith('/meta/series/tt0000203')) return reply(200, { meta: {
      name: 'The Quest', releaseInfo: '2024', genres: ['Animation'], description: 'A quiet journey across the mountains.',
      videos: [
        { season: 1, episode: 3, name: 'The Way In', overview: 'The party sets off.' },
        { season: 1, episode: 4, name: 'The Bridge', overview: 'The bridge is out.' },
        { season: 1, episode: 5, name: 'The Long Road', overview: 'The hard part begins.' },
        { season: 1, episode: 6, name: 'The Return', overview: 'Home at last.' },
      ],
    } })
    if (path.startsWith('/meta/series/tt0000205')) return reply(200, { meta: {
      name: 'Song Test Show', releaseInfo: '2026', genres: ['Animation'], description: 'A show about singing mountains.',
      videos: [
        { season: 1, episode: 5, name: 'The Bridge', overview: 'The bridge sings.' },
        { season: 1, episode: 6, name: 'The Long Road', overview: 'The road sings louder.' },
      ],
    } })
    if (path.startsWith('/meta/series/tt0000204')) return reply(200, { meta: {
      name: 'The Quest', releaseInfo: '2024', genres: ['Animation'], description: 'A quiet journey across the mountains.',
      videos: [
        { season: 1, episode: 3, name: 'The Way In', overview: 'The party sets off.' },
        { season: 1, episode: 4, name: 'The Bridge', overview: 'The bridge is out.' },
        { season: 1, episode: 5, name: 'The Long Road', overview: 'The hard part begins.' },
      ],
    } })
    if (path.startsWith('/meta/series/tt2082624')) return reply(200, { meta: {
      name: 'Dog Days', releaseInfo: '2011', genres: ['Animation', 'Action', 'Adventure'], description: 'Shinku fights alongside a girl named Leonmichele.',
      videos: [{ season: 1, episode: 1, name: 'A Butler and a Swordsman', overview: 'They arrive at the resort.' }],
    } })
    if (path.startsWith('/meta/')) {
      hits.meta++
      return reply(200, { meta: {
        name: 'Some Film', releaseInfo: '2020', genres: ['Drama', 'Mystery'], description: 'Two friends cross the country\n to find a lost map.',
        videos: [{ season: 2, episode: 3, name: 'The Long Road', overview: 'The bridge is out.' }],
      } })
    }
    reply(404, { error: 'not found' })
  })
  origin = await listen(server)
  return { url: origin, hits, close: () => new Promise(done => { server.closeAllConnections(); server.close(done) }) }
}


// AniList, as a stand-in: the two queries the addon sends, answered for one show only. Anything else gets nothing.
// بيانات أنيلست لعمل الأنمي الكامل (لمعرّفات id وidMal) — للكتالوجات (أفكار 24 و25)
export const ANILIST_MEDIA = { id: 16498, idMal: 16498, title: { romaji: 'Shingeki no Kyojin', english: 'Attack on Titan', native: '進撃の巨人' }, description: '<p>Humans fight <b>Titans</b> on the wall.</p>', startDate: { year: 2013 } }

export const startAniList = async () => {
  const hits = []
  const server = createServer(async (req, res) => {
    const body = await readJson(req)
    const reply = data => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data })) }
    if (body.query?.includes('characters')) {
      hits.push('characters')
      if (body.variables?.id !== 962) return reply({ Media: { characters: { edges: [] } } })
      return reply({ Media: { characters: { edges: [
        { node: { id: 1, name: { full: 'Mary', native: 'メアリー' }, gender: 'Male' } },
        { node: { id: 2, name: { full: 'Zoro', native: 'ゾロ' }, gender: 'Male' } },
      ] } } })
    }
    if (/Media\(idMal:/.test(body.query || '')) {
      hits.push('idMal')
      return reply({ Media: Number(body.variables?.id) === 16498 ? ANILIST_MEDIA : null })
    }
    if (/Media\(id:/.test(body.query || '')) {
      hits.push('id')
      return reply({ Media: Number(body.variables?.id) === 16498 ? ANILIST_MEDIA : null })
    }
    if (body.query?.includes('media(search:') || body.query?.includes('Media(search')) {
      hits.push('search')
      if (/dog days/i.test(body.variables?.search || '')) return reply({ Page: { media: [{ id: 10155, title: { romaji: 'Dog Days', english: 'Dog Days', native: 'ドッグデイズ' }, startDate: { year: 2011 } }] } })
      if (!/quest/i.test(body.variables?.search || '')) return reply({ Page: { media: [] } })
      return reply({ Page: { media: [{ id: 962, title: { romaji: 'The Quest', english: 'The Quest', native: '冒険の物語' }, startDate: { year: 2024 } }] } })
    }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{}')
  })
  const url = await listen(server)
  return { url, hits, close: () => new Promise(done => { server.closeAllConnections(); server.close(done) }) }
}

// ── كتالوجات الأنمي + المصادر الإضافية (أفكار 24 و25) ──

export const startKitsu = async () => {
  const hits = []
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    const path = u.pathname
    hits.push(path + (u.search || ''))
    const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/vnd.api+json' }); res.end(JSON.stringify(body)) }
    if (path === '/api/edge/anime/7442') return reply(200, { data: { id: '7442', type: 'anime', attributes: { canonicalTitle: 'Attack on Titan', titles: { en: 'Attack on Titan', en_jp: 'Attack on Titan', ja_jp: '進撃の巨人' }, startDate: '2013-04-07', synopsis: '<p>Humans fight.</p>' } } })
    if (path === '/api/edge/anime/7442/mappings') return reply(200, { data: [
      { attributes: { externalSite: 'anilist/anime', externalId: '16498' } },
      { attributes: { externalSite: 'myanimelist/anime', externalId: '16498' } },
      { attributes: { externalSite: 'thetvdb', externalId: '267440' } },
    ] })
    if (path === '/api/edge/episodes') {
      if (u.searchParams.get('filter[mediaId]') === '7442' && u.searchParams.get('filter[number]') === '1') {
        return reply(200, { data: [{ attributes: { titles: { en_us: 'To You, in 2000 Years', ja_jp: '2000年後の君へ' }, canonicalTitle: 'To You, in 2000 Years' } }] })
      }
      return reply(200, { data: [] })
    }
    return reply(404, { errors: [{ title: 'not found' }] })
  })
  const url = await listen(server)
  return { url, hits, close: () => new Promise(done => { server.closeAllConnections(); server.close(done) }) }
}

export const startSubdl = async () => {
  const { zipSync, strToU8 } = await import('fflate')
  const hits = []
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    hits.push(`${req.method} ${u.pathname}${u.search}`)
    if (u.pathname === '/api/v1/subtitles') {
      if (u.searchParams.get('api_key') !== 'sd-key') { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"status":401}') }
      if (u.searchParams.get('imdb_id') === 'tt2082624') { return res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify({ status: 200, subtitles: [] })) }
      if (/dog\s*days/i.test(u.searchParams.get('film_name') || '')) { return res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify({ status: 200, subtitles: [ { url: '/subtitle/201.zip', lang: 'EN', release_name: 'Dog.Days.S01E01.1080p.TVRip', file: 'dd.en.srt' } ] })) }
      return res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify({
        status: 200,
        subtitles: [
          { url: '/subtitle/101.zip', lang: 'EN', release_name: 'Attack.On.Titan.S01E01.1080p.WEB-DL', file: 'aot.en.srt' },
          { url: '/subtitle/102.zip', lang: 'FR', release_name: 'LAttaqueDesTitans.S01E01.FRENCH', file: 'aot.fr.srt' },
        ],
      }))
    }
    if (u.pathname === '/subtitle/201.zip') {
      if (u.searchParams.get('api_key') !== 'sd-key') { res.writeHead(401); return res.end() }
      const zip = zipSync({ 'dd.en.srt': strToU8(sampleSrt(3)) })
      res.writeHead(200, { 'content-type': 'application/zip' }); return res.end(Buffer.from(zip))
    }
    if (u.pathname === '/subtitle/101.zip') {
      if (u.searchParams.get('api_key') !== 'sd-key') { res.writeHead(401); return res.end() }
      const zip = zipSync({ 'aot.en.srt': strToU8(sampleSrt(3)) })
      res.writeHead(200, { 'content-type': 'application/zip' }); return res.end(Buffer.from(zip))
    }
    res.writeHead(404); res.end()
  })
  const url = await listen(server)
  return { url, hits, close: () => new Promise(done => { server.closeAllConnections(); server.close(done) }) }
}

const JIMAKU_ASS = '[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,Are you the one\nDialogue: 0,0:00:04.00,0:00:06.00,Default,,0,0,0,,who fears the Titans\n'

export const startJimaku = async () => {
  const hits = []
  let lastFileAuth = ''
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x')
    hits.push(`${u.pathname}${u.search || ''}`)
    const reply = (status, body, type = 'application/json') => { res.writeHead(status, { 'content-type': type }); res.end(typeof body === 'string' ? body : JSON.stringify(body)) }
    if (req.headers.authorization !== 'jm-key') return reply(401, { error: 'unauthorized' })
    if (u.pathname === '/api/entries/search') {
      if (u.searchParams.get('anime') === 'true' && u.searchParams.get('anilist_id') === '16498') return reply(200, [{ id: 77, anilist_id: 16498, name: 'Shingeki no Kyojin' }])
      if (u.searchParams.get('anime') === 'true' && u.searchParams.get('anilist_id') === '10155') return reply(200, [{ id: 88, anilist_id: 10155, name: 'Dog Days' }])
      return reply(200, [])
    }
    if (u.pathname === '/api/entries/77/files') {
      if (u.searchParams.get('episode') === '1') return reply(200, [{ name: '[SubsPlease] AoT - 01 (1080p).ass', size: 4321, url: '/file/77-1.ass' }])
      return reply(200, [])
    }
    if (u.pathname === '/api/entries/88/files') {
      if (u.searchParams.get('episode') === '1') return reply(200, [{ name: '[HorribleSubs] Dog Days - 01 [720p].ass', size: 3100, url: '/file/88-1.ass' }])
      return reply(200, [])
    }
    if (u.pathname === '/file/77-1.ass') {
      lastFileAuth = req.headers.authorization
      return reply(200, JIMAKU_ASS, 'text/plain; charset=utf-8')
    }
    if (u.pathname === '/file/88-1.ass') {
      lastFileAuth = req.headers.authorization
      return reply(200, JIMAKU_ASS, 'text/plain; charset=utf-8')
    }
    return reply(404, { error: 'not found' })
  })
  const url = await listen(server)
  return { url, hits, get lastFileAuth() { return lastFileAuth }, close: () => new Promise(done => { server.closeAllConnections(); server.close(done) }) }
}
