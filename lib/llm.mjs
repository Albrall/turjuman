// One client for every provider that speaks the OpenAI chat-completions format
// (Gemini, OpenRouter, OpenAI, DeepSeek, Groq, Ollama, …).

// kind: 'fatal' = stop, trying again won't help · 'shape' = the provider rejects a field of the request
//       'content' = the provider will not take what the request says: a moderation or usage-policy filter turned it down
//       'retry' = try again later
export class LlmError extends Error {
  constructor(message, { status = 0, kind = 'retry', retryAfter = 0 } = {}) {
    super(message)
    this.status = status
    this.kind = kind
    this.retryAfter = retryAfter
  }
}

export const sleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve()
  const timer = setTimeout(resolve, ms)
  signal?.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true })
})

// What the provider's error says, whatever shape it comes in: { error: { message, code, … } }, { error: "…" },
// { message: "…" }, or the same inside a list (Gemini)
const errorOf = raw => {
  try {
    let body = JSON.parse(raw)
    if (Array.isArray(body)) body = body[0]
    const error = body?.error
    if (error && typeof error === 'object') return error
    if (typeof error === 'string') return { message: error }
    if (typeof body?.message === 'string') return { message: body.message }
  } catch {}
  return {}
}

// The account has nothing left to spend, or has reached a limit set on it: waiting does not bring it back.
// OpenAI answers this with 429, the status of "slow down".
const SPENT = /^(insufficient_quota|credit_balance_exhausted|billing_hard_limit_reached|billing_not_active|(organization|project)_(usage|spend)_limit_exceeded)$/

// A filter that turned the request down for what it says. Providers tell it in different ways:
//  - OpenAI: 400 with the code invalid_prompt ("your prompt was flagged as potentially violating our usage policy")
//  - OpenRouter: 403 with metadata that names the reasons and the flagged text, or the patterns a guardrail found
//  - Azure and others: the codes content_filter / content_policy_violation, or words to that effect
// The words are only believed on the statuses a provider uses to refuse a request, so that an account that was
// closed, or a key that was refused, is never read as a line that was turned down.
const CONTENT_CODES = /^(invalid_prompt|content_filter|content_policy_violation|moderation_blocked|prohibited_content)$/i
const CONTENT_WORDS = /flagged as potentially violating|\b(prompt|input|request|content|message)s? (was|were|is|has been) (flagged|blocked|filtered)|requires moderation|content (management |filtering )?polic|content[_ ]filter|safety system|prohibited[_ ]content/i
const turnedDown = (status, error) => {
  if (CONTENT_CODES.test(String(error.code ?? ''))) return true
  if (status !== 400 && status !== 403 && status !== 422) return false
  const meta = error.metadata
  if (meta && typeof meta === 'object' && (Array.isArray(meta.reasons) || typeof meta.flagged_input === 'string' || Array.isArray(meta.patterns))) return true
  return CONTENT_WORDS.test(String(error.message ?? ''))
}

export const failure = (status, raw, retryAfter = 0) => {
  const error = errorOf(raw)
  const said = String(error.message || raw).replace(/\s+/g, ' ').trim().slice(0, 200)
  if (SPENT.test(String(error.code ?? '')) || SPENT.test(String(error.type ?? ''))) return new LlmError(`رصيد حساب الـAI انتهى أو بلغ حد الصرف (${status}): ${said}`, { status, kind: 'fatal' })
  if (turnedDown(status, error)) return new LlmError(`المزود رفض محتوى الطلب (${status}): ${said}`, { status, kind: 'content' })
  if (status === 401 || status === 403) return new LlmError(`مفتاح الـAI مرفوض (${status}): ${said}`, { status, kind: 'fatal' })
  if (status === 404) return new LlmError(`النموذج أو رابط المزود غير موجود (404): ${said}`, { status, kind: 'fatal' })
  // 402 is "out of credit", except where the provider uses it as a rate limit and says when to come back
  if (status === 402 && !retryAfter) return new LlmError(`رصيد حساب الـAI غير كافٍ (402): ${said}`, { status, kind: 'fatal' })
  if (status === 400 || status === 422) return new LlmError(`المزود رفض الطلب (${status}): ${said}`, { status, kind: 'shape' })
  if (status === 429 || status === 402) return new LlmError(`المزود يطلب التمهّل (${status})`, { status, retryAfter })
  return new LlmError(`خطأ من مزود الـAI (${status}): ${said}`, { status, retryAfter })
}

// The optional fields of a request. Providers differ in what they accept, so each starts on and is dropped when it is refused.
export const freshCaps = effort => ({ effort: Boolean(effort), temperature: true, json: true })

// After a 'shape' error: drop the field the error names, or else the next one in line. False when there is nothing left to drop.
export const loosen = (caps, message = '') => {
  const named = [['effort', /reasoning/i], ['temperature', /temperature/i], ['json', /response_format|json/i]]
    .find(([field, pattern]) => caps[field] && pattern.test(message))
  const field = named?.[0] ?? ['effort', 'temperature', 'json'].find(name => caps[name])
  if (!field) return false
  caps[field] = false
  return true
}

export const chat = async ({ baseUrl, apiKey, model, messages, effort, caps, signal, timeoutMs = 120_000 }) => {
  const body = { model, messages }
  if (caps.temperature) body.temperature = 0.2
  if (caps.json) body.response_format = { type: 'json_object' }
  if (caps.effort && effort) body.reasoning_effort = effort

  const timeout = AbortSignal.timeout(timeoutMs)
  let response, raw
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    })
    raw = await response.text()
  } catch (error) {
    if (signal?.aborted) throw new LlmError('أُلغيت الترجمة', { kind: 'fatal' })
    throw new LlmError(timeout.aborted ? 'مزود الـAI لم يرد في الوقت المحدد' : `تعذّر الاتصال بمزود الـAI (${error.cause?.code || error.message})`)
  }
  if (!response.ok) throw failure(response.status, raw, Number(response.headers.get('retry-after')) || 0)

  let answer
  try {
    answer = JSON.parse(raw)
  } catch {
    throw new LlmError('رد مزود الـAI ليس بالصيغة المتوقعة')
  }
  const choice = answer?.choices?.[0]
  const usage = answer?.usage ? { p: Number(answer.usage.prompt_tokens) || 0, c: Number(answer.usage.completion_tokens) || 0 } : null
  let content = choice?.message?.content
  if (Array.isArray(content)) content = content.map(part => part?.text ?? '').join('')
  if (typeof content === 'string' && content.trim()) return { text: content, usage }
  // Nothing to read. Some providers answer 200 and say inside what went wrong: a filter that withheld the answer,
  // a model that declined, or an error from further up the line.
  const declined = typeof choice?.message?.refusal === 'string' ? choice.message.refusal.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
  if (choice?.finish_reason === 'content_filter' || declined) throw new LlmError(`المزود رفض محتوى الطلب: ${declined || 'content_filter'}`, { status: 200, kind: 'content' })
  const inner = answer?.error ?? choice?.error
  if (inner) throw failure(Number.isInteger(inner.code) && inner.code >= 400 ? inner.code : 502, JSON.stringify({ error: inner }))
  throw new LlmError('مزود الـAI أعاد ردًّا فارغًا')
}

// The model is asked for {"12": "…", "13": "…"}. Some wrap it in prose or code fences, nest it one level down, or get cut off
// mid-way: whatever complete pairs are there are kept, and the caller asks again for the rest.
export const readMap = text => {
  const first = text.indexOf('{'), last = text.lastIndexOf('}')
  if (first >= 0 && last > first) {
    try {
      let parsed = JSON.parse(text.slice(first, last + 1))
      const nested = Object.values(parsed)
      if (nested.length === 1 && nested[0] && typeof nested[0] === 'object' && !Array.isArray(nested[0])) parsed = nested[0]
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
    } catch {}
  }
  const pairs = {}
  for (const [, id, value] of text.matchAll(/"(\d+)"\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
    try { pairs[id] = JSON.parse(value) } catch {}
  }
  return pairs
}
