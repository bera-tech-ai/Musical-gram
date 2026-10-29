// Vercel serverless handler.
// Routes: /api/home, /api/search, /api/detail, /api/play, /api/subtitle
const BASE = process.env.SPACE_API_BASE || 'https://space-tech-ke.xcasper.space';
const SUBTITLE_HOSTS = ['cacdn.hakunaymatata.com'];
const TTL_MS = 10 * 60 * 1000;

let cache = { at: 0, items: null, banners: null };

// ---------- Catalog ----------

function collectSubjects(data) {
  const found = [];
  const add = (s) => {
    if (s && typeof s === 'object' && s.detailPath && s.title) found.push(s);
  };
  for (const section of Array.isArray(data.operatingList) ? data.operatingList : []) {
    for (const item of section.banner?.items ?? []) add(item.subject);
    for (const item of section.customData?.items ?? []) add(item.subject);
    for (const s of section.subjects ?? []) add(s);
  }
  for (const key of ['homeList', 'topPickList']) {
    if (Array.isArray(data[key])) for (const e of data[key]) add(e.subject ?? e);
  }
  return found;
}

function collectBanners(data) {
  const out = [];
  for (const section of Array.isArray(data.operatingList) ? data.operatingList : []) {
    if (section.type !== 'BANNER') continue;
    for (const it of section.banner?.items ?? []) {
      const s = it.subject;
      if (!s?.detailPath) continue;
      out.push({
        title: s.title,
        slug: s.detailPath,
        image: it.image?.url || s.cover?.url || null,
        year: s.releaseDate ? s.releaseDate.slice(0, 4) : '',
        genre: s.genre ? s.genre.split(',').map((g) => g.trim()).filter(Boolean) : [],
      });
    }
  }
  return out.filter((b) => b.image);
}

// Accepts both the /api/home subject shape and the search result shape.
function normalize(s) {
  const rating = parseFloat(s.imdbRatingValue);
  const genre = typeof s.genre === 'string'
    ? s.genre.split(',').map((g) => g.trim()).filter(Boolean)
    : [];
  return {
    id: s.subjectId ?? s.id,
    slug: s.detailPath,
    title: s.title,
    genre,
    year: s.releaseDate ? String(s.releaseDate).slice(0, 4) : '',
    rating: Number.isFinite(rating) ? rating : null,
    ratingCount: s.imdbRatingCount ?? 0,
    country: s.countryName || '',
    durationMin: s.duration ? Math.round(s.duration / 60) : null,
    type: s.subjectType === 2 ? 'Series' : 'Movie',
    description: s.description || '',
    cover: typeof s.cover === 'string' ? s.cover : (s.cover?.url || null),
  };
}

async function getCatalog() {
  if (cache.items && Date.now() - cache.at < TTL_MS) return cache;

  const res = await fetch(`${BASE}/api/home`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Upstream /api/home responded ${res.status}`);

  const data = await res.json();
  const unique = new Map();
  for (const s of collectSubjects(data)) {
    if (!unique.has(s.detailPath)) unique.set(s.detailPath, normalize(s));
  }
  cache = {
    at: Date.now(),
    items: [...unique.values()].filter((m) => m.cover),
    banners: collectBanners(data),
  };
  return cache;
}

// Searches the upstream API so results aren't limited to the home catalog.
async function searchUpstream(keyword) {
  const params = new URLSearchParams({ keyword, page: '1', perPage: '30' });
  const res = await fetchWithTimeout(`${BASE}/api/search?${params}`, 10000);
  if (!res.ok) throw new Error(`Upstream search responded ${res.status}`);
  const data = await res.json();

  // Walk the JSON and collect every node that looks like a title.
  const found = new Map();
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const s = node.subject && node.subject.detailPath ? node.subject : node;
    if (s.detailPath && s.title) {
      if (!found.has(s.detailPath)) found.set(s.detailPath, normalize(s));
      return;
    }
    Object.values(node).forEach(walk);
  };
  walk(data);
  return [...found.values()].filter((m) => m.cover);
}

// ---------- Playback ----------

async function fetchWithTimeout(url, timeoutMs, init = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      headers: { Accept: 'application/json', ...(init.headers || {}) },
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchUpstreamJson(path, params, timeoutMs) {
  const res = await fetchWithTimeout(`${BASE}${path}?${params}`, timeoutMs);
  if (!res.ok) throw new Error(`${path} responded ${res.status}`);
  return res.json();
}

async function getPlay({ subjectId, detailPath, season, episode }) {
  const params = new URLSearchParams({ subjectId });
  if (detailPath) params.set('detailPath', detailPath);
  if (season) params.set('season', season);
  if (episode) params.set('episode', episode);

  let data;
  try {
    // Full metadata including subtitles and audio. About 10s upstream.
    data = await fetchUpstreamJson('/api/play', params, 20000);
  } catch (err) {
    console.error('play failed, falling back to play-links:', err.message);
    // Same streams and download links, without subtitles. Under 1s upstream.
    data = await fetchUpstreamJson('/api/play-links', params, 8000);
  }

  return {
    qualities: (data.streams || []).map((s) => ({
      label: s.quality || `${s.resolutions}p`,
      url: s.proxyUrl,
      downloadUrl: s.downloadUrl,
    })),
    subtitles: (data.subtitles || []).map((t) => ({
      label: t.language,
      lang: t.languageCode,
      url: `/api/subtitle?url=${encodeURIComponent(t.url)}`,
    })),
  };
}

// ---------- HTTP ----------

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  res.end(JSON.stringify(body));
}

module.exports = async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const route = url.pathname.replace(/^\/api/, '').replace(/\/$/, '') || '/';
  const cacheHeader = { 'Cache-Control': 's-maxage=600, stale-while-revalidate=300' };

  try {
    if (route === '/home') {
      const { items, banners } = await getCatalog();
      return send(res, 200, { count: items.length, items, banners }, cacheHeader);
    }

    if (route === '/search') {
      const keyword = (url.searchParams.get('q') || url.searchParams.get('keyword') || '').trim();
      if (!keyword) return send(res, 200, { count: 0, items: [] }, cacheHeader);

      let items;
      try {
        items = await searchUpstream(keyword);
      } catch (err) {
        // Fall back to the home catalog if the upstream search fails.
        console.error('search fell back to catalog:', err.message);
        const k = keyword.toLowerCase();
        items = (await getCatalog()).items.filter((m) => m.title.toLowerCase().includes(k));
      }
      return send(res, 200, { count: items.length, items: items.slice(0, 50) },
        { 'Cache-Control': 'public, s-maxage=300' });
    }

    if (route === '/detail') {
      const slug = url.searchParams.get('slug') || '';
      const movie = (await getCatalog()).items.find((m) => m.slug === slug);
      if (!movie) return send(res, 404, { error: 'Not found' });
      return send(res, 200, movie, cacheHeader);
    }

    if (route === '/play') {
      const subjectId = url.searchParams.get('subjectId') || '';
      if (!/^\d+$/.test(subjectId)) return send(res, 400, { error: 'Invalid subjectId' });
      const data = await getPlay({
        subjectId,
        detailPath: url.searchParams.get('detailPath') || '',
        season: url.searchParams.get('season'),
        episode: url.searchParams.get('episode'),
      });
      // Signed stream and subtitle URLs expire, so never cache this response.
      return send(res, 200, data, { 'Cache-Control': 'private, no-store' });
    }

    if (route === '/subtitle') {
      let target;
      try {
        target = new URL(url.searchParams.get('url') || '');
      } catch {
        return send(res, 400, { error: 'Invalid url' });
      }
      if (!SUBTITLE_HOSTS.includes(target.hostname)) {
        return send(res, 403, { error: 'Host not allowed' });
      }
      const upstream = await fetchWithTimeout(target.href, 10000, { headers: { Accept: '*/*' } });
      if (!upstream.ok) return send(res, 502, { error: 'Subtitle unavailable' });

      const srt = await upstream.text();
      const vtt = 'WEBVTT\n\n' + srt
        .replace(/\r/g, '')
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');

      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Cache-Control', 'public, s-maxage=86400');
      return res.end(vtt);
    }

    return send(res, 404, { error: 'Unknown route' });
  } catch (err) {
    console.error(err);
    return send(res, 502, { error: 'Upstream unavailable', detail: err.message });
  }
};
