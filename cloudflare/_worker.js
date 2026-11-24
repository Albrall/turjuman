// Tarjuman for Cloudflare. Built from the sources by build.mjs: change those, not this file.

// lib/anilist.mjs
var DEFAULT_URL = "https://graphql.anilist.co";
var TIMEOUT_MS = 8e3;
var post = async (url, query, variables) => {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`);
  const body = await response.json().catch(() => null);
  if (body?.errors?.length) throw new Error(String(body.errors[0]?.message || "graphql error").slice(0, 200));
  return body?.data;
};
var searchAnime = async ({ name, year }, url = "") => {
  if (!name) return null;
  url = url || DEFAULT_URL;
  const data = await post(url, `query ($search: String!) { Page(page: 1, perPage: 5) { media(search: $search, type: ANIME, sort: SEARCH_MATCH) { id title { romaji english native } startDate { year } } } }`, { search: String(name).slice(0, 200) });
  const media = (data?.Page?.media || [])[0];
  if (!media?.id) return null;
  const its = Number(media.startDate?.year) || 0;
  if (year && its && Math.abs(its - year) > 2) return null;
  return { id: media.id, title: String(media.title?.english || media.title?.romaji || name), year: its || year || 0 };
};
var animeCharacters = async (mediaId, url = "") => {
  url = url || DEFAULT_URL;
  const data = await post(url, `query ($id: Int!) { Media(id: $id) { characters(sort: [FAVOURITES_DESC], perPage: 80) { edges { node { id name { full native } gender } } } } }`, { id: mediaId });
  return (data?.Media?.characters?.edges || []).map((edge) => ({
    id: edge?.node?.id,
    name: String(edge?.node?.name?.full || "").trim(),
    native: String(edge?.node?.name?.native || "").trim(),
    gender: String(edge?.node?.gender || "").trim()
  })).filter((entry) => entry.id && entry.name);
};

// lib/anime.mjs
var KITSU_DEFAULT = "https://kitsu.io";
var ANILIST_DEFAULT = "https://graphql.anilist.co";
var TIMEOUT_MS2 = 8e3;
var UA = "tarjuman-addon (anime subtitles)";
var parseAnimeId = (id) => {
  const match = /^(kitsu|mal|anilist):(\d{1,9})(?::(\d{1,5}))?$/.exec(String(id || ""));
  if (!match) return null;
  return { family: match[1], id: Number(match[2]), episode: match[3] === void 0 ? null : Number(match[3]) };
};
var isAnimeId = (id) => parseAnimeId(id) !== null;
var ID_OR_ANIME = /^(?:tt\d{5,10}(?::\d{1,4}:\d{1,4})?|(?:kitsu|mal|anilist):\d{1,9}(?::\d{1,5})?)$/;
var stripHtml = (html) => String(html || "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ").replace(/\s+([.,!?;:])/g, "$1").replace(/\s+/g, " ").trim();
var kitsuGet = async (kitsuUrl, path) => {
  const response = await fetch(`${kitsuUrl}/api/edge${path}`, {
    headers: { "user-agent": UA, accept: "application/vnd.api+json" },
    signal: AbortSignal.timeout(TIMEOUT_MS2)
  });
  if (!response.ok) throw new Error(`${response.status} from ${new URL(kitsuUrl).host}`);
  return response.json();
};
var anilistPost = async (anilistUrl, query, variables) => {
  const response = await fetch(anilistUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "x-client-id": "tarjuman-addon" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(TIMEOUT_MS2)
  });
  if (!response.ok) throw new Error(`${response.status} from ${new URL(anilistUrl).host}`);
  const body = await response.json().catch(() => null);
  if (body?.errors?.length) throw new Error(String(body.errors[0]?.message || "graphql error").slice(0, 150));
  return body?.data;
};
var fromAnilist = async (anilistUrl, { family, id }) => {
  const argument = family === "mal" ? "idMal" : "id";
  const data = await anilistPost(anilistUrl, `query ($id: Int!) { Media(${argument}: $id, type: ANIME) { id idMal title { romaji english native } description startDate { year } } }`, { id });
  const media = data?.Media;
  if (!media?.id) return null;
  return {
    about: stripHtml(media.description).slice(0, 600),
    title: media.title?.english || media.title?.romaji || media.title?.native || String(id),
    original: media.title?.native || "",
    year: Number(media.startDate?.year) || 0,
    anilistId: media.id,
    malId: Number(media.idMal) || null
  };
};
var animeMeta = async (rawId, { kitsu = KITSU_DEFAULT, anilist = ANILIST_DEFAULT } = {}) => {
  const parsed = parseAnimeId(rawId);
  if (!parsed) return null;
  try {
    if (parsed.family === "kitsu") {
      const [anime, mappings] = await Promise.all([
        kitsuGet(kitsu, `/anime/${parsed.id}`),
        kitsuGet(kitsu, `/anime/${parsed.id}/mappings?fields[mappings]=externalSite,externalId`).catch(() => null)
      ]);
      const a = anime?.data?.attributes;
      if (!a) return null;
      const mapped = {};
      for (const entry of mappings?.data || []) {
        if (entry?.attributes?.externalSite) mapped[entry.attributes.externalSite] = entry.attributes.externalId;
      }
      return {
        title: a.titles?.en || a.canonicalTitle || String(parsed.id),
        original: a.titles?.ja_jp || "",
        year: Number(String(a.startDate || "").slice(0, 4)) || 0,
        about: stripHtml(a.synopsis || a.description).slice(0, 600),
        episode: parsed.episode,
        anilistId: Number(mapped["anilist/anime"]) || null,
        malId: Number(mapped["myanimelist/anime"]) || null
      };
    }
    const meta = await fromAnilist(anilist, parsed);
    if (!meta) return null;
    return { ...meta, episode: parsed.episode };
  } catch {
    return { title: "", original: "", year: 0, about: "", episode: parsed.episode, anilistId: parsed.family === "anilist" ? parsed.id : null, malId: null };
  }
};
var animeEpisodeTitle = async (rawId, { kitsu = KITSU_DEFAULT } = {}) => {
  const parsed = parseAnimeId(rawId);
  if (!parsed?.episode) return "";
  if (parsed.family !== "kitsu") return "";
  try {
    const body = await kitsuGet(kitsu, `/episodes?filter[mediaId]=${parsed.id}&filter[number]=${parsed.episode}&fields[episodes]=titles,canonicalTitle&page[limit]=1`);
    const a = body?.data?.[0]?.attributes;
    return String(a?.titles?.en_us || a?.titles?.en_jp || a?.canonicalTitle || "").slice(0, 120);
  } catch {
    return "";
  }
};

// lib/episode.mjs
var parseVideoId = (id) => {
  const match = /^(tt\d{5,10})(?::(\d{1,4}):(\d{1,4}))?$/.exec(String(id || ""));
  if (!match) return null;
  return {
    imdb: match[1],
    season: match[2] === void 0 ? null : Number(match[2]),
    episode: match[3] === void 0 ? null : Number(match[3])
  };
};
var ARABIC_INDIC = /[٠-٩۰-۹]/g;
var normDigits = (text2) => String(text2 || "").replace(ARABIC_INDIC, (ch) => {
  const code = ch.codePointAt(0);
  const base = code >= 1776 ? 1776 : 1632;
  return String(code - base);
});
var PATTERNS = [
  /s0*(\d{1,3})[\s._-]*e0*(\d{1,4})/gi,
  /season[\s._-]*0*(\d{1,3})[\s._-]*(?:episode|ep|e)[\s._-]*0*(\d{1,4})/gi,
  /الموسم[\s._-]*0*(\d{1,3})[^\d]{0,24}(?:الحلقة|حلقه|حلقة)[\s._-]*0*(\d{1,4})/g
];
var X_PATTERN = /(\d{1,2})x(\d{1,3})(?!\d)/gi;
var markersIn = (text2) => {
  const plain = normDigits(String(text2 || "").toLowerCase());
  const out = [];
  for (const re of PATTERNS) {
    re.lastIndex = 0;
    for (let match; match = re.exec(plain); ) {
      const season = Number(match[1]), episode = Number(match[2]);
      if (season >= 1 && season <= 99 && episode >= 1 && episode <= 9999) out.push({ season, episode });
    }
  }
  X_PATTERN.lastIndex = 0;
  for (let match; match = X_PATTERN.exec(plain); ) {
    const season = Number(match[1]), episode = Number(match[2]);
    if (season >= 1 && season <= 99 && episode >= 1 && episode <= 500) out.push({ season, episode });
  }
  return out;
};
var verdictFor = (text2, expected) => {
  if (!expected || expected.season == null) return "unknown";
  const plain = normDigits(String(text2 || "").toLowerCase());
  const markers = markersIn(plain);
  const same = (marker) => marker.season === expected.season && marker.episode === expected.episode;
  if (markers.some(same)) return "same";
  const rangeRe = new RegExp(`-e0*${expected.episode}(?!\\d)`, "i");
  if (rangeRe.test(plain)) {
    const otherSeasons = markers.filter((marker) => marker.season !== expected.season);
    if (otherSeasons.length === 0) return "same";
  }
  return markers.length ? "wrong" : "unknown";
};
var normalizeTitle = (text2) => {
  const plain = String(text2 || "").toLowerCase().normalize("NFKD").replace(/\p{Diacritic}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ");
  return normDigits(plain).replace(/\s+/g, " ").trim();
};
var byName = (text2, expected, episodeName = "") => {
  const verdict = verdictFor(text2, expected);
  if (verdict !== "unknown") return verdict;
  if (episodeName && episodeName.length >= 8 && normalizeTitle(text2).includes(episodeName)) return "same";
  return "unknown";
};
var embeddedVerdict = (cues, expected) => verdictFor(cues.map((cue) => cue.text).join("\n"), expected);
var openingCues = (cues, count = 40) => cues.slice(0, count);

// lib/config.mjs
var ConfigError = class extends Error {
};
var number = (value, fallback, min, max2) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.min(max2, Math.max(min, Math.round(parsed))) : fallback;
};
var flag = (value, fallback) => value === void 0 ? fallback : Boolean(Number(value) || value === true);
var EFFORTS = ["", "minimal", "low", "medium", "high"];
var encodeText = (text2) => {
  let binary = "";
  for (const byte of new TextEncoder().encode(text2)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
var decodeText = (segment) => {
  const binary = atob(segment.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
};
var normalize = (input) => {
  if (!input || typeof input !== "object") throw new ConfigError("الإعدادات غير مقروءة");
  const base = String(input.b || "").trim().replace(/\/+$/, "");
  let url;
  try {
    url = new URL(base);
  } catch {
    throw new ConfigError("رابط مزود الـAI غير صحيح");
  }
  if (!["https:", "http:"].includes(url.protocol)) throw new ConfigError("رابط مزود الـAI غير صحيح");
  const model = String(input.m || "").trim();
  if (!model || model.length > 120) throw new ConfigError("اسم النموذج مطلوب");
  const key = String(input.k || "").trim();
  if (key.length > 400) throw new ConfigError("مفتاح الـAI أطول من المتوقع");
  const source = String(input.src || "eng").toLowerCase();
  const fallbackBase = String(input.fb || "").trim().replace(/\/+$/, "");
  if (fallbackBase) {
    let fallbackUrl;
    try {
      fallbackUrl = new URL(fallbackBase);
    } catch {
      throw new ConfigError("رابط المزوّد الاحتياطي غير صحيح");
    }
    if (!["https:", "http:"].includes(fallbackUrl.protocol)) throw new ConfigError("رابط المزوّد الاحتياطي غير صحيح");
  }
  return {
    b: base,
    k: key,
    m: model,
    r: EFFORTS.includes(input.r) ? input.r : "",
    src: /^[a-z]{3}$/.test(source) ? source : "eng",
    any: flag(input.any, true),
    warm: flag(input.warm, true),
    sdh: flag(input.sdh, true),
    nm: flag(input.nm, true),
    pn: flag(input.pn, true),
    nt: flag(input.nt, true),
    fb: fallbackBase,
    fk: String(input.fk || "").trim().slice(0, 400),
    fm: String(input.fm || "").trim().slice(0, 120),
    cf: flag(input.cf, true),
    // na: لا تُظهر خيار الترجمة إن وُجد ترجمة عربية جاهزة — يُكتفى بالعربي من المصادر
    na: flag(input.na, false),
    // ca: يقارن الذكاء الاصطناعي بين الترجمات العربية الجاهزة ويختار أفضلها قبل العرض (يصرف توكنز بسيطة لكل فيديو)
    ca: flag(input.ca, false),
    // ex: رابط مصدر إضافي للترجمات (مثل أوكستندد/بوب كورن نوتس) — اختياري، افتراضيًا المضيف الرسمي
    ex: String(input.ex || "").trim().slice(0, 200),
    // مفاتيح مصادر الترجمة الإضافية (فكرة 25) — كل مستخدم يدخل مفاتيحه؛ بغيابها المزود يُتخطى صامتًا
    sd: String(input.sd || "").trim().slice(0, 120),
    jm: String(input.jm || "").trim().slice(0, 120),
    n: number(input.n, 2, 1, 3),
    wait: number(input.wait, 50, 0, 120),
    bs: number(input.bs, 80, 5, 200),
    cc: number(input.cc, 4, 1, 8),
    gd: flag(input.gd, true)
  };
};
var decodeConfig = (segment) => {
  if (!/^[A-Za-z0-9_-]{8,4000}$/.test(segment)) throw new ConfigError("الإعدادات غير مقروءة");
  let parsed;
  try {
    parsed = JSON.parse(decodeText(segment));
  } catch {
    throw new ConfigError("الإعدادات غير مقروءة");
  }
  return normalize(parsed);
};
var IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;
var isPrivateAddress = (address) => {
  if (IPV4.test(address)) {
    const [a, b] = address.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127;
  }
  const v6 = address.toLowerCase();
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("::ffff:");
};
var LOCAL_NAME = /(^|\.)(localhost|local|internal|lan|home\.arpa)$/i;
var checked = /* @__PURE__ */ new Map();
var assertProviderAllowed = async (base, { allowLocal = false, lookup } = {}) => {
  if (allowLocal) return;
  const url = new URL(base);
  if (url.protocol !== "https:") throw new ConfigError("رابط مزود الـAI يجب أن يبدأ بـ https");
  if (Date.now() - (checked.get(url.hostname) ?? 0) < 10 * 6e4) return;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const literal = IPV4.test(host) || host.includes(":");
  if (!literal && LOCAL_NAME.test(host)) throw new ConfigError("عنوان مزود الـAI غير مسموح (شبكة داخلية)");
  let addresses = [host];
  if (!literal && lookup) {
    try {
      addresses = await lookup(host);
    } catch {
      throw new ConfigError("تعذّر الوصول إلى عنوان مزود الـAI");
    }
  }
  if (!addresses.length || (literal || lookup ? addresses.some(isPrivateAddress) : false)) throw new ConfigError("عنوان مزود الـAI غير مسموح (شبكة داخلية)");
  if (checked.size > 200) checked.clear();
  checked.set(url.hostname, Date.now());
};
var MAX_REDIRECTS = 2;
var isPrivateHost = (host) => {
  if (IPV4.test(host)) {
    const [a, b] = host.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127;
  }
  const v6 = host.toLowerCase();
  return v6 === "::1" || v6 === "::" || v6.startsWith("fc") || v6.startsWith("fd") || v6.startsWith("fe80") || v6.startsWith("::ffff:") || LOCAL_NAME.test(host);
};
var safeFetch = async (input, init = {}) => {
  let url = typeof input === "string" ? input : input.url || String(input);
  let redirects = 0;
  for (; ; ) {
    const u = new URL(url);
    const host = u.hostname.replace(/^\[|\]$/g, "");
    const loopback = host === "localhost" || host === "::1" || /^127\./.test(host);
    if (u.protocol === "http:" && loopback) {
    } else {
      if (u.protocol !== "https:") throw new Error(`رابط غير آمن: ${url}`);
      if (isPrivateHost(host)) throw new Error(`عنوان داخلي غير مسموح: ${url}`);
    }
    const response = await fetch(url, { ...init, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return response;
      if (redirects >= MAX_REDIRECTS) throw new Error(`تحويلات كثيرة جداً: ${url}`);
      redirects++;
      url = new URL(location, u).toString();
      await response.body?.cancel?.();
      continue;
    }
    return response;
  }
};
var MAX_SUBTITLE_BYTES = 1e6;
var MAX_ZIP_BYTES = 2e6;
var MAX_UNZIPPED_BYTES = 4e6;
var MAX_MODEL_BYTES = 256e3;
var tooLarge = (max2) => new Error(`الملف أكبر من الحد المسموح (${max2} بايت)`);
var readLimited = async (response, max2 = MAX_SUBTITLE_BYTES) => {
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > max2) {
    await response.body?.cancel?.();
    throw tooLarge(max2);
  }
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > max2) throw tooLarge(max2);
    return bytes;
  }
  const reader = body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > max2) {
        await reader.cancel();
        throw tooLarge(max2);
      }
      chunks.push(chunk);
    }
  } catch (error) {
    try {
      await reader.cancel();
    } catch {
    }
    throw error;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
};
var readTextLimited = async (response, max2 = MAX_SUBTITLE_BYTES) => new TextDecoder("utf-8").decode(await readLimited(response, max2));

// lib/sources.mjs
var AGENT = { "user-agent": "tarjuman-addon/0.2" };
var sourceSettings = (env) => ({
  source: (env("SUBS_SOURCE") || "https://opensubtitles-v3.strem.io").replace(/\/+$/, ""),
  meta: (env("META_SOURCE") || "https://v3-cinemeta.strem.io").replace(/\/+$/, ""),
  // المضيفات المسموحة بتنزيل ترجمات منها: Stremio/OpenSubtitles و SubDL و Jimaku (فكرة 25). العنوان يمر داخل رابط المستخدم، فالتقييد مهم.
  allow: new RegExp(env("SUBS_ALLOW") || "^https://([a-z0-9-]+\\.)*(strem\\.io|subdl\\.com|jimaku\\.cc|lsoares\\.workers\\.dev)/", "i"),
  kitsu: env("KITSU_URL") || "",
  anilist: env("ANILIST_URL") || "",
  subdl: env("SUBDL_URL") || "",
  subdlDl: env("SUBDL_DL_URL") || "",
  jimaku: env("JIMAKU_URL") || "",
  popcorn: env("POPCORN_URL") || ""
});
var getJson = async (url, timeoutMs) => {
  const response = await fetch(url, { headers: AGENT, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`);
  return JSON.parse(await readTextLimited(response));
};
var lists = /* @__PURE__ */ new Map();
var LIST_TTL = 10 * 6e4;
var listSubtitles = async ({ type, rawId, rawExtra }, settings) => {
  const cacheKey2 = `${type}/${rawId}`;
  const url = `${settings.source}/subtitles/${type}/${rawId}${rawExtra ? `/${rawExtra}` : ""}.json`;
  const kept = lists.get(cacheKey2);
  if (kept && Date.now() - kept.at < LIST_TTL) return kept.subtitles;
  const subtitles = ((await getJson(url, 8e3)).subtitles || []).filter((sub) => sub?.url && sub?.lang && settings.allow.test(sub.url));
  if (lists.size > 200) lists.delete(lists.keys().next().value);
  lists.set(cacheKey2, { at: Date.now(), subtitles });
  return subtitles;
};
var probeSource = async (settings) => {
  const started = Date.now();
  try {
    const response = await fetch(`${settings.source}/subtitles/movie/tt0111161.json`, { headers: AGENT, signal: AbortSignal.timeout(6e3) });
    await response.body?.cancel();
    return { ok: response.ok, status: response.status, ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error: error.name === "TimeoutError" ? "timeout" : "unreachable", ms: Date.now() - started };
  }
};
var CAM = /\b(cam|camrip|hdcam|ts|hdts|telesync|tc|telecine|scr|screener)\b/i;
var spaced = (name) => String(name || "").replace(/[._]+/g, " ");
var words = (name) => new Set(spaced(name).toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1));
var rank = (subtitles, filename = "") => {
  const mine = words(filename);
  const cinema = CAM.test(spaced(filename));
  return subtitles.map((sub, order) => {
    const name = `${sub.movieReleaseName || ""} ${sub.subtitleFileName || ""}`;
    let score = sub.m === "h" ? 100 : 0;
    if (mine.size) score += [...words(name)].filter((word) => mine.has(word)).length;
    if (CAM.test(spaced(name)) && !cinema) score -= 20;
    return { sub, score, order };
  }).sort((a, b) => b.score - a.score || a.order - b.order).map((entry) => entry.sub);
};
var FALLBACK = ["eng", "fre", "spa", "ger", "ita", "por", "pob", "rus", "tur", "dut", "pol", "jpn", "kor"];
var pickLanguage = (subtitles, preferred, anyLanguage) => {
  const has = (lang) => subtitles.some((sub) => sub.lang === lang);
  if (has(preferred)) return preferred;
  if (!anyLanguage) return null;
  return FALLBACK.find(has) ?? subtitles.find((sub) => sub.lang !== "ara")?.lang ?? null;
};
var NAMES = {
  eng: "English",
  fre: "French",
  spa: "Spanish",
  ger: "German",
  ita: "Italian",
  por: "Portuguese",
  pob: "Brazilian Portuguese",
  rus: "Russian",
  tur: "Turkish",
  dut: "Dutch",
  pol: "Polish",
  jpn: "Japanese",
  kor: "Korean",
  chi: "Chinese",
  hin: "Hindi",
  swe: "Swedish",
  dan: "Danish",
  nor: "Norwegian",
  fin: "Finnish",
  gre: "Greek",
  heb: "Hebrew",
  per: "Persian",
  ind: "Indonesian"
};
var languageName = (code) => NAMES[code] || "the source language";
var titles = /* @__PURE__ */ new Map();
var metas = /* @__PURE__ */ new Map();
var metaFor = async ({ type, id }, settings) => {
  if (isAnimeId(id)) return {};
  const imdb = String(id || "").split(":")[0];
  const key = `${type}/${imdb}`;
  const kept = metas.get(key);
  if (kept !== void 0) return kept;
  const { meta } = await getJson(`${settings.meta}/meta/${type}/${imdb}.json`, 5e3);
  const metaOrNothing = meta || {};
  if (metas.size > 100) metas.delete(metas.keys().next().value);
  metas.set(key, metaOrNothing);
  return metaOrNothing;
};
var episodeTitle = async ({ type, id }, settings) => {
  if (isAnimeId(id)) return animeEpisodeTitle(id, { kitsu: settings.kitsu || void 0 }).catch(() => "");
  const [imdb, season, episode] = String(id || "").split(":");
  if (type !== "series" || !season || !episode) return "";
  let meta;
  try {
    meta = await metaFor({ type, id }, settings);
  } catch {
    return "";
  }
  const video = (meta.videos || []).find((item) => String(item.season) === season && String(item.episode) === episode);
  const plain = String(video?.name || video?.title || "").toLowerCase().normalize("NFKD").replace(/\p{Diacritic}/gu, "");
  return plain.replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
};
var clip = (text2, max2) => {
  const plain = String(text2 || "").replace(/\s+/g, " ").trim();
  const cut = plain.length <= max2 ? plain : `${plain.slice(0, max2).replace(/\s+\S*$/, "")}…`;
  return cut.replace(/[.\s]+$/, "");
};
var describeTitle = async ({ type, id }, settings) => {
  const [imdb, season, episode] = id.split(":");
  const known = titles.get(id);
  if (known !== void 0) return known;
  if (isAnimeId(id)) {
    let about2 = "";
    try {
      const meta = await animeMeta(id, { kitsu: settings.kitsu || void 0, anilist: settings.anilist || void 0 });
      const kind = type === "series" ? "anime series" : "anime film";
      const year = meta?.year ? ` (${meta.year})` : "";
      about2 = `${meta?.title || id}${year}, an ${kind}`;
      if (meta?.original) about2 += `, original title: ${meta.original}`;
      if (meta?.episode != null) about2 += `, episode ${meta.episode}`;
      const story = clip(meta?.about, 350);
      if (story) about2 += `. The story: ${story}`;
    } catch {
    }
    if (titles.size > 300) titles.delete(titles.keys().next().value);
    titles.set(id, about2);
    return about2;
  }
  let about = "";
  try {
    const meta = await metaFor({ type, id }, settings);
    const year = String(meta.releaseInfo || meta.year || "").slice(0, 4);
    const genres = (meta.genres || meta.genre || []).slice(0, 3).join(", ");
    about = `${meta.name}${year ? ` (${year})` : ""}, a ${genres ? `${genres} ` : ""}${type === "series" ? "series" : "film"}`;
    let video;
    if (season && episode) {
      video = (meta.videos || []).find((item) => String(item.season) === season && String(item.episode) === episode);
      const name = video?.name || video?.title;
      about += `, season ${season} episode ${episode}${name ? ` "${name}"` : ""}`;
    }
    const story = clip(meta.description, 350), part = clip(video?.overview || video?.description, 250);
    if (story) about += `. The story: ${story}`;
    if (part) about += `. This episode: ${part}`;
  } catch {
  }
  if (titles.size > 300) titles.delete(titles.keys().next().value);
  titles.set(id, about);
  return about;
};

// lib/series.mjs
var showFacts = async ({ type, id }, settings) => {
  if (type !== "series") return null;
  let meta;
  try {
    meta = isAnimeId(id) ? await animeMeta(id, { kitsu: settings.kitsu || void 0, anilist: settings.anilist || void 0 }) : await metaFor({ type, id }, settings);
  } catch {
    return null;
  }
  const name = String(meta.name || "").trim();
  if (!name) return null;
  return { name, year: Number(String(meta.releaseInfo || meta.year || "").slice(0, 4)) || 0, genres: meta.genres || meta.genre || [] };
};
var genderOf = (gender) => /^male$/i.test(gender) ? "man" : /^female$/i.test(gender) ? "woman" : "other";
var seriesNames = async (ref, sources, store, url = "") => {
  const expected = parseVideoId(ref.i);
  if (ref.t !== "series") return null;
  const key = expected?.imdb || String(ref.i).replace(/:/g, "_");
  if (store.getNames) {
    const kept = await store.getNames(key).catch(() => null);
    if (kept && Array.isArray(kept.names)) return kept.names.length ? kept.names : null;
  }
  const facts = await showFacts({ type: ref.t, id: ref.i }, sources);
  if (!facts || !facts.genres.some((genre) => /animation/i.test(genre))) return null;
  let names = [];
  try {
    const found = await searchAnime({ name: facts.name, year: facts.year }, url);
    if (found) names = (await animeCharacters(found.id, url)).map((character) => ({ name: character.name, native: character.native || "", arabic: "", kind: genderOf(character.gender) })).slice(0, 80);
  } catch {
    names = null;
  }
  if (!names) return null;
  if (store.putNames) await store.putNames(key, { names }).catch(() => {
  });
  return names.length ? names : null;
};
var learnSeriesNames = async (key, entries, store) => {
  if (!store.getNames || !store.putNames) return 0;
  const kept = await store.getNames(key).catch(() => null);
  if (!kept || !Array.isArray(kept.names)) return 0;
  const index = new Map(kept.names.map((entry) => [entry.name.toLowerCase(), entry]));
  let learned = 0;
  for (const entry of entries) {
    const known = index.get(String(entry.name || "").toLowerCase());
    if (!known) continue;
    if (!known.arabic && entry.arabic) {
      known.arabic = String(entry.arabic).slice(0, 80);
      learned++;
    }
    if (known.kind === "other" && ["man", "woman"].includes(entry.kind)) known.kind = entry.kind;
  }
  if (learned) await store.putNames(key, kept).catch(() => {
  });
  return learned;
};
var storedEntry = (name, seriesList) => {
  const lower = String(name || "").toLowerCase();
  if (!lower) return null;
  const exact = seriesList.find((known) => known.name.toLowerCase() === lower);
  if (exact) return exact;
  if (lower.includes(" ")) return null;
  const starting = seriesList.filter((known) => known.name.toLowerCase().startsWith(`${lower} `));
  return starting.length === 1 ? starting[0] : null;
};
var applySeriesNames = (entry, seriesList) => {
  if (!seriesList?.length) return { entry, learned: null };
  const stored = storedEntry(entry.name, seriesList);
  if (!stored) return { entry, learned: null };
  const learned = !stored.arabic && entry.arabic ? { name: stored.name, arabic: String(entry.arabic).slice(0, 80), kind: entry.kind } : null;
  return {
    entry: { ...entry, arabic: stored.arabic || entry.arabic, kind: ["man", "woman"].includes(stored.kind) ? stored.kind : entry.kind },
    learned
  };
};

// lib/llm.mjs
var LlmError = class extends Error {
  constructor(message, { status = 0, kind = "retry", retryAfter = 0 } = {}) {
    super(message);
    this.status = status;
    this.kind = kind;
    this.retryAfter = retryAfter;
  }
};
var sleep = (ms, signal) => new Promise((resolve) => {
  if (signal?.aborted) return resolve();
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    resolve();
  }, { once: true });
});
var errorOf = (raw) => {
  try {
    let body = JSON.parse(raw);
    if (Array.isArray(body)) body = body[0];
    const error = body?.error;
    if (error && typeof error === "object") return error;
    if (typeof error === "string") return { message: error };
    if (typeof body?.message === "string") return { message: body.message };
  } catch {
  }
  return {};
};
var SPENT = /^(insufficient_quota|credit_balance_exhausted|billing_hard_limit_reached|billing_not_active|(organization|project)_(usage|spend)_limit_exceeded)$/;
var CONTENT_CODES = /^(invalid_prompt|content_filter|content_policy_violation|moderation_blocked|prohibited_content)$/i;
var CONTENT_WORDS = /flagged as potentially violating|\b(prompt|input|request|content|message)s? (was|were|is|has been) (flagged|blocked|filtered)|requires moderation|content (management |filtering )?polic|content[_ ]filter|safety system|prohibited[_ ]content/i;
var turnedDown = (status, error) => {
  if (CONTENT_CODES.test(String(error.code ?? ""))) return true;
  if (status !== 400 && status !== 403 && status !== 422) return false;
  const meta = error.metadata;
  if (meta && typeof meta === "object" && (Array.isArray(meta.reasons) || typeof meta.flagged_input === "string" || Array.isArray(meta.patterns))) return true;
  return CONTENT_WORDS.test(String(error.message ?? ""));
};
var failure = (status, raw, retryAfter = 0) => {
  const error = errorOf(raw);
  const said = String(error.message || raw).replace(/\s+/g, " ").trim().slice(0, 200);
  if (SPENT.test(String(error.code ?? "")) || SPENT.test(String(error.type ?? ""))) return new LlmError(`رصيد حساب الـAI انتهى أو بلغ حد الصرف (${status}): ${said}`, { status, kind: "fatal" });
  if (turnedDown(status, error)) return new LlmError(`المزود رفض محتوى الطلب (${status}): ${said}`, { status, kind: "content" });
  if (status === 401 || status === 403) return new LlmError(`مفتاح الـAI مرفوض (${status}): ${said}`, { status, kind: "fatal" });
  if (status === 404) return new LlmError(`النموذج أو رابط المزود غير موجود (404): ${said}`, { status, kind: "fatal" });
  if (status === 402 && !retryAfter) return new LlmError(`رصيد حساب الـAI غير كافٍ (402): ${said}`, { status, kind: "fatal" });
  if (status === 400 || status === 422) return new LlmError(`المزود رفض الطلب (${status}): ${said}`, { status, kind: "shape" });
  if (status === 429 || status === 402) return new LlmError(`المزود يطلب التمهّل (${status})`, { status, retryAfter });
  return new LlmError(`خطأ من مزود الـAI (${status}): ${said}`, { status, retryAfter });
};
var freshCaps = (effort) => ({ effort: Boolean(effort), temperature: true, json: true });
var loosen = (caps, message = "") => {
  const named = [["effort", /reasoning/i], ["temperature", /temperature/i], ["json", /response_format|json/i]].find(([field2, pattern]) => caps[field2] && pattern.test(message));
  const field = named?.[0] ?? ["effort", "temperature", "json"].find((name) => caps[name]);
  if (!field) return false;
  caps[field] = false;
  return true;
};
var chat = async ({ baseUrl, apiKey, model, messages, effort, caps, signal, timeoutMs = 12e4 }) => {
  const body = { model, messages };
  if (caps.temperature) body.temperature = 0.2;
  if (caps.json) body.response_format = { type: "json_object" };
  if (caps.effort && effort) body.reasoning_effort = effort;
  const timeout = AbortSignal.timeout(timeoutMs);
  let response, raw;
  try {
    response = await fetch(`${baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", ...apiKey ? { authorization: `Bearer ${apiKey}` } : {} },
      body: JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout
    });
    raw = await readTextLimited(response, MAX_MODEL_BYTES);
  } catch (error) {
    if (signal?.aborted) throw new LlmError("أُلغيت الترجمة", { kind: "fatal" });
    throw new LlmError(timeout.aborted ? "مزود الـAI لم يرد في الوقت المحدد" : `تعذّر الاتصال بمزود الـAI (${error.cause?.code || error.message})`);
  }
  if (!response.ok) throw failure(response.status, raw, Number(response.headers.get("retry-after")) || 0);
  let answer;
  try {
    answer = JSON.parse(raw);
  } catch {
    throw new LlmError("رد مزود الـAI ليس بالصيغة المتوقعة");
  }
  const choice = answer?.choices?.[0];
  const usage = answer?.usage ? { p: Number(answer.usage.prompt_tokens) || 0, c: Number(answer.usage.completion_tokens) || 0 } : null;
  let content = choice?.message?.content;
  if (Array.isArray(content)) content = content.map((part) => part?.text ?? "").join("");
  if (typeof content === "string" && content.trim()) return { text: content, usage };
  const declined = typeof choice?.message?.refusal === "string" ? choice.message.refusal.replace(/\s+/g, " ").trim().slice(0, 200) : "";
  if (choice?.finish_reason === "content_filter" || declined) throw new LlmError(`المزود رفض محتوى الطلب: ${declined || "content_filter"}`, { status: 200, kind: "content" });
  const inner = answer?.error ?? choice?.error;
  if (inner) throw failure(Number.isInteger(inner.code) && inner.code >= 400 ? inner.code : 502, JSON.stringify({ error: inner }));
  throw new LlmError("مزود الـAI أعاد ردًّا فارغًا");
};
var readMap = (text2) => {
  const first = text2.indexOf("{"), last = text2.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      let parsed = JSON.parse(text2.slice(first, last + 1));
      const nested = Object.values(parsed);
      if (nested.length === 1 && nested[0] && typeof nested[0] === "object" && !Array.isArray(nested[0])) parsed = nested[0];
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
    }
  }
  const pairs = {};
  for (const [, id, value] of text2.matchAll(/"(\d+)"\s*:\s*("(?:[^"\\]|\\.)*")/g)) {
    try {
      pairs[id] = JSON.parse(value);
    } catch {
    }
  }
  return pairs;
};

// lib/subs.mjs
var TIMING = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
var DIGITS = /^\d+$/;
var BLOCK = /^(NOTE|STYLE|REGION)\b/;
var ASS_TIME = /^\s*(\d{1,2}):(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/;
var parseAssTime = (value) => {
  const m = ASS_TIME.exec(String(value));
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / (m[4].length === 2 ? 100 : 1e3);
};
var parseAss = (raw) => {
  const cues = [];
  let inEvents = false, format = [];
  for (const rawLine of String(raw).split("\n")) {
    const line = rawLine.trim();
    if (/^\[events\]/i.test(line)) {
      inEvents = true;
      format = [];
      continue;
    }
    if (/^\[/.test(line)) {
      inEvents = false;
      continue;
    }
    if (!inEvents) continue;
    if (/^format\s*:/i.test(line)) {
      format = line.slice(line.indexOf(":") + 1).split(",").map((s) => s.trim().toLowerCase());
      continue;
    }
    if (!/^dialogue\s*:/i.test(line)) continue;
    const rest = line.slice(line.indexOf(":") + 1);
    const fieldCount = Math.max(format.length, 10);
    const fields = [];
    let at = 0;
    for (let i = 0; i < fieldCount - 1; i++) {
      const comma = rest.indexOf(",", at);
      if (comma < 0) break;
      fields.push(rest.slice(at, comma));
      at = comma + 1;
    }
    fields.push(rest.slice(at));
    const get = (name) => {
      const idx = format.indexOf(name);
      return idx >= 0 ? fields[idx] ?? "" : "";
    };
    const start = parseAssTime(get("start")), end = parseAssTime(get("end"));
    if (start === null || end === null || end <= start) continue;
    if (/^(sign|signs|title|credit|note)$/i.test(String(get("style")).trim())) continue;
    const text2 = get("text").replace(/\\h/g, " ").replace(/\{\\[^}]*\}/g, "").replace(/\\N/gi, "\n").replace(/\\,/g, ",").trim();
    if (text2) cues.push({ start, end, text: text2 });
  }
  return cues.sort((a, b) => a.start - b.start);
};
var seconds = (match, at) => {
  const fraction = match[at + 3];
  return (match[at] ? Number(match[at]) * 3600 : 0) + Number(match[at + 1]) * 60 + Number(match[at + 2]) + Number(fraction) / (fraction.length === 3 ? 1e3 : fraction.length === 2 ? 100 : 10);
};
var isBlank = (line) => {
  if (line.length === 0) return true;
  const first = line.charCodeAt(0);
  return (first <= 32 || first === 160 || first === 12288 || first === 65279) && line.trim() === "";
};
var parseSubtitle = (raw) => {
  let text2 = String(raw);
  if (text2.charCodeAt(0) === 65279) text2 = text2.slice(1);
  if (/\[events\]/i.test(text2) && /^\s*dialogue\s*:/im.test(text2)) return parseAss(text2);
  if (text2.includes("\r")) text2 = text2.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = text2.split("\n");
  const blank = (i) => i < 0 || isBlank(lines[i]);
  const cues = [];
  let body = null;
  let start = 0, end = 0;
  let skipping = false;
  const close = () => {
    if (body === null) return;
    let joined = "";
    for (const line of body) {
      const trimmed = line.trim();
      if (trimmed) joined = joined ? `${joined}
${trimmed}` : trimmed;
    }
    if (joined && end > start) cues.push({ start, end, text: joined });
    body = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const timing = line.includes("-->") ? TIMING.exec(line) : null;
    if (timing) {
      if (body !== null && !blank(i - 1) && (blank(i - 2) || DIGITS.test(lines[i - 1].trim()))) body.pop();
      close();
      skipping = false;
      start = seconds(timing, 1);
      end = seconds(timing, 5);
      body = [];
    } else if (isBlank(line)) {
      skipping = false;
    } else if (blank(i - 1) && line.charCodeAt(0) >= 78 && line.charCodeAt(0) <= 83 && BLOCK.test(line)) {
      close();
      skipping = true;
    } else if (body !== null && !skipping) {
      body.push(line);
    }
  }
  close();
  return cues.sort((a, b) => a.start - b.start);
};
var NOTE = /[\u266A\u266B\u266C]/;
var isSongCue = (text2) => NOTE.test(String(text2));
var AD = /(www\.[a-z0-9-]+\.[a-z]{2,}|https?:\/\/|opensubtitles|osdb\.link|subtitles? by |subtitles downloaded|sync(?:ed|hronized)?,? (?:and|&) correct|advertise your product|become a? ?vip|rate this subtitle)/i;
var STYLE_CODE = /\{\\[^}]*\}/g;
var TAG = /<\/?([a-zA-Z][\w.]*)[^>]*>/g;
var BASIC_TAG = /^[ibu]$/i;
var TAG_ATTRIBUTES = /\s[^>]*(?=>)/;
var EMPTY_TAG = /<([ibu])>\s*<\/\1>/g;
var BASIC_MARKUP = /<\/?[ibu]>/g;
var SPACES = /[ \t]+/g;
var SIGNS_ONLY = /^[\s♪♫#*~-]+$/;
var SQUARE = /\[[^\]]*\]/g;
var ROUND = /\([^()]{1,60}\)/g;
var SPEAKER = /^(-\s*)?[A-Z][A-Z0-9 .'#-]{1,25}:\s+/;
var keepBasicTags = (tag, name) => BASIC_TAG.test(name) ? tag.toLowerCase().replace(TAG_ATTRIBUTES, "") : "";
var tidyLine = (line, dropSounds) => {
  if (dropSounds) {
    if (line.includes("[")) line = line.replace(SQUARE, "");
    if (line.includes("(")) line = line.replace(ROUND, "");
    if (line.includes(":")) line = line.replace(SPEAKER, "$1");
  }
  if (line.includes("<")) line = line.replace(EMPTY_TAG, "");
  if (line.includes("  ") || line.includes("	")) line = line.replace(SPACES, " ");
  return line.trim();
};
var signsOnly = (line) => {
  const first = line.charCodeAt(0);
  if (first !== 9834 && first !== 9835 && first !== 35 && first !== 42 && first !== 126 && first !== 45 && first !== 60) return false;
  return SIGNS_ONLY.test(line.includes("<") ? line.replace(BASIC_MARKUP, "") : line);
};
var tidy = (cues, { dropSounds = true } = {}) => {
  const kept = [];
  for (const cue of cues) {
    let text2 = cue.text;
    if (text2.includes("{")) text2 = text2.replace(STYLE_CODE, "");
    if (text2.includes("<")) text2 = text2.replace(TAG, keepBasicTags);
    if (text2.includes("-->")) text2 = text2.replaceAll("-->", "→");
    if (text2.includes("\n")) {
      let joined = "";
      for (const raw of text2.split("\n")) {
        const line = tidyLine(raw, dropSounds);
        if (line && !signsOnly(line)) joined = joined ? `${joined}
${line}` : line;
      }
      text2 = joined;
    } else {
      text2 = tidyLine(text2, dropSounds);
      if (text2 && signsOnly(text2)) text2 = "";
    }
    if (text2 && !AD.test(text2)) kept.push({ start: cue.start, end: cue.end, text: text2 });
  }
  return kept;
};
var two = (value) => value < 10 ? `0${value}` : `${value}`;
var stamp = (seconds2) => {
  const ms = Math.max(0, Math.round(seconds2 * 1e3));
  const rest = ms % 1e3;
  return `${two(Math.floor(ms / 36e5))}:${two(Math.floor(ms / 6e4) % 60)}:${two(Math.floor(ms / 1e3) % 60)}.${rest < 10 ? `00${rest}` : rest < 100 ? `0${rest}` : rest}`;
};
var RLM = "‏";
var buildVtt = (cues) => {
  const sorted = [...cues].sort((a, b) => a.start - b.start);
  const parts = ["WEBVTT\n\n"];
  for (let i = 0; i < sorted.length; i++) {
    const cue = sorted[i];
    let text2 = cue.text;
    if (text2.includes("-->")) text2 = text2.replaceAll("-->", "→");
    let body = "";
    if (text2.includes("\n")) {
      for (const raw of text2.split("\n")) {
        const line = raw.trim();
        if (line) body += (body ? "\n" : "") + (cue.rtl ? RLM + line : line);
      }
    } else {
      const line = text2.trim();
      if (line) body = cue.rtl ? RLM + line : line;
    }
    parts.push(`${i ? "\n\n" : ""}${stamp(cue.start)} --> ${stamp(cue.end)}${cue.top ? " line:0" : ""}
${body}`);
  }
  return `${parts.join("")}
`;
};

// lib/board.mjs
var PROMPT_VERSION = 3;
var MAX_ATTEMPTS = 6;
var MAX_REFUSALS = 12;
var STALE_MS = 4e3;
var BRIEF_CHARS = 48e3;
var BRIEF_ATTEMPTS = 3;
var BRIEF_PATIENCE = 25e3;
var BRIEF_PARTS = 4;
var SPLIT = 5;
var PROBES = 6;
var NAMES_RULE = `A proper name is written by its SOUND in Arabic letters; its meaning is never translated. A woman called Hope is "هوب", never "أمل"; Mr. Stone is "السيد ستون", never "السيد حجر". Where a place has an established Arabic name, use it (London → لندن, Egypt → مصر).
A capitalised word in the middle of a sentence is a name even when it is also an ordinary word (Hope, Grace, Hunter, Summer, Will, Mark, Rose).
At the start of a sentence the capital letter proves nothing, so read the sentence: "Hope, wait for me" speaks to the woman, while "Hope is all we have left" is about the feeling and is translated as "الأمل".
A word that only says what someone is — their age, rank, work, kinship or looks — is not a name, with or without a capital letter and even when they are spoken to by it: old-timer, old man, kid, boss, captain, master, teacher, big brother, granny. Translate it: "Who are you, Old-timer?" → "من أنت أيها العجوز؟". Before a name it is a title: the title is translated and the name is written by sound (Master Roshi → المعلم روشي). A nickname that someone goes by in the story is a name all the same (Red, Baby).
The characters of a known film, series or anime are written the way Arabic-speaking viewers know them (Goku → غوكو, Piccolo → بيكولو, Vegeta → فيجيتا). In Japanese names a hard g is غ, ch is تش, ts is تس, and a long vowel is written once (Ichigo → إيتشيغو, Yuuki → يوكي).
A Japanese honorific after a name is kept, in Arabic letters, wherever the line has it: -san is سان, -kun is كن, -chan is تشان, -sama is ساما, -sensei is سينسي, -senpai is سينباي (Kakashi-sensei → كاكاشي سينسي).`;
var systemPrompt = ({ from, about }) => `You are a professional subtitle translator working from ${from} into Arabic.

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
- ${NAMES_RULE.replaceAll("\n", "\n- ")}
- Spell the names listed in "names" letter for letter as given there, and use what it says about a person (man or woman) for the gender of verbs, pronouns and adjectives, also when that person is being spoken to.
- "names" says how a word is written when it is used as a name. Where the same word is used as an ordinary word, translate it as usual.
- Word the entries of "terms" as given there.

What you are translating: ${about || "a film or a series episode"}.`;
var seriesSection = ({ series }) => {
  if (!series?.length) return "";
  const stored = series.filter((entry) => entry.arabic);
  const lines = series.map((entry) => `- ${entry.name}${entry.native ? ` (${entry.native})` : ""} — ${entry.kind}${entry.arabic ? ` → ${entry.arabic}` : ""}`);
  return `
The characters of this work, known from its database, with their gender. Write "name" exactly as shown below, and set "kind" from it:
${lines.join("\n")}${stored.length ? `
These have a spelling already chosen for this work; use it exactly as it is, every time it occurs:
${stored.map((entry) => `- ${entry.name} → ${entry.arabic}`).join("\n")}` : ""}
A name of this list with no spelling yet is spelt by you — the spelling you choose is kept, and the whole work reuses it.`;
};
var briefPrompt = ({ from, about, series }, sampled) => `You are preparing a translator's brief for the Arabic subtitles of: ${about || "a film or a series episode"}.

You receive the subtitle lines in ${from}${sampled ? ' (a sample of them; "[…]" marks what was left out)' : ""}. Read them and return ONLY a JSON object of this shape:
{"names":[{"name":"…","arabic":"…","kind":"man"}],"terms":[{"term":"…","arabic":"…"}]}

"names": the proper names that occur in the lines — people (first names, surnames, nicknames), places, organisations, ships, brands.
- "name": as written in the lines. One entry per distinct name: "Robert Fischer" and "Fischer" are two entries.
- "arabic": how to write it in Arabic. ${NAMES_RULE.replaceAll("\n", "\n  ")}
- "kind": "man", "woman", "place", "group" or "other". Use what you know about this film, series or anime, and the lines themselves (how a person is addressed, he or she), to tell men from women. "other" when unsure.
- Leave out ordinary words that are capitalised only because they start a sentence, and days, months, languages and nationalities.
- Leave out the words that only say what someone is and by which they are spoken to (old-timer, old man, kid, boss, captain, master, big brother): they are not names.
- At most 80 names, the most frequent first.${seriesSection({ series })}

"terms": up to 15 special words or phrases that recur and should be worded the same way every time: invented words, jargon, ranks, forms of address, code names whose meaning matters. "arabic" is the wording to use. Leave out ordinary vocabulary. An empty list is fine.`;
var briefInput = (cues) => {
  let total = 0;
  for (const cue of cues) total += cue.text.length + 1;
  const flat = (cue) => cue.text.includes("\n") ? cue.text.replaceAll("\n", " ") : cue.text;
  if (total <= BRIEF_CHARS) return { text: cues.map(flat).join("\n"), sampled: false };
  const run2 = 30;
  const runs = Math.max(2, Math.floor(BRIEF_CHARS / (total / cues.length * run2)));
  const step = (cues.length - run2) / (runs - 1);
  const parts = [];
  for (let i = 0; i < runs; i++) {
    const from = Math.round(i * step);
    parts.push(cues.slice(from, from + run2).map(flat).join("\n"));
  }
  return { text: parts.join("\n[…]\n"), sampled: true };
};
var KINDS = ["man", "woman", "place", "group"];
var readBrief = (text2) => {
  const clean = (value) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  const names = [], terms = [], seen = /* @__PURE__ */ new Set();
  for (const [chunk] of String(text2).matchAll(/\{[^{}]*\}/g)) {
    let item;
    try {
      item = JSON.parse(chunk);
    } catch {
      continue;
    }
    const source = clean(item.name ?? item.term), arabic = clean(item.arabic);
    if (!source || !/[\u0600-\u06FF]/.test(arabic) || seen.has(source.toLowerCase())) continue;
    seen.add(source.toLowerCase());
    if (item.name !== void 0) {
      if (names.length < 120) names.push({ name: source, arabic, kind: KINDS.includes(item.kind) ? item.kind : "other" });
    } else if (terms.length < 30) {
      terms.push({ term: source, arabic });
    }
  }
  return { names, terms };
};
var readNotes = (text2) => {
  const notes = [];
  const start = String(text2).search(/\[/);
  if (start < 0) return notes;
  const end = String(text2).lastIndexOf("]");
  if (end <= start) return notes;
  let parsed;
  try {
    parsed = JSON.parse(String(text2).slice(start, end + 1));
  } catch {
    return notes;
  }
  if (!Array.isArray(parsed)) return notes;
  const clean = (value) => typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  for (const item of parsed) {
    const find = clean(item?.find), note = clean(item?.note);
    if (find && note && notes.length < 3) notes.push({ find: find.slice(0, 120), note: note.slice(0, 80) });
  }
  return notes;
};
var notesPrompt = () => `You are a translator's editor for an Arabic fansub of an anime episode.
The translation into Arabic is done. Some moments in it will not land with an Arabic-speaking viewer: a joke that only works in the source language, a Japanese word kept in Arabic letters, a line that plays on something the anime audience knows.
Pick at most three of those moments — no more. For each, one short note of at most twelve Arabic words, natural for this show.
Return ONLY a JSON array: [{"find": "…", "note": "…"}]
- "find": a phrase copied exactly from the Arabic translation of that one line (the first six to ten words of it). It is used to position the note, so it must occur in the text.
- An empty array is fine. Prefer silence to a forced note.`;
var normalize2 = (text2) => String(text2).replace(/[\u064B-\u065F\u0670\u0640\u200F\u200E]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
var anchorNotes = (notes, cues, out) => {
  const found = [];
  for (const note of notes) {
    const needle = normalize2(note.find).split(" ").slice(0, 8).join(" ");
    if (needle.length < 4) continue;
    for (let i = 0; i < cues.length; i++) {
      const text2 = out[i];
      if (typeof text2 === "string" && normalize2(text2).includes(needle)) {
        const start = cues[i].start;
        found.push({ start, end: Math.min(start + 5, cues[i].end + 4), text: `ملاحظة المترجم: ${note.note}` });
        break;
      }
    }
    if (found.length >= 3) break;
  }
  return found;
};
var LETTER = /\p{L}/u;
var occurs = (text2, phrase) => {
  for (let at = text2.indexOf(phrase); at >= 0; at = text2.indexOf(phrase, at + 1)) {
    const before = text2[at - 1], after = text2[at + phrase.length];
    if (!(before && LETTER.test(before)) && !(after && LETTER.test(after))) return true;
  }
  return false;
};
var makeBatches = (cues, indexes, size) => {
  const batches = [];
  let batch = [], weight = 0;
  for (const index of indexes) {
    const length = cues[index].text.length;
    if (batch.length && (batch.length >= size || weight + length > size * 100)) {
      batches.push(batch);
      batch = [];
      weight = 0;
    }
    batch.push(index);
    weight += length;
  }
  if (batch.length) batches.push(batch);
  return batches;
};
var cacheKey = async (parts) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(parts)));
  let hex = "";
  for (const byte of new Uint8Array(digest, 0, 16)) hex += byte.toString(16).padStart(2, "0");
  return hex;
};
var sequence = 0;
var fill = (board, batchSize) => {
  const waiting = [];
  for (let i = 0; i < board.cues.length; i++) if (board.out[i] === void 0) waiting.push(i);
  board.queue = makeBatches(board.cues, waiting, batchSize).map((lines) => ({ lines, attempt: 1, refused: 0, notBefore: 0 }));
  if (board.brief === void 0 && board.queue.length) board.queue.unshift({ brief: true, attempt: 1, refused: 0, notBefore: 0 });
};
var createBoard = ({ key, cues, out, from, about, batchSize, wantBrief = false, brief, asWritten, seriesNames: seriesNames2, learnNames, wantNotes = false }) => {
  const board = {
    key,
    cues,
    from,
    about,
    brief: brief ?? (wantBrief ? void 0 : null),
    // undefined: still to be made · null: none wanted · { names, terms }
    briefSince: 0,
    // when the brief was first asked for
    out: out ?? new Array(cues.length),
    translated: 0,
    requests: 0,
    state: "running",
    error: "",
    lastError: "",
    fatal: false,
    queue: [],
    // batches waiting: { lines, attempt, notBefore }
    claims: /* @__PURE__ */ new Map(),
    // batches being translated: claim id → { helper, task }
    helpers: /* @__PURE__ */ new Map(),
    // helper id → the time of its last beat
    caps: null,
    shape: 0,
    // the optional request fields the provider accepts, and how many times that list changed
    pauseUntil: 0,
    // the provider asked everyone to wait until then
    accepted: 0,
    // batches the provider answered: what shows that it takes this video at all
    refusals: 0,
    // requests it turned down for what they say
    unproven: /* @__PURE__ */ new Set(),
    // lines it turned down when asked for them alone, while it has not answered anything yet
    probe: null,
    // { left: the lines asked for alone to find out whether it answers at all, and not back yet }
    asWritten: /* @__PURE__ */ new Set(),
    // lines it turned down, left as they were written
    briefDraft: null,
    // the brief while its pieces come in: { names, terms, seen, open }
    tokens: { p: 0, c: 0 },
    // what the provider says was spent (input and output), added up
    notes: [],
    // ≤3 fansub-style notes shown over the top of the screen (idea 27)
    wantNotes: Boolean(wantNotes),
    notesDraft: null,
    series: seriesNames2?.length ? seriesNames2 : null,
    // the show's dictionary (idea 14), or null for a film or an unknown show
    learned: [],
    // spellings this brief chose, to hand back to the store
    learnNames: typeof learnNames === "function" ? learnNames : null,
    startedAt: Date.now(),
    finishedAt: 0
  };
  {
    let run2 = [];
    const flush = () => {
      if (run2.length >= 3) {
        for (const index of run2) if (board.out[index] === void 0) {
          board.out[index] = board.cues[index].text;
          board.asWritten.add(index);
          board.song = (board.song || 0) + 1;
        }
      }
      run2 = [];
    };
    for (let i = 0; i <= cues.length; i++) {
      if (i < cues.length && isSongCue(cues[i].text)) run2.push(i);
      else flush();
    }
  }
  for (let i = 0; i < cues.length; i++) if (board.out[i] !== void 0) board.translated++;
  for (const index of asWritten ?? []) if (Number.isInteger(index) && board.out[index] !== void 0) board.asWritten.add(index);
  fill(board, batchSize);
  return board;
};
var resumeBoard = (board, batchSize) => {
  if (board.state !== "failed") return board;
  Object.assign(board, { state: "running", error: "", lastError: "", fatal: false, caps: null, shape: 0, pauseUntil: 0, finishedAt: 0, briefSince: 0, refusals: 0, briefDraft: null, probe: null });
  board.claims.clear();
  board.unproven.clear();
  fill(board, batchSize);
  return board;
};
var reap = (board) => {
  const now = Date.now();
  for (const [id, beat] of board.helpers) if (now - beat > STALE_MS) board.helpers.delete(id);
  for (const [id, claim] of board.claims) {
    if (board.helpers.has(claim.helper)) continue;
    board.claims.delete(id);
    board.queue.unshift(claim.task);
  }
};
var alive = (board) => {
  reap(board);
  return board.helpers.size > 0;
};
var fail = (board, message, fatal = true) => {
  if (board.state !== "running") return;
  Object.assign(board, { state: "failed", fatal, error: message, finishedAt: Date.now() });
};
var again = (board, task, lines, reason, { notBefore = 0, refused = false } = {}) => {
  board.lastError = reason;
  const next = { lines, attempt: task.attempt + (refused ? 0 : 1), refused: task.refused + (refused ? 1 : 0), notBefore };
  if (task.bare) next.bare = true;
  if (task.probe) next.probe = true;
  if (next.attempt <= MAX_ATTEMPTS && next.refused <= MAX_REFUSALS) board.queue.push(next);
};
var proven = (board) => board.accepted > 0 || board.translated > board.asWritten.size;
var tooMany = (board) => Math.max(12, Math.ceil(board.cues.length * 0.08));
var unfit = (board) => {
  if (board.asWritten.size <= tooMany(board)) return false;
  fail(board, `رفض المزود ترجمة ${board.asWritten.size} سطرًا من هذا الفيديو، وهذا أكثر مما يُترك بلغته. جرّب نموذجًا أو مزودًا آخر`);
  return true;
};
var settle = (board) => {
  if (board.state !== "running" || !proven(board)) return;
  if (board.probe && board.queue.some((task) => task.probe)) board.queue = board.queue.filter((task) => !task.probe);
  if (!board.unproven.size) return;
  for (const index of board.unproven) {
    if (board.out[index] !== void 0) continue;
    board.out[index] = board.cues[index].text;
    board.translated++;
    board.asWritten.add(index);
  }
  board.unproven.clear();
  unfit(board);
};
var turnAway = (board) => {
  board.unproven.clear();
  fail(board, `رفض المزود كل ما أُرسل إليه، فجرّب نموذجًا أو مزودًا آخر — ${board.lastError}`);
};
var sendProbes = (board) => {
  const waiting = [];
  for (let i = 0; i < board.cues.length; i++) if (board.out[i] === void 0 && !board.unproven.has(i)) waiting.push(i);
  const count = Math.min(PROBES, waiting.length);
  const picked = Array.from({ length: count }, (_, k) => waiting[Math.floor((k + 0.5) * waiting.length / count)]);
  board.probe = { left: new Set(picked) };
  board.queue.unshift(...picked.map((index) => ({ lines: [index], attempt: 1, refused: 0, notBefore: 0, bare: true, probe: true })));
};
var turnedDown2 = (board, task, lines, message) => {
  board.refusals++;
  board.lastError = message;
  const piece = (part) => ({ lines: part, attempt: 1, refused: 0, notBefore: 0, bare: true });
  if (lines.length > 1) {
    const size = Math.ceil(lines.length / SPLIT);
    const pieces = [];
    for (let at = 0; at < lines.length; at += size) pieces.push(piece(lines.slice(at, at + size)));
    board.queue.unshift(...pieces);
  } else if (!task.bare) {
    board.queue.unshift(piece(lines));
  } else {
    board.unproven.add(lines[0]);
    if (board.probe?.left.delete(lines[0]) && !board.probe.left.size && !proven(board)) return turnAway(board);
    settle(board);
  }
  if (!board.probe && !proven(board)) sendProbes(board);
};
var plainArabic = (text2) => text2.replace(/[\u064B-\u065F\u0670\u0640]/g, "").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/ة/g, "ه");
var surelyName = (line, name) => {
  for (let at = line.indexOf(name); at >= 0; at = line.indexOf(name, at + 1)) {
    const before = line[at - 1], after = line[at + name.length];
    if (before && LETTER.test(before) || after && LETTER.test(after)) continue;
    const lead = line.slice(0, at).replace(/<\/?[ibu]>/g, "").replace(/[ \t"'“‘(-]+$/, "");
    if (lead && !/[.!?…:\n]$/.test(lead)) return true;
  }
  return false;
};
var misnamed = (source, arabic, names) => {
  if (!names.length) return false;
  const plain = plainArabic(arabic);
  return names.some((entry) => /^\p{Lu}/u.test(entry.name) && surelyName(source, entry.name) && !plain.includes(plainArabic(entry.arabic.split(" ").at(-1))));
};
var hasArabic = (text2) => /[\u0600-\u06FF]/.test(text2);
var hasWords = (text2) => (text2.replace(/<[^>]*>/g, "").match(/(?![\u0600-\u06FF])\p{L}/gu)?.length ?? 0) >= 3;
var ask = async (board, indexes, llm, signal, attempt, bare = false) => {
  const { cues } = board;
  const first = indexes[0], last = indexes.at(-1);
  let names = [];
  const around = (from, to) => {
    const lines = [];
    if (!bare) {
      for (let i = Math.max(0, from); i < Math.min(to, cues.length); i++) if (!board.asWritten.has(i) && !board.unproven.has(i)) lines.push(cues[i].text);
    }
    return lines;
  };
  const request = {
    context_before: around(first - 4, first),
    lines: Object.fromEntries(indexes.map((index) => [String(index + 1), cues[index].text])),
    context_after: around(last + 1, last + 3)
  };
  if (board.brief && (board.brief.names.length || board.brief.terms.length)) {
    const here = `${request.context_before.join("\n")}
${Object.values(request.lines).join("\n")}
${request.context_after.join("\n")}`.toLowerCase();
    names = board.brief.names.filter((entry) => occurs(here, entry.name.toLowerCase()));
    const terms = board.brief.terms.filter((entry) => occurs(here, entry.term.toLowerCase()));
    if (names.length) request.names = Object.fromEntries(names.map((entry) => [entry.name, entry.kind === "other" ? { arabic: entry.arabic } : { arabic: entry.arabic, is: entry.kind }]));
    if (terms.length) request.terms = Object.fromEntries(terms.map((entry) => [entry.term, entry.arabic]));
    if (names.length && attempt > 1) request.note = 'These lines are asked for again. Check each name against "names" and write it letter for letter as given there.';
  }
  board.requests++;
  board.prompt ??= systemPrompt(board);
  const reply = await chat({
    baseUrl: llm.baseUrl,
    apiKey: llm.apiKey,
    model: llm.model,
    effort: llm.effort,
    caps: board.caps,
    signal,
    messages: [{ role: "system", content: board.prompt }, { role: "user", content: JSON.stringify(request) }]
  });
  spent(board, reply.usage);
  return { answers: readMap(reply.text), names };
};
var spent = (board, usage) => {
  if (!usage) return;
  board.tokens.p += usage.p || 0;
  board.tokens.c += usage.c || 0;
};
var backOff = (board, error, attempt, fast) => {
  const seconds2 = error.retryAfter ? Math.min(error.retryAfter, 90) + 1 : Math.min(45, 1.5 * 2 ** attempt);
  const wait = seconds2 * (fast ? 1 : 1e3);
  if (error.retryAfter) board.pauseUntil = Math.max(board.pauseUntil, Date.now() + wait);
  return Date.now() + wait;
};
var reshape = (board, shape, message) => {
  if (shape !== board.shape) return true;
  if (!loosen(board.caps, message)) return false;
  board.shape++;
  return true;
};
var NO_BRIEF = { names: [], terms: [] };
var gather = (board, found) => {
  const draft = board.briefDraft;
  if (!draft) return;
  for (const entry of found.names) {
    const key = entry.name.toLowerCase();
    if (draft.seen.has(key) || draft.names.length >= 120) continue;
    draft.seen.add(key);
    const merged = applySeriesNames(entry, board.series);
    if (merged.learned) board.learned.push(merged.learned);
    draft.names.push(merged.entry);
  }
  for (const entry of found.terms) {
    const key = entry.term.toLowerCase();
    if (draft.seen.has(key) || draft.terms.length >= 30) continue;
    draft.seen.add(key);
    draft.terms.push(entry);
  }
  if (--draft.open > 0) return;
  board.brief = { names: draft.names, terms: draft.terms };
  board.briefDraft = null;
  if (board.learned.length && board.learnNames) {
    const learned = board.learned;
    board.learned = [];
    Promise.resolve().then(() => board.learnNames(learned)).catch(() => {
    });
  }
};
var prepare = async (board, task, llm, helper, fast) => {
  const shape = board.shape;
  const [from, to] = task.part ?? [0, board.cues.length];
  board.briefDraft ??= { names: [], terms: [], seen: /* @__PURE__ */ new Set(), open: 1 };
  try {
    board.requests++;
    const { text: text2, sampled } = briefInput(task.part ? board.cues.slice(from, to) : board.cues);
    const reply = await chat({
      baseUrl: llm.baseUrl,
      apiKey: llm.apiKey,
      model: llm.model,
      effort: llm.effort,
      caps: board.caps,
      signal: helper.abort.signal,
      messages: [{ role: "system", content: briefPrompt(board, sampled) }, { role: "user", content: text2 }]
    });
    spent(board, reply.usage);
    gather(board, readBrief(reply.text));
  } catch (error) {
    if (board.state !== "running") return;
    if (board.backupLlm && !board.useBackup && (error.kind === "fatal" || error.kind === "retry")) {
      board.useBackup = true;
      board.queue.unshift({ ...task, refused: 0, notBefore: 0 });
      return;
    }
    if (error.kind === "fatal") return fail(board, error.message);
    if (error.kind === "shape") {
      if (!reshape(board, shape, error.message)) return fail(board, error.message);
      board.queue.unshift({ ...task, notBefore: 0 });
      return;
    }
    if (error.kind === "content") {
      if (task.part || to - from < BRIEF_PARTS || !board.briefDraft) return gather(board, NO_BRIEF);
      const size = Math.ceil((to - from) / BRIEF_PARTS);
      const pieces = [];
      for (let at = from; at < to; at += size) pieces.push({ brief: true, attempt: 1, refused: 0, notBefore: 0, part: [at, Math.min(to, at + size)] });
      board.briefDraft.open += pieces.length - 1;
      board.queue.unshift(...pieces);
      return;
    }
    const refused = Boolean(error.retryAfter);
    const next = { ...task, attempt: task.attempt + (refused ? 0 : 1), refused: task.refused + (refused ? 1 : 0), notBefore: backOff(board, error, task.attempt, fast) };
    if (next.attempt <= BRIEF_ATTEMPTS && next.refused <= BRIEF_ATTEMPTS) board.queue.unshift(next);
    else gather(board, NO_BRIEF);
  }
};
var makeNotes = async (board, task, llm, helper, fast) => {
  if (board.notesUsed) return;
  board.notesUsed = true;
  try {
    board.requests++;
    const lines = board.out.map((text2, i) => [i + 1, typeof text2 === "string" ? text2 : board.cues[i].text]);
    const sampled = lines.length > 500 ? lines.filter((_, i) => i % Math.ceil(lines.length / 500) === 0) : lines;
    const user = {
      ...board.brief?.terms?.length ? { terms: board.brief.terms.map(({ term, arabic }) => ({ term, arabic })) } : {},
      ...board.brief?.names?.length ? { names: board.brief.names.slice(0, 60).map(({ name, arabic }) => ({ name, arabic })) } : {},
      lines: sampled
    };
    const reply = await chat({
      baseUrl: llm.baseUrl,
      apiKey: llm.apiKey,
      model: llm.model,
      effort: llm.effort,
      caps: board.caps,
      signal: helper.abort.signal,
      messages: [{ role: "system", content: notesPrompt() }, { role: "user", content: JSON.stringify(user) }]
    });
    spent(board, reply.usage);
    board.notes = anchorNotes(readNotes(reply.text), board.cues, board.out);
  } catch {
    board.notes = [];
  }
};
var work = async (board, task, llm, helper, fast) => {
  if (task.brief) return prepare(board, task, llm, helper, fast);
  if (task.notes) return makeNotes(board, task, llm, helper, fast);
  const pending = task.lines.filter((index) => board.out[index] === void 0 && !board.unproven.has(index));
  if (!pending.length) return;
  const shape = board.shape;
  try {
    const { answers, names } = await ask(board, pending, llm, helper.abort.signal, task.attempt, task.bare);
    board.accepted++;
    settle(board);
    if (task.probe) return;
    const read = (index) => {
      const raw = answers[String(index + 1)];
      return typeof raw === "string" ? raw.trim() : "";
    };
    const untouched = pending.filter((index) => read(index) && !hasArabic(read(index)) && hasWords(board.cues[index].text));
    const notTranslated = untouched.length > 2 && untouched.length > pending.length * 0.3;
    for (const index of pending) {
      const answer = read(index), source = board.cues[index].text;
      if (!answer || board.out[index] !== void 0) continue;
      const doubtful = untouched.includes(index) || misnamed(source, answer, names);
      if (doubtful && (task.attempt === 1 || notTranslated && untouched.includes(index))) continue;
      board.out[index] = answer;
      board.translated++;
    }
    const left = pending.filter((index) => board.out[index] === void 0);
    if (left.length) again(board, task, left, notTranslated ? "النموذج أعاد الأسطر كما هي بلا ترجمة" : "بعض الأسطر لم ترجع من النموذج");
  } catch (error) {
    if (board.state !== "running") return;
    if (board.backupLlm && !board.useBackup && (error.kind === "fatal" || error.kind === "retry")) {
      board.useBackup = true;
      board.queue.unshift({ ...task, refused: 0, notBefore: 0 });
      return;
    }
    if (error.kind === "fatal") return fail(board, error.message);
    if (error.kind === "content") return turnedDown2(board, task, pending, error.message);
    if (error.kind === "shape") {
      if (!reshape(board, shape, error.message)) return fail(board, error.message);
      board.queue.unshift({ ...task, lines: pending, notBefore: 0 });
      return;
    }
    again(board, task, pending, error.message || "خطأ من مزود الـAI", { notBefore: backOff(board, error, task.attempt, fast), refused: Boolean(error.retryAfter) });
  }
};
var quietly = async (action) => {
  try {
    await action();
  } catch {
  }
};
var run = async (board, llm, helper, { fast = false, onProgress, onDone }) => {
  board.caps ??= freshCaps(llm.effort);
  const active = /* @__PURE__ */ new Set();
  let wake = null;
  const nap = (ms) => new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  const beat = () => {
    board.helpers.set(helper.id, Date.now());
    if (board.state !== "running") helper.abort.abort();
  };
  beat();
  const pulse = setInterval(beat, 1e3);
  try {
    while (board.state === "running") {
      reap(board);
      settle(board);
      if (unfit(board) || board.state !== "running") break;
      const now = Date.now();
      const mayClaim = now < helper.stopAt;
      const briefed = board.brief !== void 0 || board.briefSince > 0 && now - board.briefSince > (fast ? 250 : BRIEF_PATIENCE);
      while (mayClaim && helper.requests < helper.budget && now >= board.pauseUntil && active.size < llm.concurrency && board.claims.size < llm.concurrency) {
        const ready = (task2) => task2.notBefore <= now && (briefed || task2.brief);
        let at = board.queue.findIndex(proven(board) ? ready : (task2) => ready(task2) && (!task2.bare || task2.probe));
        if (at < 0 && !proven(board) && board.claims.size === 0) at = board.queue.findIndex(ready);
        if (at < 0) break;
        const [task] = board.queue.splice(at, 1);
        if (task.brief) board.briefSince ||= now;
        const id = ++sequence;
        board.claims.set(id, { helper: helper.id, task });
        helper.requests++;
        const askingLlm = board.useBackup && board.backupLlm ? board.backupLlm : llm;
        const request = work(board, task, askingLlm, helper, fast).finally(() => {
          board.claims.delete(id);
          active.delete(request);
          wake?.();
        });
        active.add(request);
      }
      if (board.queue.length === 0 && board.claims.size === 0 && !board.notesUsed && board.wantNotes && board.translated === board.cues.length) {
        board.queue.unshift({ notes: true, attempt: 1, refused: 0, notBefore: 0 });
        continue;
      }
      if (board.queue.length === 0 && board.claims.size === 0) {
        const complete = board.translated === board.cues.length;
        if (board.unproven.size) turnAway(board);
        else Object.assign(board, complete ? { state: "done", finishedAt: now } : { state: "failed", fatal: false, error: board.lastError || "لم تكتمل الترجمة", finishedAt: now });
        break;
      }
      if (active.size === 0 && (!mayClaim || helper.requests >= helper.budget)) break;
      let ms = active.size ? 1e3 : 400;
      for (const task of board.queue) if (task.notBefore > now) ms = Math.min(ms, task.notBefore - now);
      if (board.pauseUntil > now) ms = Math.min(ms, board.pauseUntil - now);
      await nap(Math.max(2, ms));
      if (onProgress && board.state === "running") await quietly(() => onProgress(board, false));
    }
    if (active.size) {
      if (board.state !== "running") helper.abort.abort();
      await Promise.allSettled([...active]);
    }
    if (board.state === "done" && !board.stored) {
      board.stored = true;
      if (onDone) await quietly(() => onDone(board));
    } else if (board.state === "running" && onProgress) {
      await quietly(() => onProgress(board, true));
    }
  } finally {
    clearInterval(pulse);
    board.helpers.delete(helper.id);
  }
};
var startHelper = (board, llm, options = {}) => {
  board.backupLlm = options.backup ?? null;
  const helper = { id: ++sequence, requests: 0, budget: options.budget ?? Infinity, stopAt: options.stopAt ?? Infinity, abort: new AbortController(), finished: Promise.resolve() };
  if (board.state === "running") helper.finished = run(board, llm, helper, options);
  return helper;
};

// lib/report.mjs
var monthKey = (now = /* @__PURE__ */ new Date()) => now.toISOString().slice(0, 7);
var number2 = (value) => Number(value) || 0;
var mergeReport = (prev, delta = {}) => ({
  episodes: number2(prev?.episodes) + number2(delta.episodes),
  tv: number2(prev?.tv) + number2(delta.tv),
  film: number2(prev?.film) + number2(delta.film),
  lines: number2(prev?.lines) + number2(delta.lines),
  requests: number2(prev?.requests) + number2(delta.requests),
  tokensP: number2(prev?.tokensP) + number2(delta.tokensP),
  tokensC: number2(prev?.tokensC) + number2(delta.tokensC),
  withUsage: number2(prev?.withUsage) + number2(delta.withUsage),
  hits: number2(prev?.hits) + number2(delta.hits)
});
var esc = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
var grouped = (n) => Number(n).toLocaleString("ar-u-nu-arab");
var reportHtml = (data, monthLabel) => {
  const empty = !data || number2(data.episodes) + number2(data.hits) === 0 && number2(data.requests) === 0;
  const usage = number2(data?.withUsage) > 0;
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
  ${usage ? `<div class="kpis"><div><b>${grouped(data.tokensP)}</b><span>توكن دُخل (input)</span></div><div><b>${grouped(data.tokensC)}</b><span>توكن خُرج (output)</span></div><div><b>${grouped(number2(data.tokensP) + number2(data.tokensC))}</b><span>المجموع</span></div></div>
       <p class="note">العدد من مزوّدك كما أعلنه بعد كل طلب — ما فيه تقريب وما فيه سعر؛ السعر تحدّده خطتك.</p>` : `<p class="note">مزوّدك الحالي ما يرسل إحصاءات التوكنز (بعض المزوّدين مثل Ollama أو عبر وكيل لا يرسلها) — تُعرض «الطلبات» و«السطور» بدلًا منها.</p>`}`;
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
</main></body></html>`;
};

// node_modules/fflate/esm/browser.js
var u8 = Uint8Array;
var u16 = Uint16Array;
var i32 = Int32Array;
var fleb = new u8([
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  1,
  1,
  1,
  1,
  2,
  2,
  2,
  2,
  3,
  3,
  3,
  3,
  4,
  4,
  4,
  4,
  5,
  5,
  5,
  5,
  0,
  /* unused */
  0,
  0,
  /* impossible */
  0
]);
var fdeb = new u8([
  0,
  0,
  0,
  0,
  1,
  1,
  2,
  2,
  3,
  3,
  4,
  4,
  5,
  5,
  6,
  6,
  7,
  7,
  8,
  8,
  9,
  9,
  10,
  10,
  11,
  11,
  12,
  12,
  13,
  13,
  /* unused */
  0,
  0
]);
var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
var freb = function(eb, start) {
  var b = new u16(31);
  for (var i = 0; i < 31; ++i) {
    b[i] = start += 1 << eb[i - 1];
  }
  var r = new i32(b[30]);
  for (var i = 1; i < 30; ++i) {
    for (var j = b[i]; j < b[i + 1]; ++j) {
      r[j] = j - b[i] << 5 | i;
    }
  }
  return { b, r };
};
var _a = freb(fleb, 2);
var fl = _a.b;
var revfl = _a.r;
fl[28] = 258, revfl[258] = 28;
var _b = freb(fdeb, 0);
var fd = _b.b;
var revfd = _b.r;
var rev = new u16(32768);
for (i = 0; i < 32768; ++i) {
  x = (i & 43690) >> 1 | (i & 21845) << 1;
  x = (x & 52428) >> 2 | (x & 13107) << 2;
  x = (x & 61680) >> 4 | (x & 3855) << 4;
  rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
}
var x;
var i;
var hMap = (function(cd, mb, r) {
  var s = cd.length;
  var i = 0;
  var l = new u16(mb);
  for (; i < s; ++i) {
    if (cd[i])
      ++l[cd[i] - 1];
  }
  var le = new u16(mb);
  for (i = 1; i < mb; ++i) {
    le[i] = le[i - 1] + l[i - 1] << 1;
  }
  var co;
  if (r) {
    co = new u16(1 << mb);
    var rvb = 15 - mb;
    for (i = 0; i < s; ++i) {
      if (cd[i]) {
        var sv = i << 4 | cd[i];
        var r_1 = mb - cd[i];
        var v = le[cd[i] - 1]++ << r_1;
        for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
          co[rev[v] >> rvb] = sv;
        }
      }
    }
  } else {
    co = new u16(s);
    for (i = 0; i < s; ++i) {
      if (cd[i]) {
        co[i] = rev[le[cd[i] - 1]++] >> 15 - cd[i];
      }
    }
  }
  return co;
});
var flt = new u8(288);
for (i = 0; i < 144; ++i)
  flt[i] = 8;
var i;
for (i = 144; i < 256; ++i)
  flt[i] = 9;
var i;
for (i = 256; i < 280; ++i)
  flt[i] = 7;
var i;
for (i = 280; i < 288; ++i)
  flt[i] = 8;
var i;
var fdt = new u8(32);
for (i = 0; i < 32; ++i)
  fdt[i] = 5;
var i;
var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
var max = function(a) {
  var m = a[0];
  for (var i = 1; i < a.length; ++i) {
    if (a[i] > m)
      m = a[i];
  }
  return m;
};
var bits = function(d, p, m) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
};
var bits16 = function(d, p) {
  var o = p / 8 | 0;
  return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
};
var shft = function(p) {
  return (p + 7) / 8 | 0;
};
var slc = function(v, s, e) {
  if (s == null || s < 0)
    s = 0;
  if (e == null || e > v.length)
    e = v.length;
  return new u8(v.subarray(s, e));
};
var ec = [
  "unexpected EOF",
  "invalid block type",
  "invalid length/literal",
  "invalid distance",
  "stream finished",
  "no stream handler",
  ,
  // determined by compression function
  "no callback",
  "invalid UTF-8 data",
  "extra field too long",
  "date not in range 1980-2099",
  "filename too long",
  "stream finishing",
  "invalid zip data"
  // determined by unknown compression method
];
var err = function(ind, msg, nt) {
  var e = new Error(msg || ec[ind]);
  e.code = ind;
  if (Error.captureStackTrace)
    Error.captureStackTrace(e, err);
  if (!nt)
    throw e;
  return e;
};
var inflt = function(dat, st, buf, dict) {
  var sl = dat.length, dl = dict ? dict.length : 0;
  if (!sl || st.f && !st.l)
    return buf || new u8(0);
  var noBuf = !buf;
  var resize = noBuf || st.i != 2;
  var noSt = st.i;
  if (noBuf)
    buf = new u8(sl * 3);
  var cbuf = function(l2) {
    var bl = buf.length;
    if (l2 > bl) {
      var nbuf = new u8(Math.max(bl * 2, l2));
      nbuf.set(buf);
      buf = nbuf;
    }
  };
  var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
  var tbts = sl * 8;
  do {
    if (!lm) {
      final = bits(dat, pos, 1);
      var type = bits(dat, pos + 1, 3);
      pos += 3;
      if (!type) {
        var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
        if (t > sl) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + l);
        buf.set(dat.subarray(s, t), bt);
        st.b = bt += l, st.p = pos = t * 8, st.f = final;
        continue;
      } else if (type == 1)
        lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
      else if (type == 2) {
        var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
        var tl = hLit + bits(dat, pos + 5, 31) + 1;
        pos += 14;
        var ldt = new u8(tl);
        var clt = new u8(19);
        for (var i = 0; i < hcLen; ++i) {
          clt[clim[i]] = bits(dat, pos + i * 3, 7);
        }
        pos += hcLen * 3;
        var clb = max(clt), clbmsk = (1 << clb) - 1;
        var clm = hMap(clt, clb, 1);
        for (var i = 0; i < tl; ) {
          var r = clm[bits(dat, pos, clbmsk)];
          pos += r & 15;
          var s = r >> 4;
          if (s < 16) {
            ldt[i++] = s;
          } else {
            var c = 0, n = 0;
            if (s == 16)
              n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i - 1];
            else if (s == 17)
              n = 3 + bits(dat, pos, 7), pos += 3;
            else if (s == 18)
              n = 11 + bits(dat, pos, 127), pos += 7;
            while (n--)
              ldt[i++] = c;
          }
        }
        var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
        lbt = max(lt);
        dbt = max(dt);
        lm = hMap(lt, lbt, 1);
        dm = hMap(dt, dbt, 1);
      } else
        err(1);
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
    }
    if (resize)
      cbuf(bt + 131072);
    var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
    var lpos = pos;
    for (; ; lpos = pos) {
      var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
      pos += c & 15;
      if (pos > tbts) {
        if (noSt)
          err(0);
        break;
      }
      if (!c)
        err(2);
      if (sym < 256)
        buf[bt++] = sym;
      else if (sym == 256) {
        lpos = pos, lm = null;
        break;
      } else {
        var add = sym - 254;
        if (sym > 264) {
          var i = sym - 257, b = fleb[i];
          add = bits(dat, pos, (1 << b) - 1) + fl[i];
          pos += b;
        }
        var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
        if (!d)
          err(3);
        pos += d & 15;
        var dt = fd[dsym];
        if (dsym > 3) {
          var b = fdeb[dsym];
          dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
        }
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (resize)
          cbuf(bt + 131072);
        var end = bt + add;
        if (bt < dt) {
          var shift = dl - dt, dend = Math.min(dt, end);
          if (shift + bt < 0)
            err(3);
          for (; bt < dend; ++bt)
            buf[bt] = dict[shift + bt];
        }
        for (; bt < end; ++bt)
          buf[bt] = buf[bt - dt];
      }
    }
    st.l = lm, st.p = lpos, st.b = bt, st.f = final;
    if (lm)
      final = 1, st.m = lbt, st.d = dm, st.n = dbt;
  } while (!final);
  return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
};
var et = /* @__PURE__ */ new u8(0);
var b2 = function(d, b) {
  return d[b] | d[b + 1] << 8;
};
var b4 = function(d, b) {
  return (d[b] | d[b + 1] << 8 | d[b + 2] << 16 | d[b + 3] << 24) >>> 0;
};
var b8 = function(d, b) {
  return b4(d, b) + b4(d, b + 4) * 4294967296;
};
function inflateSync(data, opts) {
  return inflt(data, { i: 2 }, opts && opts.out, opts && opts.dictionary);
}
var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
var tds = 0;
try {
  td.decode(et, { stream: true });
  tds = 1;
} catch (e) {
}
var dutf8 = function(d) {
  for (var r = "", i = 0; ; ) {
    var c = d[i++];
    var eb = (c > 127) + (c > 223) + (c > 239);
    if (i + eb > d.length)
      return { s: r, r: slc(d, i - 1) };
    if (!eb)
      r += String.fromCharCode(c);
    else if (eb == 3) {
      c = ((c & 15) << 18 | (d[i++] & 63) << 12 | (d[i++] & 63) << 6 | d[i++] & 63) - 65536, r += String.fromCharCode(55296 | c >> 10, 56320 | c & 1023);
    } else if (eb & 1)
      r += String.fromCharCode((c & 31) << 6 | d[i++] & 63);
    else
      r += String.fromCharCode((c & 15) << 12 | (d[i++] & 63) << 6 | d[i++] & 63);
  }
};
function strFromU8(dat, latin1) {
  if (latin1) {
    var r = "";
    for (var i = 0; i < dat.length; i += 16384)
      r += String.fromCharCode.apply(null, dat.subarray(i, i + 16384));
    return r;
  } else if (td) {
    return td.decode(dat);
  } else {
    var _a2 = dutf8(dat), s = _a2.s, r = _a2.r;
    if (r.length)
      err(8);
    return s;
  }
}
var slzh = function(d, b) {
  return b + 30 + b2(d, b + 26) + b2(d, b + 28);
};
var zh = function(d, b, z) {
  var fnl = b2(d, b + 28), efl = b2(d, b + 30), fn = strFromU8(d.subarray(b + 46, b + 46 + fnl), !(b2(d, b + 8) & 2048)), es = b + 46 + fnl;
  var _a2 = z64hs(d, es, efl, z, b4(d, b + 20), b4(d, b + 24), b4(d, b + 42)), sc = _a2[0], su = _a2[1], off = _a2[2];
  return [b2(d, b + 10), sc, su, fn, es + efl + b2(d, b + 32), off];
};
var z64hs = function(d, b, l, z, sc, su, off) {
  var nsc = sc == 4294967295, nsu = su == 4294967295, noff = off == 4294967295, e = b + l;
  var nf = nsc + nsu + noff;
  if (z && nf) {
    for (; b + 4 < e; b += 4 + b2(d, b + 2)) {
      if (b2(d, b) == 1) {
        return [
          nsc ? b8(d, b + 4 + 8 * nsu) : sc,
          nsu ? b8(d, b + 4) : su,
          noff ? b8(d, b + 4 + 8 * (nsu + nsc)) : off,
          1
        ];
      }
    }
    if (z < 2)
      err(13);
  }
  return [sc, su, off, 0];
};
function unzipSync(data, opts) {
  var files = {};
  var e = data.length - 22;
  for (; b4(data, e) != 101010256; --e) {
    if (!e || data.length - e > 65558)
      err(13);
  }
  ;
  var c = b2(data, e + 8);
  if (!c)
    return {};
  var o = b4(data, e + 16);
  var z = b4(data, e - 20) == 117853008;
  if (z) {
    var ze = b4(data, e - 12);
    z = b4(data, ze) == 101075792;
    if (z) {
      c = b4(data, ze + 32);
      o = b4(data, ze + 48);
    }
  }
  var fltr = opts && opts.filter;
  for (var i = 0; i < c; ++i) {
    var _a2 = zh(data, o, z), c_2 = _a2[0], sc = _a2[1], su = _a2[2], fn = _a2[3], no = _a2[4], off = _a2[5], b = slzh(data, off);
    o = no;
    if (!fltr || fltr({
      name: fn,
      size: sc,
      originalSize: su,
      compression: c_2
    })) {
      if (!c_2)
        files[fn] = slc(data, b, b + sc);
      else if (c_2 == 8)
        files[fn] = inflateSync(data.subarray(b, b + sc), { out: new u8(su) });
      else
        err(14, "unknown compression type " + c_2);
    }
  }
  return files;
}

// lib/extraSources.mjs
var AGENT2 = { "user-agent": "tarjuman-addon/0.8" };
var SUBDL_HOST = "api.subdl.com";
var SUBDL_DL = "dl.subdl.com";
var JIMAKU_HOST = "jimaku.cc";
var LANG2 = {
  en: "eng",
  fr: "fre",
  es: "spa",
  de: "ger",
  it: "ita",
  pt: "por",
  "pt-br": "pob",
  ptbr: "pob",
  ru: "rus",
  tr: "tur",
  nl: "dut",
  pl: "pol",
  ja: "jpn",
  ko: "kor",
  zh: "chi",
  hi: "hin",
  sv: "swe",
  da: "dan",
  no: "nor",
  nb: "nor",
  fi: "fin",
  el: "gre",
  he: "heb",
  fa: "per",
  id: "ind",
  ar: "ara",
  cs: "cze",
  uk: "ukr",
  vi: "vie",
  th: "tha",
  hu: "hun",
  ro: "rum",
  bg: "bul",
  sr: "srp",
  fra: "fre",
  deu: "ger",
  fra_t: "fre",
  fas: "per",
  ces: "cze",
  ron: "rum",
  ell: "gre"
};
var LANG3 = /* @__PURE__ */ new Set(["eng", "fre", "spa", "ger", "ita", "por", "pob", "rus", "tur", "dut", "pol", "jpn", "kor", "chi", "hin", "swe", "dan", "nor", "fin", "gre", "heb", "per", "ind", "ara", "cze", "ukr", "vie", "tha", "hun", "rum", "bul", "srp"]);
var LANGNAME = {
  english: "eng",
  french: "fre",
  spanish: "spa",
  german: "ger",
  italian: "ita",
  portuguese: "por",
  russian: "rus",
  turkish: "tur",
  dutch: "dut",
  polish: "pol",
  japanese: "jpn",
  korean: "kor",
  chinese: "chi",
  hindi: "hin",
  swedish: "swe",
  danish: "dan",
  norwegian: "nor",
  finnish: "fin",
  greek: "gre",
  hebrew: "heb",
  persian: "per",
  farsi: "per",
  indonesian: "ind",
  arabic: "ara",
  vietnamese: "vie",
  czech: "cze",
  ukrainian: "ukr"
};
var toLang3 = (value) => {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  if (LANG3.has(raw)) return raw;
  const name = LANGNAME[raw.replace(/[\s_-]+$/, "").replace(/[\s_]/g, " ")] || LANGNAME[raw];
  if (name) return name;
  const short = raw.replace(/_/g, "-");
  return LANG2[short] || LANG2[short.split("-")[0]] || (/^[a-z]{3}$/.test(short) ? short : null);
};
var TIMEOUT = 1e4;
var cache = /* @__PURE__ */ new Map();
var CACHE_TTL = 10 * 6e4;
var cached = async (key, make) => {
  const kept = cache.get(key);
  if (kept && Date.now() - kept.at < CACHE_TTL) return kept.value;
  const value = await make();
  if (cache.size > 200) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
  return value;
};
var metaForImdb = async (type, imdb, urls = {}) => cached(`meta:${type}:${imdb}`, async () => {
  const metaBase = (urls.meta || "https://v3-cinemeta.strem.io").replace(/\/+$/, "");
  const body = await getJson2(`${metaBase}/meta/${type}/${imdb}.json`, {});
  const meta = body?.meta || {};
  const name = String(meta.name || "").trim();
  if (!name) return null;
  const year = Number(String(meta.releaseInfo || meta.year || "").match(/\d{4}/)?.[0]) || 0;
  const genres = (meta.genres || meta.genre || []).map((g) => String(g).toLowerCase());
  return { name, year, genres };
});
var anilistByName = async (name, year, urls = {}) => cached(`anilist-search:${name}:${year}`, async () => {
  const media = await searchAnime({ name, year }, urls.anilist || "").catch(() => null);
  return media?.id || null;
});
var getJson2 = async (url, headers) => {
  const response = await fetch(url, { headers: { ...AGENT2, ...headers }, signal: AbortSignal.timeout(TIMEOUT) });
  if (!response.ok) throw new Error(`${response.status} from ${new URL(url).host}`);
  return JSON.parse(await readTextLimited(response));
};
var subdlSearch = async ({ id, type, title, year, episode }, apiKey, urls = {}) => cached(`subdl:${id}:${type}:${episode ?? ""}:${title ? `n:${title}` : "imdb"}:${apiKey.slice(-8)}`, async () => {
  const apiBase = (urls.subdl || `https://${SUBDL_HOST}`).replace(/\/+$/, "");
  const dlBase = (urls.subdlDl || urls.subdl || `https://${SUBDL_DL}`).replace(/\/+$/, "");
  const params = new URLSearchParams({ api_key: apiKey, type: type === "series" ? "tv" : "movie" });
  const plainImdb = /^tt\d{5,10}(?::\d{1,4}:\d{1,4})?$/.test(id) ? String(id).split(":")[0] : null;
  if (title) {
    params.set("film_name", title);
    if (year) params.set("year", String(year));
  } else if (plainImdb) params.set("imdb_id", plainImdb);
  else return [];
  if (episode) params.set("episode_number", String(episode));
  const body = await getJson2(`${apiBase}/api/v1/subtitles?${params}`, {});
  const rows = Array.isArray(body?.subtitles) ? body.subtitles : Array.isArray(body?.results) ? body.results : [];
  const out = [];
  for (const row of rows) {
    const lang = toLang3(row?.lang || row?.language || row?.lang_code);
    let url = String(row?.url || row?.download_url || row?.link || "");
    if (!lang || !url) continue;
    if (url.startsWith("/")) url = `${dlBase}${url}`;
    else if (!/^https:/i.test(url)) continue;
    const dl = new URL(url);
    if (!dl.searchParams.has("api_key")) dl.searchParams.set("api_key", apiKey);
    const release = String(row?.release_name || row?.name || row?.file || "").slice(0, 200);
    out.push({ url: dl.toString(), lang, movieReleaseName: release, subtitleFileName: String(row?.file || row?.name || "") });
  }
  return out;
});
var jimakuSearch = async ({ id, episode, anilistId: knownAnilistId }, apiKey, urls = {}) => cached(`jimaku:${id ?? knownAnilistId}:${episode ?? ""}`, async () => {
  const parsed = id ? parseAnimeId(id) : null;
  const anilistId = knownAnilistId ?? (parsed?.family === "anilist" ? parsed.id : null);
  let target = null;
  if (anilistId) target = anilistId;
  else if (parsed?.family === "mal") {
    const meta = await animeMeta(`mal:${parsed.id}`, urls);
    target = meta?.anilistId || null;
  } else if (parsed?.family === "kitsu") {
    const meta = await animeMeta(`kitsu:${parsed.id}`, urls);
    target = meta?.anilistId || null;
  }
  if (!target) return [];
  const headers = { authorization: apiKey };
  const jimakuBase = (urls.jimaku || `https://${JIMAKU_HOST}`).replace(/\/+$/, "");
  const found = await getJson2(`${jimakuBase}/api/entries/search?anime=true&anilist_id=${target}`, headers);
  const entries = Array.isArray(found) ? found : found?.entries || found?.results || [];
  const entry = entries.find((e) => Number(e?.anilist_id) === target) || entries[0];
  if (!entry?.id) return [];
  const filesUrl = `${jimakuBase}/api/entries/${entry.id}/files${episode ? `?episode=${encodeURIComponent(episode)}` : ""}`;
  const files = await getJson2(filesUrl, headers);
  const list = Array.isArray(files) ? files : files?.files || files?.results || [];
  const out = [];
  for (const file of list) {
    let url = String(file?.url || "");
    if (!url) continue;
    if (url.startsWith("/")) url = `${jimakuBase}${url}`;
    else if (!/^https:/i.test(url)) continue;
    const name = String(file?.name || "").slice(0, 200);
    if (!/\.(srt|vtt|ass|ssa|sub)$/i.test(name) && !/\.(srt|vtt|ass|ssa|sub)(\?|$)/i.test(url)) continue;
    out.push({ url, lang: "eng", movieReleaseName: name, subtitleFileName: name });
  }
  return out;
});
var popcornNotesSearch = async ({ id, type, title, year, episode }, baseUrl, urls = {}) => cached(`pn:${id}:${type}:${episode ?? ""}:${title ? `n:${title}` : "imdb"}`, async () => {
  const apiBase = (baseUrl || urls.popcorn || `https://popcorn-notes.lsoares.workers.dev`).replace(/\/+$/, "");
  const plainImdb = /^tt\d{5,10}(?::\d{1,4}:\d{1,4})?$/.test(id) ? String(id).split(":")[0] : null;
  if (!plainImdb) return [];
  const params = new URLSearchParams({ type: type === "series" ? "tv" : "movie" });
  if (title) {
    params.set("film_name", title);
    if (year) params.set("year", String(year));
  } else params.set("imdb_id", plainImdb);
  if (episode) params.set("episode_number", String(episode));
  const body = await getJson2(`${apiBase}/subtitles/${type}/${plainImdb}.json?${params}`, {});
  const rows = Array.isArray(body?.subtitles) ? body.subtitles : [];
  const out = [];
  for (const row of rows) {
    const lang = toLang3(row?.lang || row?.language || row?.lang_code);
    let url = String(row?.url || "");
    if (!lang || !url) continue;
    if (!/^https:/i.test(url)) continue;
    const release = String(row?.release_name || row?.name || row?.file || "").slice(0, 200);
    out.push({ url, lang, movieReleaseName: release, subtitleFileName: String(row?.file || row?.name || "") });
  }
  return out;
});
var extraSubtitles = async ({ type, id, title, year, episode, empty = false }, cfg, urls = {}) => {
  const sd = String(cfg?.sd || "").trim();
  const jm = String(cfg?.jm || "").trim();
  const pn = String(cfg?.ex || "").trim();
  if (!sd && !jm && !pn) return [];
  const anime = parseAnimeId(id);
  const imdb = parseVideoId(id);
  let resolved = { title, year, episode: episode ?? imdb?.episode ?? null };
  if (anime) {
    const meta = await animeMeta(id, urls).catch(() => null);
    resolved = {
      title: resolved.title ?? meta?.title ?? "",
      year: resolved.year ?? meta?.year ?? 0,
      episode: resolved.episode ?? meta?.episode ?? null
    };
  }
  const jobs = [];
  if (sd) {
    jobs.push((async () => {
      const first = await subdlSearch({ id, type, ...resolved }, sd, urls);
      if (first.length) return first;
      if (!empty) return first;
      const imdbOnly = /^tt\d{5,10}/.exec(id)?.[0];
      const meta = imdbOnly ? await metaForImdb(type, imdbOnly, urls).catch(() => null) : null;
      if (!meta?.name) return first;
      return subdlSearch({ id, type, title: meta.name, year: meta.year, episode: resolved.episode }, sd, urls);
    })());
  }
  if (jm) {
    jobs.push((async () => {
      if (anime) return jimakuSearch({ id, episode: resolved.episode }, jm, urls);
      if (!imdb || type !== "series" || resolved.episode == null || !empty) return [];
      const imdbOnly = /^tt\d{5,10}/.exec(id)?.[0];
      const meta = imdbOnly ? await metaForImdb(type, imdbOnly, urls).catch(() => null) : null;
      if (!meta?.name || !meta.genres.includes("animation")) return [];
      const anilistId = await anilistByName(meta.name, meta.year, urls);
      if (!anilistId) return [];
      return jimakuSearch({ episode: resolved.episode, anilistId }, jm, urls);
    })());
  }
  let popcornBase = pn || `https://popcorn-notes.lsoares.workers.dev`;
  if (!isPopcornUrlAllowed(popcornBase)) popcornBase = `https://popcorn-notes.lsoares.workers.dev`;
  jobs.push((async () => {
    return popcornNotesSearch({ id, type, title: resolved.title, year: resolved.year, episode: resolved.episode }, popcornBase, urls);
  })());
  if (!jobs.length) return [];
  const settled = await Promise.allSettled(jobs);
  return settled.flatMap((result) => result.status === "fulfilled" ? result.value : []);
};
var isPopcornUrlAllowed = (base) => {
  let url;
  try {
    url = new URL(base);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  const host = url.hostname.replace(/^\[|\]$/g, "");
  return !isPrivateHost(host);
};
var SUB_EXT = /\.(srt|vtt|ass|ssa|sub)$/i;
var PICK = [".srt", ".ass", ".ssa", ".vtt", ".sub"];
var unzipSubtitle = (buffer, preferLang3 = "") => {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const entries = unzipSync(bytes, {
    filter: (info) => info.originalSize <= MAX_UNZIPPED_BYTES && info.size <= MAX_ZIP_BYTES
  });
  const inflated = Object.values(entries).reduce((sum, data) => sum + data.byteLength, 0);
  if (inflated > MAX_UNZIPPED_BYTES) throw new Error("حزمة الترجمة أكبر من الحد المسموح");
  const best = Object.entries(entries).filter(([name]) => SUB_EXT.test(name)).sort(([a], [b]) => {
    const extA = PICK.findIndex((ext) => a.toLowerCase().endsWith(ext)), extB = PICK.findIndex((ext) => b.toLowerCase().endsWith(ext));
    const rankA = extA < 0 ? 99 : extA, rankB = extB < 0 ? 99 : extB;
    const langA = preferLang3 && new RegExp(`(^|[^a-z])${preferLang3.slice(0, 2)}([^a-z]|$)`, "i").test(a) ? 0 : 1;
    const langB = preferLang3 && new RegExp(`(^|[^a-z])${preferLang3.slice(0, 2)}([^a-z]|$)`, "i").test(b) ? 0 : 1;
    return langA - langB || rankA - rankB || a.localeCompare(b);
  })[0];
  if (!best) throw new Error("الحزمة ما تحتوي ملف ترجمة مدعوم");
  return new TextDecoder("utf-8").decode(best[1]);
};
var fetchExtraSubtitle = async (url, cfg, settings, urls = {}) => {
  if (!settings.allow.test(url)) throw new Error("subtitle address not allowed");
  const host = new URL(url).hostname;
  const subdlBase = urls.subdlDl || urls.subdl;
  const jimakuBase = urls.jimaku;
  if (subdlBase && url.startsWith(subdlBase.replace(/\/+$/, "")) || host === SUBDL_DL || /(^|\.)subdl\.com$/.test(host)) {
    const response2 = await safeFetch(url, { headers: AGENT2, signal: AbortSignal.timeout(25e3) });
    if (!response2.ok) throw new Error(`${response2.status} from ${host}`);
    const buffer = await readLimited(response2, MAX_ZIP_BYTES);
    const text3 = unzipSubtitle(buffer);
    if (text3.length > 3e6) throw new Error("subtitle file too large");
    return text3;
  }
  if (jimakuBase && url.startsWith(jimakuBase.replace(/\/+$/, "")) || host === JIMAKU_HOST || host.endsWith(`.${JIMAKU_HOST}`)) {
    const headers = String(cfg?.jm || "").trim() ? { authorization: String(cfg.jm).trim() } : {};
    const response2 = await safeFetch(url, { headers: { ...AGENT2, ...headers }, signal: AbortSignal.timeout(2e4) });
    if (!response2.ok) throw new Error(`${response2.status} from ${host}`);
    const text3 = await readTextLimited(response2);
    if (text3.length > 3e6) throw new Error("subtitle file too large");
    return text3;
  }
  const response = await safeFetch(url, { headers: AGENT2, signal: AbortSignal.timeout(2e4) });
  if (!response.ok) throw new Error(`${response.status} from ${host}`);
  const text2 = await readTextLimited(response);
  if (text2.length > 3e6) throw new Error("subtitle file too large");
  return text2;
};

// lib/app.mjs
var VERSION = "0.9.8.3";
var CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, HEAD, POST, OPTIONS" };
var VTT = "text/vtt; charset=utf-8";
var HEADER = "WEBVTT\n\n";
var HAS_ARABIC = /[\u0600-\u06FF]/;
var isArabicText = (text2) => HAS_ARABIC.test(text2);
var isMultiEpisode = (cues) => {
  if (!cues || cues.length < 150) return false;
  const last = cues[cues.length - 1];
  const spanMinutes = (last.end - cues[0].start) / 60;
  return spanMinutes > 50;
};
var respond = (status, headers, body = null) => new Response(body, { status, headers: { ...CORS, ...headers } });
var json = (status, data, headers = {}) => respond(status, { "content-type": "application/json; charset=utf-8", ...headers }, JSON.stringify(data));
var text = (status, message) => respond(status, { "content-type": "text/plain; charset=utf-8" }, message);
var vtt = (body, complete) => respond(200, { "content-type": VTT, "cache-control": complete ? "public, max-age=86400" : "no-store" }, body);
var escapeHtml = (value) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
var originOf = (request, env) => {
  const fixed = env("PUBLIC_URL");
  if (fixed) return fixed.replace(/\/+$/, "");
  const first = (value) => String(value || "").split(",")[0].trim();
  const url = new URL(request.url);
  const trusted = env("TRUST_PROXY") === "1";
  const named = trusted ? first(request.headers.get("x-forwarded-host")) || url.host : url.host;
  const host = /^[\w.:[\]-]+$/.test(named) ? named : url.hostname;
  const localHost = /^(localhost|127\.|\[::1\]|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  const rawScheme = trusted ? first(request.headers.get("x-forwarded-proto")) || (localHost ? "http" : "https") : url.protocol;
  const scheme = rawScheme.replace(/:+$/, "");
  return `${scheme === "http" || scheme === "https" ? scheme : url.protocol.replace(/:+$/, "")}://${host}`;
};
var manifest = (origin, configured, hasLogo) => ({
  id: "community.tarjuman.arabic-ai",
  version: VERSION,
  name: configured ? "Tarjuman AI | ترجمان" : "Tarjuman AI | ترجمان (بلا إعدادات)",
  description: configured ? "ترجمة عربية بالذكاء الاصطناعي: تجلب الترجمة المطابقة لملفك وتترجمها إلى العربية بمفتاحك الخاص." : "هذه النسخة مثبّتة بلا إعدادات فلا تترجم. افتح صفحة الإعدادات، املأها، انسخ الرابط، وثبّته بدل هذه النسخة.",
  ...hasLogo ? { logo: `${origin}/logo.png` } : {},
  resources: ["subtitles"],
  types: ["movie", "series"],
  idPrefixes: ["tt", "kitsu", "mal", "anilist"],
  catalogs: [],
  behaviorHints: { configurable: true, configurationRequired: !configured }
});
var messageTrack = (message) => buildVtt(Array.from({ length: 120 }, (_, i) => ({ start: 0.5 + i * 90, end: 8.5 + i * 90, text: message, rtl: true, top: true })));
var NOTICES = {
  setup: ["⚠️ ترجمان: ناقصها الإعدادات", "⚠️ ترجمان مثبّتة بلا إعدادات، فلا تترجم\nافتح صفحة الإضافة، املأ الإعدادات، انسخ الرابط، وثبّته بدل هذه النسخة"],
  link: ["⚠️ ترجمان: رابط الإضافة غير مقروء", "⚠️ رابط إضافة ترجمان غير مقروء\nافتح صفحة الإعدادات، انسخ الرابط من جديد، وثبّته بدل هذه النسخة"],
  // Every listed subtitle says it is for another episode (the wrong-episode guard, idea 22)
  wrong: ["⚠️ ترجمان: الترجمات المتاحة لحلقة ثانية", "⚠️ ما تُترجم هالمرة: كل ترجمات هذي الحلقة المتاحة الآن تطابق حلقات ثانية.\nترجمان يدوّر تلقائيًا في الحلقات المجاورة عن الملف الصح؛ وإن ما لقاه فلن تُترجم حتى تتوفر ترجمات أخرى."],
  // ما لقي ترجمة عربية صالحة من أي مصدر (بعد التحقق من محتواها فعلاً)
  "no-arabic": ["⚠️ ترجمان: ما لقي ترجمة عربية", "⚠️ ترجمان ما لقي ترجمة عربية صالحة لهذا الفيلم أو الحلقة من أي مصدر.\nلترجم من لغة ثانية، فعّل خيار الترجمة من الإعدادات، أو جرّب مصدر ترجمات آخر."]
};
var ASK_AGAIN = "⏳ ترجمان: اختر هذه الترجمة مرة ثانية لتبدأ الترجمة، ثم انتظر نحو دقيقة";
var askAgainTrack = null;
var askAgain = () => askAgainTrack ??= buildVtt(Array.from({ length: 540 }, (_, i) => ({ start: 0.5 + i * 20, end: 6.5 + i * 20, text: ASK_AGAIN, rtl: true, top: true })));
var noticeList = (origin, kind) => json(200, { subtitles: [{ id: NOTICES[kind][0], lang: "ara", label: NOTICES[kind][0], url: `${origin}/notice/${kind}.vtt` }] }, { "cache-control": "no-cache" });
var ARABIC = /[\u0600-\u06FF]/;
var render = (board) => {
  if (board.state === "done") {
    board.vtt ??= buildVtt([
      ...board.cues.map((cue, i) => ({ start: cue.start, end: cue.end, text: board.out[i], rtl: ARABIC.test(board.out[i]) })),
      ...(board.notes ?? []).map((note) => ({ start: note.start, end: note.end, text: note.text, rtl: true, top: true }))
    ]);
    return { body: board.vtt, complete: true };
  }
  const cues = board.cues.map((cue, i) => board.out[i] === void 0 ? cue : { start: cue.start, end: cue.end, text: board.out[i], rtl: ARABIC.test(board.out[i]) });
  const percent = Math.floor(board.translated / board.cues.length * 100);
  const message = board.state === "failed" ? `⚠️ توقفت الترجمة عند ${percent}%: ${board.error}
أعد اختيار الترجمة من القائمة للمحاولة من جديد` : `⏳ الترجمة العربية قيد التجهيز (${percent}%)
أعد اختيار الترجمة من القائمة بعد قليل لتحميلها كاملة`;
  const firstGap = board.cues.find((_, i) => board.out[i] === void 0)?.start ?? 0;
  const starts = [0.5];
  for (let at = Math.max(firstGap - 1, 100); at < board.cues.at(-1).end; at += 120) starts.push(at);
  for (const start of starts) cues.push({ start, end: start + 8, text: message, rtl: true, top: true });
  return { body: buildVtt(cues), complete: false };
};
var SAMPLE = ["Good evening, Hope. Sorry I'm late, the traffic was terrible.", "- Did you bring the keys?\n- I thought Hunter had them.", "Well, that's just great. Now what do we do, Mr. Stone?"];
var ID = ID_OR_ANIME;
var mergedSubtitles = async ({ type, rawId, rawExtra }, cfg, sources, log) => {
  let base = null;
  try {
    base = await listSubtitles({ type, rawId, rawExtra }, sources);
  } catch (error) {
    log?.(`subtitles source failed: ${error.message}`);
  }
  let id = rawId;
  try {
    id = decodeURIComponent(rawId);
  } catch {
  }
  const empty = !base || base.length === 0;
  const extra = await extraSubtitles({ type, id, empty }, cfg, { kitsu: sources.kitsu || void 0, anilist: sources.anilist || void 0, subdl: sources.subdl || void 0, subdlDl: sources.subdlDl || void 0, jimaku: sources.jimaku || void 0, popcorn: sources.popcorn || void 0, meta: sources.meta || void 0 }).catch(() => []);
  return { base, merged: [...base || [], ...extra] };
};
var fetchAnySubtitle = (url, cfg, sources) => fetchExtraSubtitle(url, cfg, sources, sources);
var createApp = (platform) => {
  const { env, limits, store } = platform;
  const boards = /* @__PURE__ */ new Map();
  const number3 = (name, fallback) => {
    const value = Number(env(name));
    return env(name) !== void 0 && Number.isFinite(value) ? value : fallback;
  };
  const allowLocal = () => env("ALLOW_LOCAL_AI") === "1";
  const fast = () => env("FAST_RETRIES") === "1";
  const llmOf = (cfg) => ({ baseUrl: cfg.b, apiKey: cfg.k, model: cfg.m, effort: cfg.r, concurrency: Math.min(cfg.cc, limits.maxConcurrency) });
  const backupFor = (cfg) => cfg.fb && cfg.fk && cfg.fm ? { baseUrl: cfg.fb, apiKey: cfg.fk, model: cfg.fm, effort: cfg.r, concurrency: 1 } : null;
  let reportQueue = Promise.resolve();
  const reportAdd = (delta) => {
    if (!store.getReport || !store.putReport) return Promise.resolve();
    reportQueue = reportQueue.then(async () => {
      const key = monthKey();
      try {
        await store.putReport(key, mergeReport(await store.getReport(key), delta));
      } catch {
      }
    });
    return reportQueue;
  };
  const countHit = () => reportAdd({ hits: 1 }).catch(() => {
  });
  const html = () => respond(
    200,
    { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
    platform.page.replace("<!--NOTICE-->", env("NOTICE") ? `<p class="notice warn" role="alert">${escapeHtml(env("NOTICE"))}</p>` : "")
  );
  const remember = (key, board) => {
    boards.delete(key);
    boards.set(key, board);
    for (const [old, kept] of boards) {
      if (boards.size <= limits.maxBoards) break;
      if (kept.state !== "running" && kept.state !== "opening") boards.delete(old);
    }
    return board;
  };
  const snapshot = (board) => ({
    from: board.from,
    about: board.about,
    brief: board.brief,
    cues: board.cues.map((cue) => [cue.start, cue.end, cue.text]),
    out: Array.from(board.out, (line) => line ?? null),
    asWritten: [...board.asWritten],
    notes: board.notes ?? [],
    tokens: board.tokens ?? { p: 0, c: 0 }
  });
  const onProgress = async (board, leaving) => {
    const news = board.translated !== board.savedCount || board.brief !== void 0 !== board.savedBrief;
    if (!limits.progressEveryMs || !news) return;
    if (!leaving && Date.now() - board.savedAt < limits.progressEveryMs) return;
    Object.assign(board, { savedAt: Date.now(), savedCount: board.translated, savedBrief: board.brief !== void 0 });
    await store.putProgress(board.key, snapshot(board));
  };
  const onDone = (board) => store.putFinal(board.key, render(board).body).then(() => {
    const tokens = board.tokens ?? { p: 0, c: 0 };
    return reportAdd({ episodes: 1, [board.kind === "movie" ? "film" : "tv"]: 1, lines: board.cues.length, requests: board.requests, tokensP: tokens.p, tokensC: tokens.c, withUsage: tokens.p ? 1 : 0 });
  });
  const dictionaryOf = async (ref, cfg, sources) => {
    if (!cfg.nm || ref?.t !== "series") return null;
    const expected = parseVideoId(ref.i);
    if (!expected) return null;
    const anilistUrl = env("ANILIST_URL") || "";
    const list = await seriesNames(ref, sources, store, anilistUrl);
    if (!list) return null;
    return { list, learn: (learned) => learnSeriesNames(expected.imdb, learned, store) };
  };
  const open = async (key, cfg, ref, sources) => {
    const final = await store.getFinal(key);
    if (final) return { key, state: "done", vtt: final };
    await assertProviderAllowed(cfg.b, { allowLocal: allowLocal(), lookup: platform.lookup });
    if (cfg.fb) await assertProviderAllowed(cfg.fb, { allowLocal: allowLocal(), lookup: platform.lookup });
    const saved = await store.getProgress(key);
    if (saved?.cues?.length) {
      const dict2 = saved.brief === void 0 ? await dictionaryOf(ref, cfg, sources).catch(() => null) : null;
      const board2 = createBoard({
        key,
        from: saved.from,
        about: saved.about,
        batchSize: cfg.bs,
        wantBrief: cfg.nm,
        brief: saved.brief ?? void 0,
        cues: saved.cues.map(([start, end, line]) => ({ start, end, text: line })),
        out: Array.from(saved.out, (line) => line ?? void 0),
        asWritten: Array.isArray(saved.asWritten) ? saved.asWritten : [],
        seriesNames: dict2?.list,
        learnNames: dict2?.learn,
        wantNotes: cfg.nt !== false
      });
      if (saved.tokens && typeof saved.tokens.p === "number") board2.tokens = saved.tokens;
      if (Array.isArray(saved.notes)) board2.notes = saved.notes.filter((note) => note && typeof note.start === "number" && typeof note.text === "string");
      return Object.assign(board2, { savedAt: Date.now(), savedCount: board2.translated, savedBrief: board2.brief !== void 0, kind: ref?.t });
    }
    const guarded = await resolveSubtitle(cfg, ref, sources);
    if (guarded.wrong) return { key, state: "wrong", wanted: guarded.wrong.wanted, found: guarded.wrong.found, at: Date.now() };
    ref = guarded.ref;
    const [raw, about] = await Promise.all([guarded.raw ? Promise.resolve(guarded.raw) : fetchAnySubtitle(ref.u, cfg, sources), describeTitle({ type: ref.t, id: ref.i }, sources)]);
    const cues = tidy(parseSubtitle(raw), { dropSounds: cfg.sdh });
    if (!cues.length) throw new Error("الترجمة الأصلية فارغة أو بصيغة غير مدعومة");
    if (cues.length > 8e3) throw new Error("الترجمة الأصلية أطول من المسموح");
    if (isMultiEpisode(cues)) throw new Error("multi-episode");
    const dict = await dictionaryOf(ref, cfg, sources).catch(() => null);
    const board = Object.assign(createBoard({ key, cues, from: languageName(ref.l), about, batchSize: cfg.bs, wantBrief: cfg.nm, seriesNames: dict?.list, learnNames: dict?.learn, wantNotes: cfg.nt !== false }), { savedAt: 0, savedCount: -1, savedBrief: false, kind: ref.t });
    if (limits.progressEveryMs) await onProgress(board, true).catch(() => {
    });
    return board;
  };
  const keyOf = (cfg, ref) => cacheKey([ref.u, new URL(cfg.b).host, cfg.m, cfg.sdh, cfg.nm, cfg.nt, PROMPT_VERSION]);
  const ready = async (key) => {
    if (boards.get(key)?.state === "done") return true;
    try {
      return store.hasFinal ? await store.hasFinal(key) : Boolean(await store.getFinal(key));
    } catch {
      return false;
    }
  };
  const armed = /* @__PURE__ */ new Map();
  const firstPickedAt = async (key) => {
    const here = armed.get(key);
    if (here) return here;
    const kept = store.getArmed ? Number(await store.getArmed(key).catch(() => 0)) || 0 : 0;
    if (kept) armed.set(key, kept);
    return kept;
  };
  const markFirstPick = async (key, at) => {
    armed.delete(key);
    armed.set(key, at);
    if (armed.size > 500) armed.delete(armed.keys().next().value);
    if (store.putArmed) await store.putArmed(key, at).catch(() => {
    });
  };
  const begun = async (key) => {
    if (boards.has(key)) return true;
    if (await ready(key)) return true;
    try {
      return Boolean((await store.getProgress(key))?.cues?.length);
    } catch {
      return false;
    }
  };
  const asksAgain = async (cfg, key) => {
    if (!cfg.cf || await begun(key)) return false;
    const now = Date.now();
    const first = await firstPickedAt(key);
    if (first && now - first <= number3("CONFIRM_WINDOW_MS", 9e5)) return now - first < number3("CONFIRM_GAP_MS", 3e3);
    await markFirstPick(key, now);
    return true;
  };
  const findRightSubtitle = async (cfg, ref, sources, expected, epName) => {
    let checks = 0;
    for (const delta of [1, -1, 2, -2, 3, -3]) {
      const at = expected.episode + delta;
      if (at < 1) continue;
      const id = `${expected.imdb}:${expected.season}:${at}`;
      let listed;
      try {
        listed = (await mergedSubtitles({ type: "series", rawId: encodeURIComponent(id), rawExtra: "" }, cfg, sources, platform.log)).merged;
      } catch {
        continue;
      }
      const good = rank(listed.filter((sub) => sub.lang === ref.l), "").filter((sub) => byName(`${sub.movieReleaseName || ""} ${sub.subtitleFileName || ""}`, expected, epName) === "same");
      for (const sub of good) {
        if (checks >= 4) return null;
        checks++;
        try {
          const raw = await fetchAnySubtitle(sub.url, cfg, sources);
          if (embeddedVerdict(openingCues(parseSubtitle(raw)), expected) !== "wrong") return { url: sub.url, raw };
        } catch {
        }
      }
    }
    return null;
  };
  const resolveSubtitle = async (cfg, ref, sources) => {
    if (cfg.gd === false) return { ref };
    const expected = parseVideoId(ref.i);
    if (!expected || expected.season == null) return { ref };
    const wanted = `الموسم ${expected.season} الحلقة ${expected.episode}`;
    const epName = await episodeTitle({ type: ref.t, id: ref.i }, sources).catch(() => "");
    const { merged: listed } = await mergedSubtitles({ type: ref.t, rawId: encodeURIComponent(ref.i), rawExtra: "" }, cfg, sources, platform.log).catch(() => ({ merged: [] }));
    const entry = listed.find((sub) => sub.url === ref.u);
    const releaseVerdict = entry ? byName(`${entry.movieReleaseName || ""} ${entry.subtitleFileName || ""}`, expected, epName) : "unknown";
    const markerLabel = (sub) => markersIn(`${sub?.movieReleaseName || ""} ${sub?.subtitleFileName || ""}`)[0];
    if (releaseVerdict === "same") return { ref };
    if (releaseVerdict === "wrong") {
      const right = await findRightSubtitle(cfg, ref, sources, expected, epName);
      if (right) return { ref: { ...ref, u: right.url }, raw: right.raw };
      const marker = markerLabel(entry);
      return { ref, wrong: { wanted, found: marker ? `الموسم ${marker.season} الحلقة ${marker.episode}` : "حلقة أخرى" } };
    }
    const raw = await fetchAnySubtitle(ref.u, cfg, sources);
    if (embeddedVerdict(openingCues(parseSubtitle(raw)), expected) === "wrong") {
      const right = await findRightSubtitle(cfg, ref, sources, expected, epName);
      if (right) return { ref: { ...ref, u: right.url }, raw: right.raw };
      return { ref, wrong: { wanted, found: "سطور داخل الترجمة" } };
    }
    return { ref, raw };
  };
  const ensureBoard = async (cfg, ref, sources) => {
    const key = await keyOf(cfg, ref);
    for (; ; ) {
      const board = boards.get(key);
      if (!board) break;
      if (board.state === "opening") {
        if (Date.now() - board.at > 3e4) break;
        await sleep(200);
        continue;
      }
      if (board.state === "error") {
        if (Date.now() - board.at < 5e3) return board;
        break;
      }
      if (board.state === "failed" && Date.now() - board.finishedAt >= number3("RETRY_COOLDOWN_MS", 1e4)) {
        resumeBoard(board, cfg.bs);
        board.partialAt = 0;
      }
      return remember(key, board);
    }
    remember(key, { key, state: "opening", at: Date.now() });
    try {
      return remember(key, await open(key, cfg, ref, sources));
    } catch (error) {
      let message = error.message;
      if (message === "multi-episode") message = "هذا الملف يحتوي على ترجمات لعدة حلقات في ملف واحد، والتوقيت غير مطابق للحلقة المطلوبة. جرّب ترجمة أخرى أو مصدر ترجمات آخر.";
      return remember(key, { key, state: "error", error: message, at: Date.now() });
    }
  };
  const join = (board, cfg, ctx, waitMs) => {
    const helper = startHelper(board, llmOf(cfg), { budget: limits.budget, stopAt: Date.now() + waitMs + limits.lingerMs, fast: fast(), onProgress, onDone, backup: backupFor(cfg) });
    ctx.waitUntil(helper.finished);
    return helper;
  };
  const handleList = async (request, ctx, cfg, segment, type, rawId, rawExtra) => {
    const nothing = () => json(200, { subtitles: [] }, { "cache-control": "no-cache" });
    let id;
    try {
      id = decodeURIComponent(rawId);
    } catch {
      return nothing();
    }
    if (!["movie", "series"].includes(type) || !ID.test(id)) return nothing();
    const extra = /^[A-Za-z0-9%&=._~!*'()+,;:@$-]*$/.test(rawExtra) ? rawExtra : "";
    const sources = sourceSettings(env);
    const origin = originOf(request, env);
    const { base, merged } = await mergedSubtitles({ type, rawId: encodeURIComponent(id), rawExtra: extra }, cfg, sources, platform.log);
    if (!base && !isAnimeId(id) && !merged.length) return noticeList(origin, "no-arabic");
    const all = merged;
    const filename = new URLSearchParams(extra).get("filename") || "";
    const arabic = all.filter((sub) => sub.lang === "ara");
    const rankedArabic = rank(arabic, filename);
    let pickedArabic = rankedArabic;
    if (cfg.gd !== false) {
      const expected = parseVideoId(id);
      if (expected && expected.season != null) {
        const epName = await episodeTitle({ type, id }, sources).catch(() => "");
        const clean = [];
        const wrong = [];
        for (const sub of rankedArabic) {
          const verdict = byName(`${sub.movieReleaseName || ""} ${sub.subtitleFileName || ""}`, expected, epName);
          if (verdict === "wrong") wrong.push(sub);
          else clean.push(sub);
        }
        if (!clean.length && wrong.length) pickedArabic = [];
        else pickedArabic = clean;
      }
    }
    const verifiedArabic = [];
    const unreachableArabic = [];
    for (const sub of pickedArabic) {
      let usable = false;
      try {
        const text2 = await fetchExtraSubtitle(sub.url, cfg, sources, {
          subdl: sources.subdl,
          subdlDl: sources.subdlDl,
          jimaku: sources.jimaku
        });
        if (!isArabicText(text2)) continue;
        const cues = tidy(parseSubtitle(text2));
        if (isMultiEpisode(cues)) continue;
        usable = true;
      } catch {
        unreachableArabic.push(sub);
        continue;
      }
      if (usable) verifiedArabic.push(sub);
    }
    pickedArabic = verifiedArabic.slice(0, 2);
    if (cfg.ca && pickedArabic.length > 1) {
      const best = await pickBestArabic(cfg, pickedArabic, sources);
      pickedArabic = [pickedArabic[best]];
    }
    const lang = pickLanguage(all, cfg.src, cfg.any);
    const wantAI = !cfg.na || !pickedArabic.length;
    let picked = [];
    if (wantAI && lang) {
      const ranked = rank(all.filter((sub) => sub.lang === lang), filename);
      if (cfg.gd !== false) {
        const expected = parseVideoId(id);
        if (expected && expected.season != null) {
          const epName = await episodeTitle({ type, id }, sources).catch(() => "");
          const clean = [];
          const wrong = [];
          for (const sub of ranked) {
            const verdict = byName(`${sub.movieReleaseName || ""} ${sub.subtitleFileName || ""}`, expected, epName);
            if (verdict === "wrong") wrong.push(sub);
            else clean.push(sub);
          }
          if (!clean.length && wrong.length) return noticeList(origin, "wrong");
          picked = clean;
        } else {
          picked = ranked;
        }
      } else {
        picked = ranked;
      }
      picked = picked.slice(0, Math.max(0, cfg.n - pickedArabic.length));
    }
    if (pickedArabic.length === 0 && unreachableArabic.length) {
      pickedArabic = unreachableArabic.slice(0, 2);
    }
    const allPicked = [...pickedArabic, ...picked];
    if (!allPicked.length) return noticeList(origin, "no-arabic");
    const refs = allPicked.map((sub) => ({ u: sub.url, l: sub.lang === "ara" ? "ara" : lang, t: type, i: id }));
    const finished = await Promise.all(refs.map(async (ref) => ref.l === "ara" ? true : ready(await keyOf(cfg, ref))));
    const used = /* @__PURE__ */ new Set();
    const subtitles = allPicked.map((sub, i) => {
      const release = String(sub.movieReleaseName || sub.subtitleFileName || "").replace(/\.(srt|vtt|ass|ssa|sub)$/i, "").trim().slice(0, 60);
      const isReady = sub.lang === "ara";
      const mark = finished[i] ? "✓" : "⏳";
      const readyLabel = cfg.ca && isReady ? "عربي جاهز · اختارته AI" : "عربي جاهز";
      let name = `${isReady ? readyLabel : "AI"} ${mark} · ${release || (isReady ? "arabic" : lang)}`;
      for (let copy = 2; used.has(name); copy++) name = `${isReady ? readyLabel : "AI"} ${mark} · ${release || (isReady ? "arabic" : lang)} #${copy}`;
      used.add(name);
      const route = isReady ? "r" : "t";
      return { id: name, lang: "ara", label: name, url: `${origin}/${segment}/${route}/${encodeText(JSON.stringify(refs[i]))}.vtt` };
    });
    if (cfg.warm && refs[0] && refs[0].l !== "ara" && request.method !== "HEAD") {
      ctx.waitUntil((async () => {
        const board = await ensureBoard(cfg, refs[0], sources);
        if (board.state === "running") await join(board, cfg, ctx, 0).finished;
        if (cfg.pn && type === "series") {
          const expected = parseVideoId(id);
          if (expected?.season != null && expected?.episode != null) {
            const nextId = `${expected.imdb}:${expected.season}:${expected.episode + 1}`;
            const nextList = await listSubtitles({ type: "series", rawId: encodeURIComponent(nextId), rawExtra: "" }, sources).catch(() => []);
            const nextLang = pickLanguage(nextList, cfg.src, cfg.any);
            const nextPicked = nextLang ? rank(nextList.filter((sub) => sub.lang === nextLang), filename) : [];
            if (nextPicked.length) {
              const nextCfg = cfg, nextRef = { u: nextPicked[0].url, l: nextLang, t: "series", i: nextId };
              const nextKey = keyOf(nextCfg, nextRef);
              if (!await ready(nextKey)) {
                const next = await ensureBoard(nextCfg, nextRef, sources);
                if (next.state === "running") await join(next, nextCfg, ctx, 0).finished;
              }
            }
          }
        }
      })().catch((error) => platform.log?.(`could not start translating: ${error.message}`)));
    }
    return json(200, { subtitles }, { "cache-control": "no-cache" });
  };
  const hold = (board, helper, ctx, waitMs) => {
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const write = (part) => writer.write(encoder.encode(part));
    ctx.waitUntil((async () => {
      try {
        await write(HEADER);
        const deadline = Date.now() + waitMs;
        const quietMs = number3("TRICKLE_MS", 5e3);
        let quietSince = Date.now();
        while (board.state === "running" && Date.now() < deadline && alive(board)) {
          await sleep(Math.min(400, quietMs));
          if (Date.now() - quietSince >= quietMs) {
            await write("\n");
            quietSince = Date.now();
          }
        }
        const { body, complete } = render(board);
        if (!complete) board.partialAt = Date.now();
        await write(body.slice(HEADER.length));
        await writer.close();
      } catch {
        if (Number.isFinite(limits.lingerMs)) helper.stopAt = Math.min(helper.stopAt, Date.now() + 12e3);
        await writer.abort().catch(() => {
        });
      }
    })());
    return respond(200, { "content-type": VTT, "cache-control": "no-store, no-transform" }, readable);
  };
  const pickBestArabic = async (cfg, subs, sources) => {
    if (subs.length <= 1) return 0;
    await assertProviderAllowed(cfg.b, { allowLocal: allowLocal(), lookup: platform.lookup });
    const texts = await Promise.all(subs.map(async (sub, idx) => {
      try {
        const text2 = await fetchExtraSubtitle(sub.url, cfg, sources, {
          subdl: sources.subdl,
          subdlDl: sources.subdlDl,
          jimaku: sources.jimaku
        });
        return `الترجمة ${idx + 1}:
${text2.slice(0, 6e3)}
`;
      } catch {
        return `الترجمة ${idx + 1}: (لا يمكن قراءتها)`;
      }
    }));
    const prompt = texts.join("\n---\n");
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15e3);
      const response = await safeFetch(`${cfg.b}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "authorization": `Bearer ${cfg.k}`
        },
        body: JSON.stringify({
          model: cfg.m,
          messages: [
            { role: "system", content: "أنت تقارن بين ترجمات عربية جاهزة لفيلم أو حلقة. اختر أفضل ترجمة من حيث الدقة، وسلاسة اللغة، والتوقيت، واكتمال الحوار. رجع رقم الترجمة الأفضل فقط (مثلاً: 1 أو 2 أو 3)." },
            { role: "user", content: prompt }
          ],
          max_tokens: 10,
          temperature: 0
        }),
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (!response.ok) throw new Error(`رد المزوّد بحالة ${response.status}`);
      const result = await response.json();
      const choice = parseInt(String(result.choices?.[0]?.message?.content || "").trim(), 10);
      if (choice >= 1 && choice <= subs.length) return choice - 1;
    } catch {
    }
    return 0;
  };
  const handleReady = async (request, ctx, cfg, link) => {
    let ref;
    try {
      ref = JSON.parse(decodeText(link));
    } catch {
    }
    const sources = sourceSettings(env);
    const valid = ref && typeof ref.u === "string" && sources.allow.test(ref.u) && ["movie", "series"].includes(ref.t) && ID.test(ref.i || "") && ref.l === "ara";
    if (!valid) return text2(400, "bad subtitle link");
    const text2 = await fetchExtraSubtitle(ref.u, cfg, sources, {
      subdl: sources.subdl,
      subdlDl: sources.subdlDl,
      jimaku: sources.jimaku
    });
    const cues = parseSubtitle(text2);
    if (isMultiEpisode(cues)) {
      return respond(
        200,
        { "content-type": VTT, "cache-control": "no-store, no-transform" },
        buildVtt([{ start: 0, end: 10, text: "⚠️ هذا الملف يحتوي على ترجمات لعدة حلقات في ملف واحد، والتوقيت غير مطابق للحلقة المطلوبة. جرّب ترجمة أخرى أو مصدر ترجمات آخر.", rtl: true, top: true }])
      );
    }
    const vtt2 = buildVtt(cues);
    return respond(200, { "content-type": VTT, "cache-control": "no-store, no-transform" }, vtt2);
  };
  const handleTrack = async (request, ctx, cfg, link) => {
    let ref;
    try {
      ref = JSON.parse(decodeText(link));
    } catch {
    }
    const sources = sourceSettings(env);
    const valid = ref && typeof ref.u === "string" && sources.allow.test(ref.u) && ["movie", "series"].includes(ref.t) && ID.test(ref.i || "") && /^[a-z]{3}$/.test(ref.l || "");
    if (!valid) return text(400, "bad subtitle link");
    if (request.method === "HEAD") return vtt(null, false);
    if (await asksAgain(cfg, await keyOf(cfg, ref))) return vtt(askAgain(), false);
    const board = await ensureBoard(cfg, ref, sources);
    if (board.state === "wrong") {
      platform.log?.(`refused to translate the wrong episode: ${board.wanted} vs ${board.found}`);
      const found = board.found || "حلقة ثانية";
      const message = `⚠️ هالترجمة تطابق ${found}
الحلقة المطلوبة: ${board.wanted}
ترجمان يدوّر في الحلقات المجاورة عن الملف الصح؛ ما تنترجم قبل ما يلقاه.`;
      return vtt(messageTrack(message), false);
    }
    if (board.state === "error") {
      platform.log?.(`could not prepare the translation: ${board.error}`);
      return vtt(messageTrack(`⚠️ تعذّر تجهيز الترجمة: ${board.error}`), false);
    }
    if (board.state === "done") {
      const saved = countHit();
      ctx?.waitUntil?.(saved);
      return vtt(render(board).body, true);
    }
    const justWaited = board.partialAt && Date.now() - board.partialAt < number3("REPICK_MS", 8e3);
    const waitMs = justWaited ? 0 : cfg.wait * 1e3;
    const helper = join(board, cfg, ctx, waitMs);
    if (board.state === "running" && waitMs > 0) return hold(board, helper, ctx, waitMs);
    const { body, complete } = render(board);
    return vtt(body, complete);
  };
  const handleTest = async (request) => {
    let cfg;
    try {
      const body = await request.text();
      if (body.length > 8e3) throw new ConfigError("الطلب أكبر من المتوقع");
      cfg = normalize(JSON.parse(body));
      await assertProviderAllowed(cfg.b, { allowLocal: allowLocal(), lookup: platform.lookup });
    } catch (error) {
      return json(200, { ok: false, error: error instanceof ConfigError ? error.message : "الإعدادات غير مقروءة" });
    }
    const started = Date.now();
    const cues = SAMPLE.map((line, i) => ({ start: i * 3, end: i * 3 + 2, text: line }));
    const board = createBoard({ key: "test", cues, from: "English", about: "a short test", batchSize: 10 });
    const helper = startHelper(board, { ...llmOf(cfg), concurrency: 1 }, { budget: 8, fast: fast() });
    await Promise.race([helper.finished, sleep(number3("TEST_TIMEOUT_MS", 75e3))]);
    if (board.state !== "done") {
      const reason = board.error || board.lastError || "لم يرد النموذج في الوقت المحدد";
      if (board.state === "running") Object.assign(board, { state: "failed", error: reason });
      return json(200, { ok: false, error: reason });
    }
    return json(200, { ok: true, seconds: +((Date.now() - started) / 1e3).toFixed(1), lines: cues.map((cue, i) => ({ from: cue.text, to: board.out[i] })) });
  };
  const handleReport = async () => {
    if (!store.getReport) return text(404, "التقرير يحتاج مخزن الترجمات مفعّلًا");
    let data = null;
    try {
      data = await store.getReport(monthKey());
    } catch {
    }
    const label = new Intl.DateTimeFormat("ar", { month: "long", year: "numeric" }).format(/* @__PURE__ */ new Date());
    return respond(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }, reportHtml(data, label));
  };
  const handleStatus = async () => {
    const [stored, source] = await Promise.all([store.probe().catch(() => false), probeSource(sourceSettings(env))]);
    return json(200, { ok: true, version: VERSION, runtime: platform.runtime, storage: stored ? store.kind : "none", source }, { "cache-control": "no-store" });
  };
  return async (request, ctx) => {
    const { pathname } = new URL(request.url);
    const { method } = request;
    if (method === "OPTIONS") return respond(204, {});
    if (pathname === "/api/test" && method === "POST") return handleTest(request);
    if (method !== "GET" && method !== "HEAD") return text(405, "method not allowed");
    if (pathname === "/" || pathname === "/configure") return html();
    if (pathname === "/manifest.json") return json(200, manifest(originOf(request, env), false, platform.hasLogo));
    if (pathname === "/health") return json(200, { ok: true, version: VERSION });
    if (pathname === "/api/status") return handleStatus();
    if (pathname === "/logo.png" && platform.hasLogo) return respond(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" }, platform.logo());
    const [, segment, ...rest] = pathname.split("/");
    if (rest.length === 1 && rest[0] === "configure") return html();
    if (segment === "subtitles" && (rest.length === 2 || rest.length === 3) && rest.at(-1).endsWith(".json")) return noticeList(originOf(request, env), "setup");
    if (segment === "notice" && rest.length === 1 && rest[0].endsWith(".vtt") && Object.hasOwn(NOTICES, rest[0].slice(0, -4))) return vtt(messageTrack(NOTICES[rest[0].slice(0, -4)][1]), false);
    const isManifest = rest.length === 1 && rest[0] === "manifest.json";
    const isList = rest[0] === "subtitles" && (rest.length === 3 || rest.length === 4) && rest.at(-1).endsWith(".json");
    const isTrack = rest[0] === "t" && rest.length === 2 && rest[1].endsWith(".vtt");
    const isReady = rest[0] === "r" && rest.length === 2 && rest[1].endsWith(".vtt");
    const isReport = rest.length === 1 && rest[0] === "report";
    if (!isManifest && !isList && !isTrack && !isReady && !isReport) return text(404, "not found");
    let cfg;
    try {
      cfg = decodeConfig(segment);
    } catch (error) {
      const message = error instanceof ConfigError ? error.message : "الإعدادات غير مقروءة";
      if (isTrack) return vtt(messageTrack(`⚠️ ${message}. افتح صفحة إعدادات الإضافة وثبّتها من جديد`), false);
      return isList ? noticeList(originOf(request, env), "link") : json(400, { error: message });
    }
    if (isManifest) return json(200, manifest(originOf(request, env), true, platform.hasLogo));
    if (isReport) return handleReport();
    if (isReady) return handleReady(request, ctx, cfg, rest[1].slice(0, -4));
    if (isTrack) return handleTrack(request, ctx, cfg, rest[1].slice(0, -4));
    const last = rest.at(-1).slice(0, -5);
    return handleList(request, ctx, cfg, segment, rest[1], rest.length === 3 ? last : rest[2], rest.length === 4 ? last : "");
  };
};

// public/configure.html
var configure_default = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ترجمان · ترجمة عربية بالذكاء الاصطناعي في Stremio</title>
<meta name="description" content="إضافة Stremio تترجم ترجمة الفيلم أو الحلقة إلى العربية بالذكاء الاصطناعي، بمفتاحك الخاص.">
<link rel="icon" href="/logo.png">
<style>
  :root {
    --bg: #12101c; --card: #1c192b; --line: #2e2a44; --field: #141221;
    --text: #efecf8; --muted: #a8a3bf; --accent: #9b7bff; --accent-2: #4fd1e8; --good: #5fd3a2; --bad: #ff8a8a;
    --radius: 16px;
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0; background: radial-gradient(1200px 600px at 85% -10%, #2a1f55 0%, transparent 60%), var(--bg);
    color: var(--text); font: 16px/1.7 system-ui, "Segoe UI", Tahoma, "Noto Sans Arabic", "Geeza Pro", sans-serif;
  }
  main { max-width: 720px; margin: 0 auto; padding: 28px 16px 56px; }
  header { display: flex; align-items: center; gap: 16px; margin-bottom: 22px; }
  header svg { flex: none; width: 64px; height: 64px; border-radius: 18px; box-shadow: 0 10px 30px #0006; }
  h1 { margin: 0; font-size: 30px; line-height: 1.25; letter-spacing: 0; }
  header p { margin: 2px 0 0; color: var(--muted); }
  h2 { margin: 0 0 14px; font-size: 19px; display: flex; align-items: center; gap: 10px; }
  h2 .step { flex: none; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: linear-gradient(135deg, var(--accent), var(--accent-2)); color: #12101c; font-size: 15px; font-weight: 700; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 20px; margin-bottom: 16px; }
  .how { display: grid; gap: 12px; grid-template-columns: repeat(3, 1fr); padding: 0; background: none; border: 0; }
  .how div { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 14px 16px; }
  .how b { display: block; margin-bottom: 2px; }
  .how span, .hint, small { color: var(--muted); font-size: 14px; }
  .notice { border-inline-start: 3px solid var(--accent-2); background: #16263a; border-radius: 10px; padding: 12px 14px; margin: 0 0 16px; font-size: 15px; }
  .notice.warn { border-inline-start-color: #ffb84d; background: #3a2a12; }
  .status { list-style: none; margin: 0 0 14px; padding: 10px 14px; display: grid; gap: 4px; border-radius: 12px; background: var(--field); border: 1px solid var(--line); font-size: 14.5px; }
  .status .bad { color: #ffcf8a; }
  .providers { display: grid; gap: 10px; grid-template-columns: repeat(4, 1fr); margin-bottom: 16px; }
  .providers label { position: relative; display: block; cursor: pointer; border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; background: var(--field); transition: border-color .15s, background .15s; }
  .providers input { position: absolute; opacity: 0; inset: 0; cursor: pointer; }
  .providers b { display: block; font-size: 15px; }
  .providers small { display: block; line-height: 1.4; font-size: 12.5px; }
  .providers label:has(input:checked) { border-color: var(--accent); background: #241d44; box-shadow: inset 0 0 0 1px var(--accent); }
  .providers label:has(input:focus-visible) { outline: 2px solid var(--accent-2); outline-offset: 2px; }
  .field { margin-bottom: 14px; }
  .field > label, .field > .label { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; margin-bottom: 6px; font-weight: 600; font-size: 15px; }
  .field a { font-weight: 400; font-size: 14px; }
  a { color: var(--accent-2); }
  input[type=text], input[type=password], input[type=number], select {
    width: 100%; padding: 11px 12px; border-radius: 10px; border: 1px solid var(--line); background: var(--field); color: var(--text); font: inherit;
  }
  input[dir=ltr] { text-align: left; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 14.5px; }
  input::placeholder { color: #7d7896; font-family: system-ui, "Segoe UI", Tahoma, "Noto Sans Arabic", "Geeza Pro", sans-serif; font-size: 15px; }
  #key::placeholder { direction: rtl; text-align: right; }
  input:focus-visible, select:focus-visible, button:focus-visible, a.button:focus-visible, summary:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }
  .key { display: flex; gap: 8px; }
  .key button { flex: none; }
  .check { display: flex; gap: 10px; align-items: flex-start; padding: 8px 0; cursor: pointer; }
  .check input { flex: none; width: 20px; height: 20px; margin: 4px 0 0; accent-color: var(--accent); }
  .check small { display: block; }
  details { margin-top: 8px; border-top: 1px solid var(--line); padding-top: 12px; }
  summary { cursor: pointer; color: var(--muted); font-size: 15px; }
  .grid { display: grid; gap: 12px 14px; grid-template-columns: 1fr 1fr; margin-top: 14px; }
  .grid .field { margin: 0; }
  button, a.button {
    display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 46px; padding: 0 18px; border-radius: 12px;
    border: 1px solid var(--line); background: var(--field); color: var(--text); font: inherit; font-weight: 600; text-decoration: none; cursor: pointer;
  }
  button:hover, a.button:hover { border-color: var(--accent); }
  button.primary, a.button.primary { border: 0; color: #12101c; background: linear-gradient(135deg, var(--accent), var(--accent-2)); }
  button.primary:hover, a.button.primary:hover { filter: brightness(1.08); }
  [aria-disabled=true], button:disabled { opacity: .45; pointer-events: none; }
  .actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 14px; }
  .actions .primary { flex: 1 1 220px; }
  .result { margin-top: 14px; border-radius: 12px; padding: 12px 14px; background: var(--field); border: 1px solid var(--line); font-size: 15px; }
  .result.good { border-color: #2f6f58; }
  .result.bad { border-color: #7d3b3b; color: var(--bad); }
  .result ol { margin: 8px 0 0; padding: 0; list-style: none; display: grid; gap: 10px; }
  .result li span { display: block; }
  .result .from { color: var(--muted); font-size: 13.5px; direction: ltr; text-align: left; white-space: pre-line; }
  .result .to { white-space: pre-line; }
  .link { margin-top: 12px; }
  .link input { font-size: 12.5px; color: var(--muted); }
  .spin { width: 16px; height: 16px; border-radius: 50%; border: 2px solid #fff5; border-top-color: #fff; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  footer { color: var(--muted); font-size: 14px; padding: 4px 4px 0; }
  footer p { margin: 0 0 6px; }
  [hidden] { display: none !important; }
  @media (max-width: 600px) {
    main { padding: 20px 12px 44px; }
    h1 { font-size: 26px; }
    .how { grid-template-columns: 1fr; }
    .providers { grid-template-columns: 1fr 1fr; }
    .grid { grid-template-columns: 1fr; }
    section { padding: 16px; }
    .actions > * { flex: 1 1 100%; }
  }
  @media (prefers-reduced-motion: reduce) { .spin { animation-duration: 2s; } }
</style>
</head>
<body>
<main>
  <header>
    <svg viewBox="0 0 64 64" role="img" aria-label="شعار ترجمان">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#9b7bff"/><stop offset="1" stop-color="#4fd1e8"/></linearGradient></defs>
      <rect width="64" height="64" rx="16" fill="url(#g)"/>
      <path d="M14 17h36a5 5 0 0 1 5 5v19a5 5 0 0 1-5 5H31l-10 8v-8h-7a5 5 0 0 1-5-5V22a5 5 0 0 1 5-5z" fill="#fff"/>
      <text x="32" y="40" text-anchor="middle" font-size="24" font-weight="700" fill="#2a1f55" font-family="system-ui, Tahoma, 'Noto Sans Arabic', sans-serif">ع</text>
    </svg>
    <div>
      <h1>ترجمان</h1>
      <p>ترجمة عربية بالذكاء الاصطناعي داخل Stremio</p>
    </div>
  </header>

  <!--NOTICE-->

  <div class="how">
    <div><b>تفتح فيلمًا أو حلقة</b><span>الإضافة تجلب الترجمة الأصلية المطابقة لملفك.</span></div>
    <div><b>تختار «العربية»</b><span>النموذج يترجمها بمفتاحك الخاص.</span></div>
    <div><b>تُحفظ الترجمة</b><span>المشاهدة التالية فورية وبلا تكلفة.</span></div>
  </div>

  <p class="notice" style="margin-top:16px">Stremio لا يسلّم الإضافات ملف الفيديو، فلا يمكن قراءة الترجمة المدمجة بداخله. البديل هنا هو الترجمة نفسها من OpenSubtitles، مطابقةً لملفك قدر الإمكان.</p>

  <section>
    <h2><span class="step">1</span>مزوّد الذكاء الاصطناعي</h2>
    <div class="providers" role="radiogroup" aria-label="المزوّد">
      <label><input type="radio" name="provider" value="gemini" checked><b>Gemini</b><small>مجاني ضمن حدود Google</small></label>
      <label><input type="radio" name="provider" value="openrouter"><b>OpenRouter</b><small>نماذج كثيرة بمفتاح واحد</small></label>
      <label><input type="radio" name="provider" value="openai"><b>OpenAI</b><small>مدفوع</small></label>
      <label><input type="radio" name="provider" value="custom"><b>مخصّص</b><small>أي خدمة بصيغة OpenAI</small></label>
    </div>

    <div class="field" id="base-row" hidden>
      <label for="base">رابط الخدمة</label>
      <input id="base" type="text" dir="ltr" inputmode="url" autocomplete="off" spellcheck="false" placeholder="https://example.com/v1">
    </div>
    <div class="field">
      <label for="key">مفتاح API <a id="key-link" target="_blank" rel="noopener">احصل على مفتاح ↗</a></label>
      <div class="key">
        <input id="key" type="password" dir="ltr" autocomplete="off" spellcheck="false" placeholder="ألصق المفتاح هنا">
        <button type="button" id="reveal" aria-pressed="false">إظهار</button>
      </div>
    </div>
    <div class="field" style="margin-bottom:0">
      <label for="model">النموذج</label>
      <input id="model" type="text" dir="ltr" autocomplete="off" spellcheck="false">
      <small id="model-hint"></small>
    </div>
    <p class="hint" style="margin:12px 0 0">إعداداتك تُحفظ في هذا المتصفح فقط، لتجدها كما تركتها حين تعود. <a href="#" id="forget">مسح المحفوظ</a></p>
  </section>

  <section>
    <h2><span class="step">2</span>الخيارات</h2>
    <div class="field">
      <label for="src">لغة الترجمة الأصلية</label>
      <select id="src">
        <option value="eng">الإنجليزية</option><option value="fre">الفرنسية</option><option value="spa">الإسبانية</option>
        <option value="ger">الألمانية</option><option value="ita">الإيطالية</option><option value="por">البرتغالية</option>
        <option value="tur">التركية</option><option value="rus">الروسية</option><option value="jpn">اليابانية</option><option value="kor">الكورية</option>
      </select>
    </div>
    <label class="check"><input type="checkbox" id="any" checked><span>إن لم توجد، ترجم من أي لغة متاحة</span></label>
    <label class="check"><input type="checkbox" id="warm" checked><span>ابدأ الترجمة فور جلب قائمة الترجمات<small>تجهز أسرع، وتستهلك من مفتاحك مع كل فيديو تُجلب ترجماته.</small></span></label>
    <label class="check"><input type="checkbox" id="pn" checked><span>ترجم الحلقة الجاية وأنت تشوف<small>للمسلسلات فقط: تبدأ بعد انتهاء الحالية، وتستمر في الخلفية بتوكنزك كما لو اخترتها. أوقفها تُوفّر، أو موجودة بالكامل إن كنت تتابع حلقات ظهرًا.</small></span></label>
    <label class="check"><input type="checkbox" id="cf" checked><span>لا تبدأ الترجمة إلا بعد اختيارها مرتين<small>المشغّل ينزّل الترجمات من نفسه أحيانًا. بهذا الخيار، أول اختيار يُظهر سطرًا يطلب اختيارها مرة ثانية، والترجمة تبدأ عند الثانية، فلا يُصرف من رصيدك شيء لم تطلبه.</small></span></label>
    <label class="check"><input type="checkbox" id="nm" checked><span>اقرأ الترجمة كاملة أولاً لمعرفة الأسماء والمصطلحات<small>الأسماء تُكتب بنطقها ولا تُترجم («Hope» تبقى «هوب» لا «أمل»)، وبالرسم نفسه من أول الفيلم لآخره. طلب إضافي واحد لكل فيديو.</small></span></label>
    <label class="check"><input type="checkbox" id="nt" checked><span>ملاحظات المترجم<small>شرح قصير فوق الشاشة لنكتة أو مصطلح ياباني ما يتترجم، مثل ترجمات الفانز — بحد أقصى ثلاث ملاحظات للحلقة. طلب إضافي واحد لكل فيديو.</small></span></label>
    <label class="check"><input type="checkbox" id="sdh" checked><span>احذف وصف الأصوات مثل [موسيقى] و(تنهّد)</span></label>
    <label class="check"><input type="checkbox" id="gd" checked><span>حارس الحلقة الغلط<small>إن كانت مطابقة الترجمة (باسم ملفها أو بأسطرها الأولى) لحلقة ثانية، لا تترجمها. ترجمان يدوّر في الحلقات المجاورة عن الملف الصح.</small></span></label>
    <label class="check"><input type="checkbox" id="na"><span>لا تترجم إن وُجد عربي جاهز<small>إن وُجد ترجمة عربية من أي مصدر (أوبن سوبتايتلز، ساب دي إل، جيماكو)، تُعرض وحدها وتُكتفى بها. لا يُعرض خيار الترجمة الآلية.</small></span></label>
    <label class="check"><input type="checkbox" id="ca"><span>دع الذكاء يقارن بين الترجمات الجاهزة<small>إذا وُجد أكثر من ترجمة عربية جاهزة، يقرؤها الذكاء الاصطناعي ويختار أفضل واحدة ويعرضها أولًا. يصرف توكنز قليلة من مفتاحك لكل فيديو.</small></span></label>

    <details>
      <summary>إعدادات متقدمة</summary>
      <div class="grid">
        <div class="field"><label for="n">عدد الترجمات المعروضة</label><input id="n" type="number" min="1" max="3" value="2"></div>
        <div class="field"><label for="wait">أقصى انتظار للترجمة الكاملة قبل عرض جزء منها (ثوانٍ)</label><input id="wait" type="number" min="0" max="120" value="50"></div>
        <div class="field"><label for="bs">عدد الأسطر في الطلب الواحد</label><input id="bs" type="number" min="5" max="200" value="80"></div>
        <div class="field"><label for="cc">عدد الطلبات في الوقت نفسه</label><input id="cc" type="number" min="1" max="8" value="4"></div>
        <div class="field"><label for="effort">مجهود التفكير (للنماذج التي تدعمه)</label>
          <select id="effort"><option value="">الافتراضي</option><option value="minimal">الأدنى</option><option value="low">منخفض</option><option value="medium">متوسط</option></select>
        </div>
      </div>
      <div class="grid">
        <p class="hint" style="margin:0; grid-column:1/-1"><b>مزوّد احتياطي (اختياري)</b> — لو رفضت الخدمة الأساسية أو تأخرت، يُكمل ترجمان من هذي الخدمة بدون ما تسوي شي. يُستخدم مرة واحدة في الحلقة فقط، ولا تطلبها إن كانت فارغة.</p>
        <div class="field"><label for="fb">رابط الخدمة الاحتياطية</label><input id="fb" type="url" dir="ltr" placeholder="https://openrouter.ai/api/v1"></div>
        <div class="field"><label for="fk">مفتاحها</label><input id="fk" type="password" dir="ltr" autocomplete="off"></div>
        <div class="field"><label for="fm">النموذج</label><input id="fm" type="text" dir="ltr" placeholder="google/gemini-3.5-flash-lite"></div>
      </div>
    </details>
  </section>

  <section>
    <h2>مصادر ترجمة إضافية (اختياري)</h2>
    <p class="hint" style="margin:0 0 10px">إلى جانب المصدر الحالي (OpenSubtitles)، يقدر ترجمان يدوّر في <b>SubDL</b> (قاعدة ضخمة بما فيها الفانساب) و<b>Jimaku</b> (أفضل متخصص للترجمة اليابانية للأنمي). مفاتيح مجانية وتدخّلها أنت — بدونها تُتخطى هذي المصادر صامتًا ويظل كل شي يشتغل عادي. الروابط الفوقانية تمر داخل رابط الإضافة مثلك كل مفاتيحك.</p>
    <div class="grid">
      <div class="field"><label for="sd">مفتاح SubDL <small>(مجاني: <a href="https://subdl.com/account" target="_blank" rel="noopener">subdl.com/account</a>)</small></label><input id="sd" type="password" dir="ltr" autocomplete="off" placeholder="ألصق المفتاح هنا"></div>
      <div class="field"><label for="jm">مفتاح Jimaku <small>(مجاني: <a href="https://jimaku.cc/account" target="_blank" rel="noopener">jimaku.cc/account</a>)</small></label><input id="jm" type="password" dir="ltr" autocomplete="off" placeholder="ألصق المفتاح هنا"></div>
      <div class="field"><label for="ex">رابط أوكستندد/بوب كورن نوتس <small>(مفتاح غير مطلوب، افتراضيًا الرابط الرسمي)</small></label><input id="ex" type="url" dir="ltr" placeholder="https://popcorn-notes.lsoares.workers.dev"></div>
    </div>
    <p class="hint" style="margin:10px 0 0">الأنمي: ترجمان صار يفهم معرّفات كتالوجات الأنمي (Kitsu وMyAnimeList وAniList) إلى جانب tt<imdb>، فأي أنمي تنزله من أي كتالوج تطلع له ترجمات بعد.</p>
  </section>

  <section>
    <h2><span class="step">3</span>جرّب ثم ثبّت</h2>
    <ul class="status" id="status" aria-live="polite" hidden></ul>
    <p class="hint" id="problem" role="status"></p>
    <div class="actions">
      <button type="button" id="test">جرّب الإعدادات</button>
    </div>
    <div class="result" id="result" aria-live="polite" hidden></div>
    <div class="link">
      <div class="field" style="margin-bottom:8px">
        <label for="link">رابط الإضافة</label>
        <input id="link" type="text" dir="ltr" readonly>
      </div>
      <div class="actions" style="margin-top:0">
        <button type="button" class="primary" id="copy">نسخ الرابط</button>
        <a class="button" id="install">تثبيت في Stremio</a>
        <a class="button" id="web" target="_blank" rel="noopener">Stremio Web ↗</a>
        <a class="button" id="report" target="_blank" rel="noopener">تقرير هذا الشهر</a>
      </div>
      <p class="hint" style="margin:12px 0 0"><b>في Nuvio:</b> انسخ الرابط، ثم في صفحة الإضافات (Addons) ألصقه في خانة Addon URL واضغط Install Addon للتثبيت. الصق الرابط الطويل الذي ينسخه الزر، لا عنوان هذه الصفحة.</p>
      <p class="hint" style="margin:8px 0 0"><b>لتعديل إعداد لاحقًا:</b> في صفحة الإضافات اضغط زر الإعداد ⚙ بجانب ترجمان، فتفتح هذه الصفحة وإعداداتك فيها. عدّل، انسخ الرابط، ثبّته، ثم احذف النسخة القديمة.</p>
    </div>
  </section>

  <footer>
    <p>مفتاحك موجود داخل رابط الإضافة فقط؛ الخادم لا يكتبه في ملفاته ولا في سجلاته. لا تشارك الرابط مع أحد.</p>
    <p>أول مرة لكل فيديو تأخذ الترجمة وقتًا. إن ظهر جزء منها فقط، أوقف الترجمة ثم أعد اختيار «العربية» من القائمة بعد قليل.</p>
  </footer>
</main>

<script>
  const $ = id => document.getElementById(id)

  // b: address of the service · m: model · r: reasoning effort · bs: lines per request · cc: requests at once
  const PRESETS = {
    gemini: { b: 'https://generativelanguage.googleapis.com/v1beta/openai', m: 'gemini-3.5-flash-lite', r: 'minimal', bs: 80, cc: 4, keys: 'https://aistudio.google.com/apikey', hint: 'gemini-3.5-flash-lite سريع ومجاني ضمن حدود Google.' },
    openrouter: { b: 'https://openrouter.ai/api/v1', m: 'google/gemini-3.5-flash-lite', r: '', bs: 80, cc: 4, keys: 'https://openrouter.ai/keys', hint: 'للتجربة المجانية: google/gemma-4-31b-it:free' },
    openai: { b: 'https://api.openai.com/v1', m: 'gpt-6-luna', r: 'low', bs: 80, cc: 4, keys: 'https://platform.openai.com/api-keys', hint: 'عندك الحصة اليومية المجانية من OpenAI (مشاركة البيانات)؟ اكتب gpt-5.6-terra: أقوى، وكان ضمن حصة الـ2.5 مليون توكن في نوفمبر 2026. بلا الحصة سعره مرتفع.' },
    custom: { b: '', m: '', r: '', bs: 80, cc: 2, keys: '', hint: 'أي خدمة تدعم ‎/chat/completions‎ بصيغة OpenAI.' },
  }

  const provider = () => document.querySelector('input[name=provider]:checked').value
  const number = (id, fallback) => ($(id).value.trim() === '' || Number.isNaN(+$(id).value) ? fallback : +$(id).value)

  const settings = () => ({
    p: provider(), b: $('base').value.trim().replace(/\\/+$/, ''), k: $('key').value.trim(), m: $('model').value.trim(), r: $('effort').value,
    src: $('src').value, any: +$('any').checked, warm: +$('warm').checked, pn: +$('pn').checked, cf: +$('cf').checked, sdh: +$('sdh').checked, nm: +$('nm').checked, gd: +$('gd').checked, nt: +$('nt').checked, na: +$('na').checked, ca: +$('ca').checked,
    ...( $('fb').value.trim() ? { fb: $('fb').value.trim().replace(/\\/+$/, ''), fk: $('fk').value.trim(), fm: $('fm').value.trim() } : {} ),
    ...( $('sd').value.trim() ? { sd: $('sd').value.trim() } : {} ),
    ...( $('jm').value.trim() ? { jm: $('jm').value.trim() } : {} ),
    ...( $('ex').value.trim() ? { ex: $('ex').value.trim().replace(/\\/+$/, '') } : {} ),
    n: number('n', 2), wait: number('wait', 50), bs: number('bs', 80), cc: number('cc', 4),
  })

  const problem = s =>
    !s.b ? 'أدخل رابط الخدمة.' :
    !/^https?:\\/\\/\\S+$/.test(s.b) ? 'رابط الخدمة يجب أن يبدأ بـ https://' :
    !s.k && s.p !== 'custom' ? 'أدخل مفتاح API لتفعيل التجربة والتثبيت.' :
    !s.m ? 'أدخل اسم النموذج.' : ''

  // The settings travel in the addon's address as base64url JSON
  const encode = value => {
    let binary = ''
    new TextEncoder().encode(JSON.stringify(value)).forEach(byte => { binary += String.fromCharCode(byte) })
    return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
  }
  const decode = segment => JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(segment.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0))))

  // What was filled in stays in this browser (the key with it), so that changing one option later does not mean
  // typing everything again. It goes nowhere else: the server never sees it apart from the addon's address.
  const KEPT = 'tarjuman-settings'
  const keep = current => { try { localStorage.setItem(KEPT, JSON.stringify(current)) } catch {} }
  const kept = () => { try { return JSON.parse(localStorage.getItem(KEPT) || 'null') } catch { return null } }

  const update = () => {
    const current = settings()
    keep(current)
    const missing = problem(current)
    const path = \`\${location.host}/\${encode(current)}/manifest.json\`
    const address = \`\${location.protocol}//\${path}\`
    $('problem').textContent = missing
    $('problem').hidden = !missing
    $('link').value = missing ? '' : address
    $('report').href = missing ? '#' : \`\${location.protocol}//\${location.host}/\${encode(current)}/report\`
    for (const [id, href] of [['install', \`stremio://\${path}\`], ['web', \`https://web.stremio.com/#/addons?addon=\${encodeURIComponent(address)}\`]]) {
      $(id).setAttribute('aria-disabled', String(Boolean(missing)))
      if (missing) $(id).removeAttribute('href')
      else $(id).href = href
    }
    $('test').disabled = Boolean(missing)
    $('copy').disabled = Boolean(missing)
  }

  const usePreset = name => {
    const preset = PRESETS[name]
    $('base').value = preset.b
    $('model').value = preset.m
    $('effort').value = preset.r
    $('bs').value = preset.bs
    $('cc').value = preset.cc
    showPreset(name)
  }
  const showPreset = name => {
    const preset = PRESETS[name]
    $('base-row').hidden = name !== 'custom'
    $('key-link').hidden = !preset.keys
    if (preset.keys) $('key-link').href = preset.keys
    $('model-hint').textContent = preset.hint
    $('result').hidden = true
    update()
  }

  document.querySelectorAll('input[name=provider]').forEach(radio => radio.addEventListener('change', () => usePreset(radio.value)))
  document.querySelectorAll('input:not([name=provider]), select').forEach(field => field.addEventListener('input', update))

  $('reveal').addEventListener('click', () => {
    const shown = $('key').type === 'text'
    $('key').type = shown ? 'password' : 'text'
    $('reveal').textContent = shown ? 'إظهار' : 'إخفاء'
    $('reveal').setAttribute('aria-pressed', String(!shown))
  })

  $('copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText($('link').value)
    } catch {
      $('link').select()
      document.execCommand('copy')
    }
    $('copy').textContent = 'تم النسخ ✓'
    setTimeout(() => { $('copy').textContent = 'نسخ الرابط' }, 1800)
  })
  $('link').addEventListener('focus', () => $('link').select())

  const line = (className, content) => Object.assign(document.createElement('span'), { className, textContent: content })

  $('test').addEventListener('click', async () => {
    const box = $('result')
    box.hidden = false
    box.className = 'result'
    box.replaceChildren(Object.assign(document.createElement('span'), { className: 'spin' }), ' جارٍ تجربة النموذج…')
    box.style.display = 'flex'
    box.style.gap = '10px'
    box.style.alignItems = 'center'
    $('test').disabled = true
    let answer
    try {
      answer = await (await fetch('/api/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings()) })).json()
    } catch {
      answer = { ok: false, error: 'تعذّر الاتصال بخادم الإضافة.' }
    }
    box.style.display = ''
    if (answer.ok) {
      box.className = 'result good'
      const list = document.createElement('ol')
      for (const pair of answer.lines) {
        const item = document.createElement('li')
        item.append(line('from', pair.from), line('to', pair.to))
        list.append(item)
      }
      box.replaceChildren(\`✅ يعمل. ردّ النموذج خلال \${answer.seconds} ثانية:\`, list)
    } else {
      box.className = 'result bad'
      box.replaceChildren(\`⚠️ \${answer.error}\`)
    }
    update()
  })

  // What this server can do: keep finished translations, and reach the subtitles source
  fetch('/api/status').then(response => response.json()).then(status => {
    const item = (good, message) => Object.assign(document.createElement('li'), { className: good ? '' : 'bad', textContent: \`\${good ? '✅' : '⚠️'} \${message}\` })
    const stored = status.storage !== 'none'
    $('status').replaceChildren(
      item(stored, stored ? 'التخزين متصل: كل ترجمة تُحفظ ولا تُعاد.' : 'التخزين غير متصل: الترجمة تُعاد في كل مشاهدة. اربط مساحة KV باسم CACHE ثم أعد الرفع.'),
      item(status.source.ok, status.source.ok ? 'مصدر الترجمات يرد من هذا الخادم.' : \`مصدر الترجمات لا يرد من هذا الخادم (\${status.source.status || status.source.error}).\`),
    )
    $('status').hidden = false
  }).catch(() => {})

  const [, segment, last] = location.pathname.split('/')
  // Opened from the player's settings button as /<settings>/configure: the page starts from those settings.
  // Otherwise from what this browser kept the last time.
  let saved = null
  if (last === 'configure') try { saved = decode(segment) } catch {}
  saved ??= kept()
  if (saved && typeof saved === 'object') {
    const name = PRESETS[saved.p] ? saved.p : 'custom'
    document.querySelector(\`input[name=provider][value=\${name}]\`).checked = true
    for (const [id, key] of [['base', 'b'], ['key', 'k'], ['model', 'm'], ['effort', 'r'], ['src', 'src'], ['n', 'n'], ['wait', 'wait'], ['bs', 'bs'], ['cc', 'cc'], ['fb', 'fb'], ['fk', 'fk'], ['fm', 'fm'], ['sd', 'sd'], ['jm', 'jm'], ['ex', 'ex']]) {
      if (saved[key] !== undefined) $(id).value = saved[key]
    }
    for (const id of ['any', 'warm', 'pn', 'cf', 'sdh', 'nm', 'gd', 'nt', 'na', 'ca']) if (saved[id] !== undefined) $(id).checked = Boolean(saved[id])
    showPreset(name)
  } else {
    usePreset('gemini')
  }

  $('forget').addEventListener('click', event => {
    event.preventDefault()
    try { localStorage.removeItem(KEPT) } catch {}
    location.reload()
  })
</script>
</body>
</html>
`;

// public/logo.png
var logo_default = "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";

// worker.mjs
var logo = null;
var kvStore = (kv) => ({
  kind: "kv",
  getFinal: (key) => kv.get(`f:${key}`, { cacheTtl: 30 }),
  putFinal: (key, vtt2) => kv.put(`f:${key}`, vtt2),
  // asked for every subtitle in a list: the value is not read, only whether it is there
  hasFinal: async (key) => {
    const body = await kv.get(`f:${key}`, { type: "stream", cacheTtl: 30 });
    if (!body) return false;
    await body.cancel().catch(() => {
    });
    return true;
  },
  // When a subtitle was first picked. Kept here because the second pick may come to another isolate; forgotten after 15 minutes.
  getArmed: (key) => kv.get(`a:${key}`, { cacheTtl: 30 }),
  putArmed: (key, at) => kv.put(`a:${key}`, String(at), { expirationTtl: 900 }),
  // A translation cut off half-way is of no use after a day
  getProgress: (key) => kv.get(`p:${key}`, { type: "json", cacheTtl: 30 }),
  putProgress: (key, data) => kv.put(`p:${key}`, JSON.stringify(data), { expirationTtl: 86400 }),
  // The name dictionary of a show (ideas 14 + 17): one small JSON per show, kept indefinitely
  getNames: (key) => kv.get(`n:${key}`, { type: "json", cacheTtl: 30 }),
  putNames: (key, data) => kv.put(`n:${key}`, JSON.stringify(data)),
  // The monthly ledger (idea 38): one small JSON per month, kept indefinitely
  getReport: (key) => kv.get(`r:${key}`, { type: "json", cacheTtl: 30 }),
  putReport: (key, data) => kv.put(`r:${key}`, JSON.stringify(data)),
  probe: async () => {
    await kv.get("probe");
    return true;
  }
});
var noStore = {
  kind: "none",
  getFinal: async () => null,
  putFinal: async () => {
  },
  getProgress: async () => null,
  putProgress: async () => {
  },
  getNames: async () => null,
  putNames: async () => {
  },
  getReport: async () => null,
  putReport: async () => {
  },
  probe: async () => false
};
var platformFor = (env) => {
  const setting = (name) => typeof env[name] === "string" ? env[name] : void 0;
  const number3 = (name, fallback) => Number.isFinite(Number(setting(name))) && setting(name) !== "" && setting(name) !== void 0 ? Number(setting(name)) : fallback;
  return {
    runtime: "cloudflare",
    env: setting,
    page: configure_default,
    hasLogo: true,
    logo: () => logo ??= Uint8Array.from(atob(logo_default), (char) => char.charCodeAt(0)),
    store: env.CACHE?.get ? kvStore(env.CACHE) : noStore,
    // Free plan: 50 subrequests/request and 30 s after the client leaves. 32 model calls leave a real
    // margin for the source list, the extra providers, the verification downloads and the KV writes.
    // On a paid plan HELPER_BUDGET can be raised again.
    limits: {
      budget: number3("HELPER_BUDGET", 32),
      lingerMs: number3("LINGER_MS", 18e3),
      progressEveryMs: number3("PROGRESS_EVERY_MS", 15e3),
      maxBoards: 12,
      maxConcurrency: 5
      // of the 6 connections a request may have open at once, one is left for the store
    }
  };
};
var handle;
var worker_default = {
  fetch(request, env, ctx) {
    handle ??= createApp(platformFor(env));
    return handle(request, ctx);
  }
};
export {
  worker_default as default
};
