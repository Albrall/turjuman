// فكرة 38: تقرير الشهر — كم حلقة تترجمت، كم توكن انصرف، وكم وفّرت الذاكرة (أي كم مرة خُدمت ترجمة محفوظة بدل إعادة دفع).
// Pure functions so the rules of the ledger and the shape of the page can be tested without any server.

export const monthKey = (now = new Date()) => now.toISOString().slice(0, 7)   // the store names it (KV: r:<key> · disk: report-<key>.json)

const number = value => Number(value) || 0

// Add a delta (a finished translation, or a translation served from the store) onto what was kept.
// Every field is additive with itself; missing values are zeros.
export const mergeReport = (prev, delta = {}) => ({
  episodes: number(prev?.episodes) + number(delta.episodes),
  tv: number(prev?.tv) + number(delta.tv),
  film: number(prev?.film) + number(delta.film),
  lines: number(prev?.lines) + number(delta.lines),
  requests: number(prev?.requests) + number(delta.requests),
  tokensP: number(prev?.tokensP) + number(delta.tokensP),
  tokensC: number(prev?.tokensC) + number(delta.tokensC),
  withUsage: number(prev?.withUsage) + number(delta.withUsage),
  hits: number(prev?.hits) + number(delta.hits),
})

const esc = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const grouped = n => Number(n).toLocaleString('ar-u-nu-arab')

// The report as a standalone Arabic page, inline CSS only. `data` is one month of the ledger (or nothing).
export const reportHtml = (data, monthLabel) => {
  const empty = !data || (number(data.episodes) + number(data.hits) === 0 && number(data.requests) === 0)
  const usage = number(data?.withUsage) > 0
  const rows = empty ? `<p class="none">ما في شي لهذا الشهر بعد — أول ترجمة تكتمل أو ترجمة تُخدَم من الحفظ تُحسب هنا.</p>` : `
  <div class="kpis">
    <div><b>${grouped(data.episodes)}</b><span>ترجمة مكتملة</span></div>
    <div><b>${grouped(data.tv)}</b><span>حلقات مسلسلات</span></div>
    <div><b>${grouped(data.film)}</b><span>أفلام</span></div>
    <div><b>${grouped(data.lines)}</b><span>سطرًا مترجمًا</span></div>
    <div><b>${grouped(data.requests)}</b><span>طلبًا للمزوّد</span></div>
    <div><b>${grouped(data.hits)}</b><span>مرة خُدمت ترجمة من الحفظ</span></div>
  </div>
  <h2>التوكنز</h2>
  ${usage
    ? `<div class="kpis"><div><b>${grouped(data.tokensP)}</b><span>توكن دُخل (input)</span></div><div><b>${grouped(data.tokensC)}</b><span>توكن خُرج (output)</span></div><div><b>${grouped(number(data.tokensP) + number(data.tokensC))}</b><span>المجموع</span></div></div>
       <p class="note">العدد من مزوّدك كما أعلنه بعد كل طلب — ما فيه تقريب وما فيه سعر؛ السعر تحدّده خطتك.</p>`
    : `<p class="note">مزوّدك الحالي ما يرسل إحصاءات التوكنز (بعض المزوّدين مثل Ollama أو عبر وكيل لا يرسلها) — تُعرض «الطلبات» و«السطور» بدلًا منها.</p>`}`
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>تقرير ترجمان — ${esc(monthLabel)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1"><style>
:root { color-scheme: dark }
body { font-family: system-ui, 'Segoe UI', Tahoma, sans-serif; background:#101418; color:#e8eaed; margin:0; padding:24px; line-height:1.7 }
main { max-width: 860px; margin: auto }
h1, h2 { color:#ffd56a }
a { color:#7fc4ff }
p, li { font-size: 15px }
.kpis { display:grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap:12px; margin:14px 0 }
.kpis div { background:#1b2229; border:1px solid #2a3138; border-radius:12px; padding:14px 10px; text-align:center }
.kpis b { display:block; font-size:26px; color:#ffd56a }
.kpis span { font-size:12.5px; color:#9aa5ad }
.note { border-inline-start:3px solid #ffd56a; background:#171d23; padding:8px 14px; border-radius:8px }
.none { color:#9aa5ad; margin-top:20px }
footer { border-top:1px solid #2a3138; margin-top:28px; padding-top:12px; color:#7b868e; font-size:12.5px }
</style></head><body><main>
<h1>تقرير ترجمان — ${esc(monthLabel)}</h1>
<p>هذا ما يحسبه ترجمان محليًا بحق هذا النشر: كل ترجمة تكتمل تُحسب مرة واحدة، وكل مرة تُخدَم فيها ترجمة محفوظة على المشغّل بدل إعادة الترجمة تُحسب توفيرًا.</p>
${rows}
<footer>التقرير بشهر الميلادي الحالي. لا يُرسل أي شيء لأي طرف — يُحسب في خادم ترجمان من الطلبات المحلية للحلقة، ويُحفظ حيث تُحفظ الترجمات.</footer>
</main></body></html>`
}
