> **تقرير تاريخي عن النسخة 0.9.6** — معظم بنوده عولجت في 0.9.8 و0.9.8.1. راجع `CHANGELOG.md` و`docs/INCIDENT-0.9.8-ar.md`.

# مراجعة كود `tarjuman-addon-0.9.6.zip`

**تاريخ المراجعة:** 2026-11-24  
**الملف:** `google_drive/tarjuman-addon-0.9.6.zip` (244,551 بايت · MD5 `c4460339a63a31e7c4efd64ba2029f7d`)  
**فُكّ في:** `review/tarjuman/` — 30 ملفاً، ~12,200 سطر (منها 3,480 سطراً هي الحزمة المبنية `cloudflare/_worker.js`)  
**اللغة:** JavaScript (ESM) · Node 20.15+ / Cloudflare Workers · بلا إطار عمل

---

## الخلاصة التنفيذية

المشروع مكتوب بعناية معمارية واضحة (فصل `lib/app.mjs` عن منصتي Node و Cloudflare، ونموذج «اللوحة + المساعدين» في `board.mjs`)، لكن **الإصدار 0.9.6 لا يصلح للنشر كما هو**:

- **10 أخطاء حرجة**، منها 3 ثغرات أمنية قابلة للاستغلال (تسرّب مفتاح، SSRF، تسميم روابط).
- **ميزتان أساسيتان معطّلتان تماماً**: «الترجمة العربية الجاهزة» و«قاموس أسماء المسلسل للأنمي».
- **7 اختبارات كانت فاشلة في الحزمة الأصلية** (251 اختباراً فقط لا 256 كما في README)، و6 منها ما زالت فاشلة بعد أن ولّدتُ الملف الناقص.
- **ملف النشر على Cloudflare Pages ناقص من الأرشيف**، و**بناء Dockerfile يفشل حتماً**.
- لم أجد أي مفتاح أو سرّ مكتوب داخل الكود، والنسخة المبنية `_worker.js` مطابقة byte-for-byte للمصادر.

> ملاحظة: أثناء المراجعة شغّلتُ `npm run build`، فأنشأ `cloudflare/tarjuman-cloudflare.zip` (كان مفقوداً). بهذا انخفض عدد الاختبارات الفاشلة من 7 إلى 6؛ **الأرقام الأصلية للحزمة كما رُفعت هي 7**.

---

## كيف تحقّقتُ

```bash
node --check <كل ملف>                      # كلها سليمة نحوياً
npm install && npm test                     # 251 اختباراً، 244 ناجح، 7 فاشل (الأصل)
npm run build && cmp cloudflare/_worker.js  # الحزمة مطابقة للمصادر تماماً
python3 -c "zipfile.ZipFile(...).testzip()" # الـ zip المولّد صالح
# + 4 سكربتات تحقق مباشرة (probes) مع fetch وهمي للأخطاء المنطقية
```

---

# أولاً: أخطاء حرجة (تمنع النشر)

## 1. مسار `/r/` محجوب بـ 404 ← كل «العربي الجاهز» معطّل
**`lib/app.mjs:729`**
```js
if (!isManifest && !isList && !isTrack && !isReport) return text(404, 'not found')
```
`isReady` مُعرّفة في السطر السابق لكنها **غير مضافة** للشرط، مع أن `if (isReady) return handleReady(...)` موجود بعده. أي طلب `/<settings>/r/<link>.vtt` يُقابل بـ 404 قبل الوصول إلى المعالج.

**الدليل:** `probe3` → `{ status: 404, body: 'not found' }`؛ والاختبار `«الترجمة العربية الجاهزة تُجلب عبر /r/ من غير ترجمة»` فاشل.  
**الإصلاح:** `if (!isManifest && !isList && !isTrack && !isReady && !isReport) ...`

## 2. `sub.u` بدل `sub.url` ← التحقق من العربية والمقارنة بالذكاء معطّلان
**`lib/app.mjs:452` و `lib/app.mjs:589`**
```js
const text = await fetchExtraSubtitle(sub.u, cfg, sources, {...})
```
كائنات الترجمة القادمة من `listSubtitles` / `extraSubtitles` تحمل الحقل **`url`** (كما يستعمله الكود نفسه في الأسطر 337 و353 و507). تمرير `undefined` يجعل `settings.allow.test(undefined)` تفشل، فيُرمى الاستثناء ويُلتقط بـ `catch` الذي يضع الملف في `arabicFallback`.

**الأثر:** كل ترجمة عربية تُعرض كأنها «غير متحقق منها»، فتظهر ترجمات إنجليزية المحتوى وملفات متعددة الحلقات تحت اسم «عربي جاهز ✓»؛ وخيار `na` («لا تترجم إن وُجد عربي») يتصرف خطأ؛ و`pickBestArabic` يقرأ `(لا يمكن قراءتها)` لكل ملف فلا يقارن شيئاً.  
**الدليل:** 4 اختبارات فاشلة (`مزيفة`, `متعددة الحلقات`, `na: 1`, `/r/`).  
**الإصلاح:** `sub.url` في الموضعين.

## 3. وحدات توقيت خاطئة ← حارس «الملف متعدد الحلقات» لا يعمل أبداً
**`lib/app.mjs:44`**
```js
const spanMinutes = (last.end - cues[0].start) / 60_000
```
`start` / `end` من `parseSubtitle` **بالثواني** (`subs.mjs::seconds`، و`stamp` يضرب في 1000). القسمة على 60,000 خاطئة؛ الصحيحة `/ 60`. فيلم ساعتان يُحسب 0.12 «دقيقة»، فالشرط `> 50` لا يتحقق أبداً. ويُستدعى في 3 مواضع: `open`، `handleList`، `handleReady`.

**الدليل:** `probe1` → 200 سطراً على 66.7 دقيقة: بالقسمة الحالية `0.067 → false`، بالصحيحة `66.7 → true`. والاختبار `«ترجمة عربية متعددة الحلقات تُستبعد»` فاشل.  
**الإصلاح:** `/ 60`.

## 4. تسرّب مفتاح SubDL بين مستخدمي الخادم نفسه 🔒
**`lib/extraSources.mjs:84`** — مفتاح الكاش لا يحتوي `apiKey`:
```js
cached(`subdl:${id}:${type}:${episode}:${...}`, ...)
```
داخل الدالة يُبنى رابط التنزيل بـ `dl.searchParams.set('api_key', apiKey)` **ثم يُخزّن في الكاش ويُعاد كما هو** للمستخدم التالي.

**الدليل (probe2):** المستخدم A بمفتاح `KEY-OF-USER-A` → الرابط `...?api_key=KEY-OF-USER-A`. المستخدم B بمفتاح مختلف → **صفر طلبات جديدة للـ API** ويستلم **نفس الرابط بمفتاح A**. الرابط يصل إلى قائمة الترجمات في المتصفح/المشغّل.  
**الإصلاح:** إدخال بصمة المفتاح في مفتاح الكاش (`hash(apiKey)`)، أو عدم تخزين الروابط بل إعادة توقيعها عند كل استخدام، أو جعل الكاش لكل مستخدم. نفس الملاحظة على `jimakuSearch` وإن كان ضررها أقل.

## 5. SSRF عبر إعداد `ex` (رابط المصدر الإضافي) 🔒
**`lib/config.mjs:69`** يأخذ `ex` كنص بلا أي تحقق، و**`lib/extraSources.mjs:151,158`** يبني منه الطلب مباشرة:
```js
const apiBase = (baseUrl || urls.popcorn || 'https://popcorn-notes...').replace(/\/+$/, '')
const body = await getJson(`${apiBase}/subtitles/${type}/${plainImdb}.json?${params}`, {})
```
لا `settings.allow` ولا `assertProviderAllowed` هنا (الـ allow-list تُطبّق فقط على **روابط الترجمات الناتجة**، لا على عنوان الـ API نفسه).

**الدليل (probe4):** `ex = 'http://169.254.169.254/latest/meta-data/'` → نُفّذ `GET http://169.254.169.254/latest/meta-data/subtitles/movie/tt1234567.json?...`. على خادم عام يكفي وضع `ex` داخل رابط الإضافة لجعل الخادم يطلب أي عنوان داخلي.  
**الإصلاح:** التحقق من `ex` بـ `assertProviderAllowed` + allow-list صريحة (`https` فقط، نطاقات معلومة)، ولا تسمح بأي IP خاص.

## 6. `pickBestArabic` يتجاوز كل حماية المزوّد 🔒
**`lib/app.mjs:585–614`** — `handleList` **لا يستدعي `assertProviderAllowed` إطلاقاً** (مواقع الاستدعاء الوحيدة: `open:231` و `handleTest:676`). هذا المعالج يُجري `fetch(\`${cfg.b}/chat/completions\`)` مباشرة:
- بلا فحص SSRF،
- بلا `AbortSignal.timeout` (قد يُعلّق طلب القائمة إلى الأبد)،
- بلا فحص `response.ok`،
- بلا عميل `chat()` / `loosen()`، فيُرسل `max_tokens` و `temperature` اللذين قد يرفضهما المزوّد — خلافاً لِما يعد به README («تحذف الحقل المرفوض وتعيد المحاولة تلقائياً»).

**الإصلاح:** استدعاء `assertProviderAllowed(cfg.b, ...)` في بداية `handleList` عند `cfg.ca`، واستبدال الجسم بـ `chat()` من `llm.mjs` مع مهلة.

## 7. تسميم `X-Forwarded-Host` ← تسريب مفتاح المستخدم 🔒
**`lib/app.mjs:64`**
```js
const named = first(request.headers.get('x-forwarded-host')) || url.host
const host = /^[\w.:[\]-]+$/.test(named) ? named : '127.0.0.1'
```
الترويسة مقبولة من **أي عميل** بلا تحقق من كونها صادرة عن بروكسي موثوق، وتُستخدم لبناء كل الروابط المُعادة للمشغّل — والرابط يحتوي إعدادات المستخدم ومنها مفتاح الـ AI.

**الدليل (probe3):** طلب بـ `X-Forwarded-Host: attacker.example` أعاد روابط `https://attacker.example/<settings>/...`.  
**الإصلاح:** الاعتماد على `PUBLIC_URL` إن وُجد، أو `request.url`، أو ترويسات البروكسي فقط حين يُضبط الخادم صراحةً على الثقة بها. (الاختبار `«links point at the address the viewer came through»` يطلب هذا السلوك، فيجب تعديله مع الإصلاح.)

## 8. `cloudflare/tarjuman-cloudflare.zip` غير موجود في الأرشيف
README خطوة 2 تقول «الملف المطلوب: `cloudflare/tarjuman-cloudflare.zip`»، لكن قائمة الأرشيف تحتوي `_worker.js` فقط. اختبار `worker.test.mjs:97` يفشل بـ `ENOENT`. **لا يمكن اتباع تعليمات النشر على Pages بالحزمة كما رُفعت.**  
**تم:** ولّدتُ الملف عبر `npm run build` داخل مساحة العمل (صالح، 193,116 بايت لـ `_worker.js`)؛ يجب إضافته للأرشيف قبل التوزيع.

## 9. استعلام AniList GraphQL غير صالح ← قاموس الأسماء لا يُبنى أبداً
**`lib/anilist.mjs:27`**
```graphql
query ($search: String!) { Media(search: $search, type: ANIME) { ... } }
```
الحقل `Query.Media` **لا يقبل وسيط `search`**؛ البحث يكون عبر `Page { media(search: ..., type: ANIME) }` [1](https://docs.anilist.co/guide/graphql/queries/media). مع AniList الحقيقي يعود خطأ GraphQL، يلتقطه `searchAnime` بصمت، فيبقى `seriesNames` بلا قائمة:
- ميزة «قاموس أسماء المسلسل» (التي يفرد لها README قسماً كاملاً) معطّلة،
- مسار Jimaku لأعمال IMDb المصنّفة Animation معطّل،
- ومع ذلك `test/mocks.mjs:332` **يصادق على الاستعلام الخاطئ** (`body.query?.includes('Media(search')` ويعيد `{ Media: ... }`)، فالاختبارات تعطي ثقة زائفة.

**الإصلاح:** `Page(page:1, perPage:5) { media(search:$search, type:ANIME, sort:SEARCH_MATCH) {...} }` مع قراءة `data.Page.media[0]`، وتحديث الـ mock لرفض أي استعلام لا يطابق الـ schema.

## 10. Dockerfile لا يمكن بناؤه إطلاقاً
**`.dockerignore:10`** يستبعد `package-lock.json`، بينما **`Dockerfile:3`** ينفّذ `COPY package.json package-lock.json ./` ثم `npm ci` (الذي يفشل بلا lock). README يكتفي بقول «لم يُبنَ في بيئة التطوير»، لكنه في الحقيقة **مضمون الفشل**.  
**الإصلاح:** حذف `package-lock.json` من `.dockerignore`. (لم أستطع تشغيل `docker build` لعدم توفر docker في البيئة، لكن التعارض قطعي من الملفين.)

---

# ثانياً: أخطاء عالية الأثر الوظيفي

| # | الموضع | الخطأ | الدليل / الأثر |
|---|---|---|---|
| 11 | `lib/episode.mjs:66` | `new RegExp(\`-e0*${expected.episode}...\`)` يقبل أي مدى `-eNN` **بلا فحص الموسم** | `probe1`: `Show.S05E10-E12` يُحكم `same` للحلقة المطلوبة `S03E12` ← الحارس يترجم حلقة غلط. الاختبار يغطي `S03E10-E12` فقط فيفلت. أضف شرط `season === expected.season` قبل الحكم. |
| 12 | `lib/extraSources.mjs:195` | `if (first.length \|\| anime) return first` — التعليق بعده يقول «SubDL ما يعرف imdb لكل أنمي — جرّب بالاسم والسنة»، لكن `\|\| anime` يمنع المحاولة **تحديداً للأنمي** | `probe2`: مع `kitsu:7442:1` ومفتاح SubDL → صفر طلبات SubDL، صفر نتائج. المنطق معكوس. |
| 13 | `lib/series.mjs:31` + `lib/app.mjs:242` | `seriesNames` يبدأ بـ `parseVideoId(ref.i)` الذي يُعيد `null` لكل `kitsu:/mal:/anilist:` | `probe2`: `seriesNames({t:'series',i:'kitsu:7442:1'}) === null`. القاموس يعمل فقط مع `tt…` من Cinemeta، بينما README يقدّمه كميزة للأنمي. |
| 14 | `lib/app.mjs:422` | `if (!base && !isAnimeId(id) && !merged.length) return nothing()` يُعيد `[]` قبل الوصول إلى `noticeList(...,'no-arabic')` | عند **سقوط** مصدر الترجمات لا تظهر أي رسالة؛ الاختبار `nothing to offer` فاشل (`0 !== 1`). الرسالة تظهر فقط حين يردّ المصدر بقائمة فارغة. |
| 15 | `lib/config.mjs:91–117` | حماية SSRF جزئية | `probe1`: `0:0:0:0:0:0:0:1`, `127.1`, `2130706433`, `192.0.0.1`, `198.18.0.1` كلها تُعد «عامة». وعلى Cloudflare لا يوجد `platform.lookup`، فلا يُفحص أي اسم نطاق يحلّ إلى IP داخلي. ثم **TOCTOU**: `lookup` يحلّ الاسم قبل `fetch` الذي يحلّه مجدداً (DNS rebinding). |
| 16 | `lib/extraSources.mjs:232` | `unzipSync(buffer)` بلا حد لحجم الناتج (zip bomb، الحدّ 10MB على المضغوط فقط) + `TextDecoder('utf-8')` دائماً + لا fallback إن كان الملف `.srt` غير مضغوط | ترجمات cp1252 / windows-1256 تُقرأ مكسورة؛ أي رد غير zip يُسقط الملف صامتاً. أضف حدّاً للمفكوك وكشف ترميز و `@Zip` fallback. |
| 17 | `lib/app.mjs:621` | `handleReady` بلا `try/catch` حول `fetchExtraSubtitle` | أي 404/مهلة/zip تالف → استثناء غير معالج → 500 بصفحة خطأ إنجليزية بدل رسالة عربية (على Cloudflare لا يوجد catch حول `handle()` أصلاً). |
| 18 | `worker.mjs:81` | `handle ??= createApp(platformFor(env))` يُبنى مرة واحدة لكل isolate | تغيير `HELPER_BUDGET` أو ربط `CACHE` أو `NOTICE` لا يُرى إلا في isolate جديد؛ ولا يوجد `platform.log` على Cloudflare فكل `platform.log?.()` صامت (لا سجلات تشخيص). |

---

# ثالثاً: ملاحظات متوسطة

| # | الموضع | الملاحظة |
|---|---|---|
| 19 | `lib/app.mjs:101` | نص يظهر للمستخدم: `«⚠️ traducttuman ما لقي ترجمة عربية...»` — كلمة دخيلة بدل «ترجمان». |
| 20 | `lib/app.mjs:37,40` | تعليقات بلغة دخيلة: `//inya harf arabi — kadiru min 600 ila 6FF` و `//inya file multidrama…`؛ علامة على كود مولّد/غير مراجع بشرياً. |
| 21 | `public/configure.html:255` | `$('ex').value…replace(/\\/+$/, '')` يزيل **backslashes** لا الشرطة المائلة (المقارنة بالسطر 250 الصحيح `replace(/\/+$/, '')`). |
| 22 | `configure.html` + README | `warm` مفعّل افتراضياً («ابدأ الترجمة فور جلب القائمة») و`cf` مفعّل افتراضياً («لا تبدأ إلا بعد اختيارها مرتين») — الأول يجعل الثاني بلا أثر: `begun(key)` يصبح `true` قبل أي اختيار، وتُصرف توكنز عند مجرد فتح القائمة. تناقض صريح في نفس الصفحة. |
| 23 | `configure.html:280` + README «الخصوصية» | المفتاح يُحفظ **أيضاً** في `localStorage` بصيغة plaintext (`KEPT='tarjuman-settings'`)، بينما README يقول «مفتاحك موجود داخل رابط الإضافة فقط». صحيح أن الخادم لا يراه، لكن العبارة مضللة. |
| 24 | `lib/sources.mjs:159` | `${meta.name}` بلا تحقق ← عند نقص/فشل صفحة Cinemeta يصل للنموذج `"undefined (2010), a film"`. كما أن `titles` و `metas` يُخزّنان **نتيجة الفشل** (`''` / `{}`) مدى الحياة، فلا تُعاد المحاولة بعد عطل عابر. |
| 25 | `lib/subs.mjs:30` | ASS بلا سطر `Format:` → `format=[]` → `get('start')` يُعيد `''` → **صفر أسطر** بلا تنبيه. |
| 26 | `lib/series.mjs:58` | `learnSeriesNames` يحفظ فقط حين `learned > 0`؛ تحديث `kind` من `other` إلى `man/woman` وحده لا يُحفظ. |
| 27 | `lib/board.mjs:537` | `useBackup` لا يُصفّر في `resumeBoard` → بعد استعمال المزوّد الاحتياطي مرة، يبقى مستخدماً لكل ما بعدها، خلافاً للتعليق «يُستخدم مرة واحدة في الحلقة». |
| 28 | `server.mjs:69–78` | `readBody` يرفض بعد 16KB لكنه **لا يزيل الـ `data` listener ولا يدمر الطلب** → يستمر تجميع الجسم في الذاكرة (حجم غير محدود فعلياً). |
| 29 | `server.mjs:118–125` | `console.error(error.stack)` قد يطبع URL الطلب كاملاً (وفيه المفتاح) رغم وجود `masked()` لسطر الوصول فقط. |
| 30 | `lib/report.mjs:4` | `monthKey` بـ `toISOString()` = UTC؛ المستخدم في جدة (+3) يبدأ شهره قبل 3 ساعات → عدّادات الشهر تُنسب خطأً. |
| 31 | `deploy.mjs:47` | يتوقع `existing.tags` من `GET /workers/scripts`. إن لم يُعِد الـ endpoint هذا الحقل، التشغيل الثاني يرفض تحديث worker **الذي أنشأه هو** بحجة أنه لشخص آخر. يستحق تحققاً مقابل استجابة API حقيقية. |
| 32 | `build.mjs:28` | `legalComments: 'none'` يحذف إشعارات ترخيص `fflate` (MIT) من الملف الوحيد الذي يُوزَّع على Cloudflare. |
| 33 | `README.md` | أرقام/ادعاءات غير مطابقة: «256 اختباراً» (الفعلي 251، و7 فاشلة)؛ «SubSource ما زال مؤجلاً» بينما **Popcorn Notes** مصدر ثالث فعّال في الكود والواجهة؛ «الملف المطلوب `tarjuman-cloudflare.zip`» غير مرفق؛ «تحذف الحقل المرفوض وتعيد المحاولة» لا ينطبق على `pickBestArabic`. |
| 34 | `test/mocks.mjs:332`, `test/unit.test.mjs:1080` | الـ mock يصادق على استعلام AniList الخاطئ؛ واختبار الحارس لا يغطي مدىً بموسم مختلف → الخطآن 9 و11 يفلتان من 251 اختباراً. |

---

# رابعاً: ملاحظات منخفضة / تحسينات

- `lib/app.mjs:585` — `pickBestArabic` يكرّر عميل LLM بدل `chat()` (لا `response.ok`، لا timeout، لا `loosen`).
- `lib/board.mjs:492` — فشل `fatal` في **قراءة الأسماء الاختيارية** يُفشل الترجمة كلها، خلافاً لوعد «بدونها الترجمة تكمل».
- `lib/subs.mjs:196` — `buildVtt` يبني النص بـ `out +=` (O(n²)) لملف قد يبلغ 8,000 سطر، وهو ما يتعارض مع هدف الـ 10ms CPU المعلن؛ استخدم `array.join()`.
- `server.mjs:38,52` — `putNames` / `putReport` يكتبان مباشرة بلا `tmp + rename` (بعكس `putFinal`) → تلف JSON عند تزامن طلبين.
- `lib/app.mjs:213` — `reportAdd` يقرأ ثم يكتب (get-then-put غير ذري) → فقدان عدّادات عند التزامن، خصوصاً على KV.
- `lib/llm.mjs:75` — `Number(retry-after)` لا يفهم صيغة HTTP-date فيُهملها.
- `lib/sources.mjs:10` — `new RegExp(env('SUBS_ALLOW'))` غير المحمي: قيمة خاطئة في متغير البيئة تُسقط كل الطلبات.
- `lib/anime.mjs:36,105` — أقواس `[…]` غير مرمّزة في استعلامات Kitsu؛ و`stripHtml` لا يفكّ كيانات مثل `&#x27;`.
- `lib/extraSources.mjs:217` — التعليق «بوب كورن نوتس — دائمًا يُضاف» غير صحيح: `if (!sd && !jm && !pn) return []` يمنعه؛ لكن مجرد إدخال مفتاح SubDL يؤدي فجأة لطلبات خارجية نحو `popcorn-notes.lsoares.workers.dev` دون ذكر في README.
- `lib/extraSources.mjs:266` — صيغة ترويسة Jimaku (`authorization: apiKey` بلا `Bearer`) تستحق تحققاً مقابل [وثائق Jimaku](https://jimaku.cc/api/docs)؛ الوثائق تذكر الترويسة ولا توضح القيمة في المقتطف المتاح.
- `README.md` — «10 ملّي ثانية» (تصحیح: 10 ميلي ثانية CPU)؛ `lib/subs.mjs:39` تعليق عربي فيه كلمة «títulos» إسبانية.

---

# خامساً: ما تأكدتُ أنه سليم ✅

- **لا أسرار hardcoded**: فحص شامل لكل `.mjs/.js/.html/.json` (عدا lockfile) عن مفاتيح/توكنز → نظيف. مفاتيح المستخدم تُقرأ من الرابط أو `localStorage` فقط.
- **الحزمة المبنية مطابقة للمصادر**: `npm run build` أعاد `_worker.js` متطابقاً byte-for-byte، ولا يحتوي `node:` / `require(` / `process.` / `Buffer` (اختبار workerd يؤكد ذلك).
- **الصياغة النحوية**: `node --check` نجح لكل 22 ملف JS.
- **allow-list على روابط التنزيل**: `sources.mjs::allow` و `fetchSubtitle` / `fetchExtraSubtitle` يمنعان تنزيل ترجمة من مضيف غير مسموح.
- **حماية جزئية لكن حقيقية** لمزوّد AI (`assertProviderAllowed` + `ALLOW_LOCAL_AI`)، وتصنيف أخطاء المزوّد في `llm.mjs` شامل (content / shape / fatal / retry) ومنطق «تقسيم الدفعة المرفوضة» متين.
- **تصميم `board.mjs`** (اللوحة + المساعدون + إعادة الحجز عند توقف المساعد + حفظ التقدّم) سليم، و245/251 اختباراً تنجح، بما فيها اختبارات workerd الحقيقية.
- **CORS / manifest / صفحة الإعدادات**: لا `innerHTML`، و`NOTICE` يُهرَّب بـ `escapeHtml`، ولا XSS ظاهر في الواجهة.
- `package-lock.json` متوافق مع `package.json`، و`npm ci` نجح (fflate 0.8.3، esbuild 0.25.12، miniflare 4.20260426.0).

---

# سادساً: ترتيب الإصلاح المقترح

1. `sub.url` (موضعان) + `isReady` في شرط 404 + `/ 60`. ← تُصلح 5 من 6 اختبارات الفاشلة دفعة واحدة.
2. إصلاح `!base` المبكر (الرسالة عند سقوط المصدر) + تحديث الاختبار القديم `«no subtitle in the chosen language»` الذي ما زال يتوقع `[]` رغم ميزة العربية الجاهزة.
3. تأمين: بصمة المفتاح في كاش SubDL، `assertProviderAllowed` على `ex` و `cfg.b` في `handleList`، `X-Forwarded-Host`، توسيع `isPrivateAddress`.
4. استعلام AniList → `Page { media(...) }` + تصحيح الـ mock.
5. `ex` / `fb` / `kitsu` URLs: allow-list موحّدة تُطبّق قبل أي `fetch`.
6. `.dockerignore` + إضافة `cloudflare/tarjuman-cloudflare.zip` للأرشيف + تحديث README (256→251، المصادر، الخصوصية، `warm`/`cf`).
7. بقية الملاحظات الوظيفية (`episode.mjs:66`، `extraSources.mjs:195`، `series.mjs` مع الأنمي، zip bomb، إلخ).

---

## ملفات مساحة العمل

| المسار | المحتوى |
|---|---|
| `google_drive/tarjuman-addon-0.9.6.zip` | الأرشيف الأصلي كما نُزّل من Drive (MD5 مطابق) |
| `review/tarjuman/` | الكود مفكوكاً (30 ملفاً) |
| `review/tarjuman/cloudflare/tarjuman-cloudflare.zip` | **مولّد أثناء المراجعة** — كان ناقصاً في الأرشيف |
| `review/CODE_REVIEW-ar.md` | هذا التقرير |
| `/tmp/test.log`, `/tmp/test2.log` | مخرجات `npm test` قبل/بعد توليد الـ zip |

**المصدر الوحيد الخارجي الموثّق:** [1] AniList Docs — [Media / Search anime by title](https://docs.anilist.co/guide/graphql/queries/media) (البحث عبر `Page.media` لا `Media(search:)`).
