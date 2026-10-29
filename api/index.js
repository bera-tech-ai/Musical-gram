// Vercel serverless handler.
// Routes: /api/home, /api/search, /api/detail, /api/play, /api/subtitle
const BASE = process.env.SPACE_API_BASE || 'https://space-tech-ke.xcasper.space';
const SUBTITLE_HOSTS = ['cacdn.hakunaymatata.com'];
const TTL_MS = 10 * 60 * 1000;

let cache = { at: 0, items: null, banners: null };

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

function normalize(s) {
  const rating = parseFloat(s.imdbRatingValue);
  return {
    id: s.subjectId,
    slug: s.detailPath,
    title: s.title,
    genre: s.genre ? s.genre.split(',').map((g) => g.trim()).filter(Boolean) : [],
    year: s.releaseDate ? s.releaseDate.slice(0, 4) : '',
    rating: Number.isFinite(rating) ? rating : null,
    ratingCount: s.imdbRatingCount ?? 0,
    country: s.countryName || '',
    durationMin: s.duration ? Math.round(s.duration / 60) : null,
    type: s.subjectType === 2 ? 'Series' : 'Movie',
    description: s.description || '',
    cover: s.cover?.url || null,
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

async function getPlay({ subjectId, detailPath, season, episode }) {
  const params = new URLSearchParams({ subjectId });
  if (detailPath) params.set('detailPath', detailPath);
  if (season) params.set('season', season);
  if (episode) params.set('episode', episode);

  const res = await fetch(`${BASE}/api/play?${params}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Upstream /api/play responded ${res.status}`);
  const data = await res.json();

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
      const q = (url.searchParams.get('q') || '').trim().toLowerCase();
      if (!q) return send(res, 200, { count: 0, items: [] }, cacheHeader);
      const items = (await getCatalog()).items
        .filter((m) => m.title.toLowerCase().includes(q))
        .slice(0, 50);
      return send(res, 200, { count: items.length, items }, cacheHeader);
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
      const upstream = await fetch(target.href);
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
    return send(res, 502, { error: 'Upstream unavailable' });
  }
};
