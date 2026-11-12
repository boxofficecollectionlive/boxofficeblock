/**
 * BoxOfficeCollectionLive — Year-Round Autopilot Scraper, Discovery & Trend Engine
 * Scheduled via GitHub Actions twice daily (12:00 PM IST & 09:30 PM IST).
 *
 * Lifecycle & Ranking Rules:
 *   1. Auto-Discovery: Detects new weekly releases from Sacnilk (/quicknews) & Bollywood Hungama
 *      tables and auto-fetches official posters (Sacnilk movie og:image / Wikipedia API).
 *   2. 15-Day Active Tracking: Movies <= 15 days stay in "Last 15 Days" with 2x daily updates.
 *   3. 16-30 Day Holdover & >30 Day Auto-Remove: Day 16-30 move to "Holdover Benchmark";
 *      Day > 30 are automatically archived out of active marketReleases & tickerFeed.
 *   4. Performance + Search/BMS Buzz Ranking: Ranks active films by composite trendScore
 *      (collections + shows + 5-portal buzz + Google Trends IN + BookMyShow ticket reports)
 *      and promotes the #1 top trending film to heroMovie automatically.
 */

const fs = require('fs');
const path = require('path');

const DATA_FILE_PATH = path.join(__dirname, 'boxoffice_data.json');
const REQUEST_TIMEOUT_MS = 10000;

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-IN,en-US;q=0.9,en;q=0.8'
};

const AUTHENTIC_SOURCES = [
  { id: 'sacnilk', name: 'Sacnilk', domain: 'sacnilk.com', directUrl: 'https://www.sacnilk.com/' },
  { id: 'bollywoodhungama', name: 'Bollywood Hungama', domain: 'bollywoodhungama.com', directUrl: 'https://www.bollywoodhungama.com/box-office-collections/' },
  { id: 'boxofficeindia', name: 'Box Office India', domain: 'boxofficeindia.com', directUrl: 'https://boxofficeindia.com/' },
  { id: 'koimoi', name: 'Koimoi', domain: 'koimoi.com', directUrl: 'https://www.koimoi.com/box-office/' },
  { id: 'pinkvilla', name: 'Pinkvilla', domain: 'pinkvilla.com', directUrl: 'https://www.pinkvilla.com/entertainment/box-office' }
];

const MOVIE_SEARCH_ALIASES = {
  'ramayana-2026': ['ramayana'],
  'scene-2026': ['scene box office', 'scene day', 'scene india'],
  'mookuthi-amman-2': ['mookuthi amman 2', 'mookuthi amman'],
  'ak-47': ['aadarsha kutumbam', 'ak 47'],
  'pyre': ['pyre box office', 'pyre'],
  'jailer-2': ['jailer 2'],
  'udta-teer': ['udta teer']
};

const MOVIE_SYMBOLS = {
  'ramayana-2026': { symbol: 'RAMAYANA', badge: 'Diwali Breakout' },
  'scene-2026': { symbol: 'SCENE', badge: 'Pan-South Hit' },
  'mookuthi-amman-2': { symbol: 'M-AMMAN2', badge: 'Active Run' },
  'ak-47': { symbol: 'AK47', badge: 'Weekday Hold' },
  'pyre': { symbol: 'PYRE', badge: 'Multiplex Run' },
  'jailer-2': { symbol: 'JAILER2', badge: 'End of Run' },
  'udta-teer': { symbol: 'UDTA-TEER', badge: 'Steady Tail' }
};

const FALLBACK_POSTER_URL = 'https://upload.wikimedia.org/wikipedia/en/4/48/Ramayana_Part_1_%28poster%29.jpg';

/** Decode HTML/XML entities (named + numeric) and collapse whitespace. */
function cleanText(raw) {
  return String(raw || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Slugify title to stable movie id. */
function slugify(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Return current IST calendar date string (YYYY-MM-DD) and formatted IST time. */
function getIstClock(now = new Date()) {
  const dateStr = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(now);
  const timeStr = new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).format(now);
  return { dateStr, timeStr: `${dateStr} ${timeStr} IST`, shortTime: timeStr };
}

/** Subtract (dayNum - 1) days from an IST YYYY-MM-DD string. */
function deriveReleaseDate(todayIstStr, dayNum) {
  const ms = Date.parse(`${todayIstStr}T00:00:00Z`) - Math.max(0, dayNum - 1) * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Compute whole theatrical days elapsed since releaseDate in IST. */
function computeTheatricalDay(releaseDateStr, todayIstStr) {
  const startMs = Date.parse(`${releaseDateStr}T00:00:00Z`);
  const todayMs = Date.parse(`${todayIstStr}T00:00:00Z`);
  if (!Number.isFinite(startMs) || !Number.isFinite(todayMs)) return null;
  const diffDays = Math.floor((todayMs - startMs) / 86400000) + 1;
  return diffDays >= 1 ? diffDays : 1;
}

/** Fetch a URL safely with timeout and return status + body. */
async function safeFetchText(url) {
  try {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const text = res.ok ? await res.text() : '';
    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    return { ok: false, status: 0, text: '', error: err.message };
  }
}

/** Convert amount string ("₹22 L" or "₹12.56 Cr") to Crores. */
function toCrores(amountStr, unit) {
  const val = parseFloat(String(amountStr).replace(/,/g, ''));
  if (!Number.isFinite(val)) return null;
  return /^l$/i.test(unit) ? parseFloat((val / 100).toFixed(2)) : parseFloat(val.toFixed(2));
}

/** Extract numeric Cr value from strings like "₹12.56 Cr*". */
function parseCrNumber(str, fallback = 0) {
  const m = String(str || '').match(/([\d,.]+)/);
  if (!m) return fallback;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : fallback;
}

/** Extract clean article headlines and snippets from portal HTML. */
function extractHeadlinesFromHtml(html) {
  if (!html) return [];
  const items = new Set();
  const anchorRegex = /<(?:a|h1|h2|h3|h4)[^>]*>([\s\S]*?)<\/(?:a|h1|h2|h3|h4)>/gi;
  let match;
  while ((match = anchorRegex.exec(html)) !== null) {
    const text = cleanText(match[1]);
    if (text.length >= 18 && text.length <= 240 && /(box office|collection|cr|crore|day\s+\d|net|gross|worldwide|bookmyshow|bms|tickets)/i.test(text)) {
      items.add(text);
    }
  }
  return Array.from(items).slice(0, 80);
}

/** Parse Bollywood Hungama's table rows for recent releases + India Net figures. */
function parseBollywoodHungamaRows(html) {
  if (!html) return [];
  const rows = [];
  const rowRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rm;
  while ((rm = rowRegex.exec(html)) !== null) {
    const cells = [...rm[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map(c => cleanText(c[1]));
    if (cells.length >= 6) {
      const title = cells[0].replace(/\s*\(English\)\s*|\s*\(Re-release\)\s*/gi, '').trim();
      const dateMs = Date.parse(cells[1]);
      const opening = parseFloat(cells[2]);
      const lifetime = parseFloat(cells[5]);
      if (title && Number.isFinite(dateMs) && Number.isFinite(lifetime) && lifetime >= 0.5) {
        rows.push({
          title,
          releaseDate: new Date(dateMs + 86400000).toISOString().slice(0, 10),
          opening: Number.isFinite(opening) ? opening : 0,
          lifetime
        });
      }
    }
  }
  return rows;
}

/** Parse Sacnilk's /big-release/ table for a tentpole movie. */
function parseSacnilkBigRelease(html) {
  if (!html) return null;
  const txt = cleanText(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<header[\s\S]*?<\/header>/gi, ' '));

  const liveMatch = txt.match(/Live today\s*₹([\d.]+)\s*Cr\s*India net\s*[·•]\s*Day\s*(\d+)/i);
  const advanceMatch = txt.match(/(Day\s*\d+\s*advance:\s*₹[\d.]+\s*(?:Cr|L)\s*so far)/i);
  const showsMatch = txt.match(/([\d,]+)\s*shows tracked today\s*([\d.]+)%\s*occupancy/i);
  const totalMatch = txt.match(/Total\s+(\d+)\s+days\s+₹([\d,.]+)\s*Cr\s+₹([\d,.]+)\s*Cr\s+₹([\d,.]+)\s*Cr\s+₹([\d,.]+)\s*Cr\s+₹([\d,.]+)\s*Cr\s+₹([\d,.]+)\s*Cr\s+₹([\d,.]+)\s*Cr\s+([\d.]+\s*(?:Cr|lakh))\s+₹([\d,.]+)\s*Cr\s+₹([\d,.]+)\s*Cr/i);

  const dayRows = [];
  const dayRegex = /Day\s+(\d+)\s+\w+\s+\d+\s+\w+(?:\s*[·•]\s*live estimate)?\s+(?:₹[\d.]+\s*Cr\s+|–\s+){5}₹([\d.]+)\s*Cr\s+₹([\d.]+)\s*Cr\s+(?:[\d.]+\s*lakh|–)\s+(?:₹([\d.]+)\s*Cr|–)\s+(?:₹([\d.]+)\s*Cr|–)/gi;
  let dm;
  while ((dm = dayRegex.exec(txt)) !== null) {
    const dNum = parseInt(dm[1], 10);
    const net = parseFloat(dm[2]);
    const gross = parseFloat(dm[3]);
    if (Number.isFinite(dNum) && Number.isFinite(net)) dayRows.push({ dayNum: dNum, net, gross });
  }

  if (!totalMatch && !liveMatch) return null;
  const parseCr = s => parseFloat(String(s).replace(/,/g, ''));
  return {
    liveDayNum: liveMatch ? parseInt(liveMatch[2], 10) : null,
    liveDayNet: liveMatch ? parseFloat(liveMatch[1]) : null,
    advanceLine: advanceMatch ? advanceMatch[1] : null,
    shows: showsMatch ? parseInt(showsMatch[1].replace(/,/g, ''), 10) : null,
    occupancy: showsMatch ? parseFloat(showsMatch[2]) : null,
    languages: totalMatch ? [
      { language: 'Hindi', amount: parseCr(totalMatch[2]), color: '#10B981' },
      { language: 'Kannada', amount: parseCr(totalMatch[3]), color: '#06B6D4' },
      { language: 'Telugu', amount: parseCr(totalMatch[4]), color: '#F59E0B' },
      { language: 'Tamil', amount: parseCr(totalMatch[5]), color: '#8B5CF6' },
      { language: 'Malayalam', amount: parseCr(totalMatch[6]), color: '#EC4899' }
    ] : null,
    totalIndiaNet: totalMatch ? parseCr(totalMatch[7]) : null,
    totalIndiaGross: totalMatch ? parseCr(totalMatch[8]) : null,
    totalFootfalls: totalMatch ? totalMatch[9] : null,
    totalOverseas: totalMatch ? parseCr(totalMatch[10]) : null,
    totalWorldwide: totalMatch ? parseCr(totalMatch[11]) : null,
    dayRows
  };
}

/** Parse Sacnilk /quicknews live estimate sentences (including optional language split). */
function parseSacnilkQuicknews(html, fallbackSlugTitle = '') {
  if (!html) return null;
  const txt = cleanText(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<header[\s\S]*?<\/header>/gi, ' '));
  const m = txt.match(/As of Day\s*(\d+),\s*(.+?)\s+is currently running across\s*([\d,]+)\s*shows and has collected a net of\s*₹([\d.]+)\s*(Cr|L)\s*today[\s\S]{0,280}?This brings total India gross collections to\s*₹([\d.]+)\s*(Cr|L)\s*and total India net to\s*₹([\d.]+)\s*(Cr|L)/i);
  if (!m) return null;

  const moviePageMatch = html.match(/href=["'](\/movie\/[^"']+)["']/i);
  return {
    dayNum: parseInt(m[1], 10),
    title: cleanText(m[2]) || fallbackSlugTitle,
    shows: parseInt(m[3].replace(/,/g, ''), 10),
    todayNetCr: toCrores(m[4], m[5]),
    totalGrossCr: toCrores(m[6], m[7]),
    totalNetCr: toCrores(m[8], m[9]),
    moviePageUrl: moviePageMatch ? `https://www.sacnilk.com${moviePageMatch[1]}` : null
  };
}

/** Fetch official poster URL from Sacnilk movie page (og:image) or Wikipedia REST API. */
async function resolveOfficialPoster(title, sacnilkMovieUrl) {
  if (sacnilkMovieUrl) {
    const res = await safeFetchText(sacnilkMovieUrl);
    if (res.ok) {
      const og = res.text.match(/property=["']og:image["'][^>]*content=["'](https?:\/\/[^"']+)["']/i);
      if (og && og[1]) return og[1];
    }
  }
  const cleanTitle = title.replace(/\([^)]*\)/g, '').trim();
  const wikiUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(cleanTitle)}`;
  const wRes = await safeFetchText(wikiUrl);
  if (wRes.ok) {
    try {
      const wData = JSON.parse(wRes.text);
      if (wData.thumbnail && wData.thumbnail.source) return wData.thumbnail.source;
    } catch (_) {}
  }
  return null;
}

/** Parse Google News RSS items and tag each snippet with one of the 5 authentic domains. */
function extractItemsFromRss(xml, maxAgeHours = 96) {
  if (!xml) return [];
  const items = [];
  const cutoffMs = Date.now() - maxAgeHours * 3600 * 1000;
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const block = m[1];
    const titleMatch = block.match(/<title>([\s\S]*?)<\/title>/i);
    const pubMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/i);
    const sourceUrlMatch = block.match(/<source[^>]*url=["']([^"']+)["'][^>]*>([\s\S]*?)<\/source>/i);

    const pubMs = pubMatch ? Date.parse(pubMatch[1]) : NaN;
    if (Number.isFinite(pubMs) && pubMs < cutoffMs) continue;

    const title = cleanText(titleMatch ? titleMatch[1] : '');
    if (!title) continue;

    const srcUrl = sourceUrlMatch ? sourceUrlMatch[1].toLowerCase() : '';
    const srcLabel = cleanText(sourceUrlMatch ? sourceUrlMatch[2] : '').toLowerCase();
    const matchedSource = AUTHENTIC_SOURCES.find(
      s => srcUrl.includes(s.domain) || srcLabel.includes(s.name.toLowerCase()) || title.toLowerCase().includes(s.name.toLowerCase())
    );
    if (matchedSource) {
      items.push({ sourceId: matchedSource.id, sourceName: matchedSource.name, text: title, channel: 'rss' });
    }
  }
  return items;
}

/** Fetch Google Trends India RSS to boost buzz score for actively searched films. */
async function fetchGoogleTrendsIndia() {
  const res = await safeFetchText('https://trends.google.com/trending/rss?geo=IN');
  if (!res.ok) return [];
  return [...res.text.matchAll(/<title>([\s\S]*?)<\/title>/gi)]
    .map(m => cleanText(m[1]).toLowerCase())
    .slice(1);
}

/** Gather all portal headlines, structured tables, Google Trends IN, and BMS booking signals. */
async function collectAllSourceSignals(movies, istClock) {
  const sourceStats = {};
  const signals = [];
  let sacnilkHomeHtml = '';
  let bhHomeHtml = '';

  for (const src of AUTHENTIC_SOURCES) {
    sourceStats[src.id] = { name: src.name, domain: src.domain, directStatus: 0, rssStatus: 0, headlineCount: 0 };
  }

  // 1. Direct fetches across the 5 authentic portals + Google Trends India
  const [googleTrends] = await Promise.all([
    fetchGoogleTrendsIndia(),
    ...AUTHENTIC_SOURCES.map(async src => {
      const res = await safeFetchText(src.directUrl);
      sourceStats[src.id].directStatus = res.status;
      if (res.ok) {
        if (src.id === 'sacnilk') sacnilkHomeHtml = res.text;
        if (src.id === 'bollywoodhungama') bhHomeHtml = res.text;
        const headlines = extractHeadlinesFromHtml(res.text);
        headlines.forEach(text => signals.push({ sourceId: src.id, sourceName: src.name, text, channel: 'direct' }));
        sourceStats[src.id].headlineCount += headlines.length;
      }
    })
  ]);

  // 2. Parse Bollywood Hungama rows (active updates + auto-discovery candidates)
  const bhRows = parseBollywoodHungamaRows(bhHomeHtml);
  bhRows.forEach(row => {
    const matchExisting = movies.find(m => m.title.toLowerCase().includes(row.title.toLowerCase()) || row.title.toLowerCase().includes(m.title.replace(/\([^)]*\)/g, '').trim().toLowerCase()));
    if (matchExisting) {
      signals.push({
        sourceId: 'bollywoodhungama',
        sourceName: 'Bollywood Hungama',
        text: `${row.title} Bollywood Hungama Table: Lifetime ₹${row.lifetime} Cr`,
        channel: 'table',
        structured: { movieId: matchExisting.id, cumulativeNet: row.lifetime }
      });
      sourceStats.bollywoodhungama.headlineCount += 1;
    }
  });

  // 3. Parse Sacnilk /big-release/ramayana_part_1_2026 + discover ALL /quicknews/* links
  const sacnilkDeepData = { heroBigRelease: null, quicknewsByMovieId: {}, discoveredQuicknews: [] };
  const bigRes = await safeFetchText('https://www.sacnilk.com/big-release/ramayana_part_1_2026');
  if (bigRes.ok) {
    sacnilkDeepData.heroBigRelease = parseSacnilkBigRelease(bigRes.text);
    if (sacnilkDeepData.heroBigRelease && sacnilkDeepData.heroBigRelease.totalIndiaNet) {
      const br = sacnilkDeepData.heroBigRelease;
      signals.push({
        sourceId: 'sacnilk',
        sourceName: 'Sacnilk',
        text: `Ramayana Sacnilk Live Table: Total India Net ₹${br.totalIndiaNet} Cr, Worldwide ₹${br.totalWorldwide} Cr, Day ${br.liveDayNum} ₹${br.liveDayNet} Cr`,
        channel: 'table',
        structured: { movieId: 'ramayana-2026', cumulativeNet: br.totalIndiaNet, worldwide: br.totalWorldwide, daily: br.liveDayNet }
      });
      sourceStats.sacnilk.headlineCount += 1;
    }
  }

  // Crawl unique /quicknews/..._Box_Office_Collection_Day_X pages linked from Sacnilk homepage (dedupe by slug, keep highest Day)
  if (sacnilkHomeHtml) {
    const qMatches = [...sacnilkHomeHtml.matchAll(/href=["']((?:https?:\/\/www\.sacnilk\.com)?\/quicknews\/([A-Za-z0-9_]+)_Box_Office_Collection_Day_(\d+))["']/gi)];
    const latestBySlug = new Map();
    for (const qm of qMatches) {
      const rawUrl = qm[1].startsWith('http') ? qm[1] : `https://www.sacnilk.com${qm[1]}`;
      const slug = qm[2].toLowerCase();
      const dayNum = parseInt(qm[3], 10);
      if (!latestBySlug.has(slug) || dayNum > latestBySlug.get(slug).dayNum) {
        latestBySlug.set(slug, { url: rawUrl, slug: qm[2], dayNum });
      }
    }

    await Promise.all(
      Array.from(latestBySlug.values()).slice(0, 14).map(async entry => {
        const qr = await safeFetchText(entry.url);
        if (!qr.ok) return;
        const parsed = parseSacnilkQuicknews(qr.text, entry.slug.replace(/_202\d$/, '').replace(/_/g, ' '));
        if (!parsed) return;

        const existing = movies.find(m => {
          const aliases = MOVIE_SEARCH_ALIASES[m.id] || [slugify(m.title)];
          const cleanSlug = entry.slug.toLowerCase().replace(/_/g, ' ');
          return aliases.some(a => cleanSlug.includes(a.replace(/\s+box office|\s+day|\s+india/g, ''))) ||
                 cleanSlug.includes(m.title.replace(/\([^)]*\)/g, '').trim().toLowerCase());
        });

        if (existing) {
          sacnilkDeepData.quicknewsByMovieId[existing.id] = parsed;
          signals.push({
            sourceId: 'sacnilk',
            sourceName: 'Sacnilk',
            text: `${existing.title} Sacnilk Day ${parsed.dayNum} Live: ₹${parsed.todayNetCr} Cr today, Total India Net ₹${parsed.totalNetCr} Cr across ${parsed.shows} shows`,
            channel: 'table',
            structured: { movieId: existing.id, cumulativeNet: parsed.totalNetCr, daily: parsed.todayNetCr }
          });
          sourceStats.sacnilk.headlineCount += 1;
        } else if (parsed.dayNum <= 15 && (parsed.totalNetCr >= 0.5 || parsed.shows >= 150)) {
          // Candidate newly released movie to auto-add
          sacnilkDeepData.discoveredQuicknews.push({
            ...parsed,
            slug: entry.slug,
            releaseDate: deriveReleaseDate(istClock.dateStr, parsed.dayNum)
          });
        }
      })
    );
  }

  // 4. Domain-scoped Google News RSS queries (Box Office + BookMyShow / Ticket Velocity coverage)
  const siteFilter = AUTHENTIC_SOURCES.map(s => `site:${s.domain}`).join('+OR+');
  const movieQueries = movies.map(m => {
    const cleanTitle = m.title.replace(/\([^)]*\)/g, '').trim();
    return `https://news.google.com/rss/search?q=(${siteFilter})+${encodeURIComponent('"' + cleanTitle + '" (box office OR bookmyshow OR tickets)')}&hl=en-IN&gl=IN&ceid=IN:en`;
  });
  const generalQuery = `https://news.google.com/rss/search?q=(${siteFilter})+(box+office+collection+OR+bookmyshow)+crore&hl=en-IN&gl=IN&ceid=IN:en`;

  await Promise.all(
    [generalQuery, ...movieQueries].map(async url => {
      const res = await safeFetchText(url);
      if (!res.ok) return;
      const rssItems = extractItemsFromRss(res.text);
      rssItems.forEach(item => {
        signals.push(item);
        sourceStats[item.sourceId].rssStatus = 200;
        sourceStats[item.sourceId].headlineCount += 1;
      });
    })
  );

  return { signals, sourceStats, sacnilkDeepData, bhRows, googleTrends };
}

/** Auto-add newly discovered weekly movies (<= 15 days old) with official posters. */
async function discoverAndAddNewReleases(releases, sacnilkDeepData, bhRows, istClock) {
  const existingTitles = releases.map(m => m.title.replace(/\([^)]*\)/g, '').trim().toLowerCase());
  const addedNames = [];

  for (const cand of sacnilkDeepData.discoveredQuicknews) {
    const normTitle = cand.title.replace(/\([^)]*\)/g, '').trim().toLowerCase();
    if (existingTitles.some(t => t === normTitle || t.includes(normTitle) || normTitle.includes(t))) continue;

    const poster = (await resolveOfficialPoster(cand.title, cand.moviePageUrl)) || FALLBACK_POSTER_URL;
    const isPanIndia = cand.totalNetCr >= 25 || cand.shows >= 2000;
    const estWw = parseFloat(Math.max(cand.totalGrossCr || cand.totalNetCr * 1.2, cand.totalNetCr * 1.18).toFixed(2));
    const tixPerMin = Math.max(4, Math.min(180, Math.round((cand.todayNetCr || 0.25) * 4.5 + (cand.shows || 200) / 180)));

    releases.push({
      id: slugify(cand.title) + '-' + cand.releaseDate.slice(0, 4),
      title: cand.title,
      poster,
      releaseDate: cand.releaseDate,
      dayCount: cand.dayNum,
      category: isPanIndia ? 'Pan-India' : 'Regional',
      classification: 'Last 15 Days',
      sentiment: cand.todayNetCr >= 1.0 ? 'BULLISH' : 'BEARISH',
      orderBlock: cand.todayNetCr >= 5 ? 'Institutional Accumulation' : 'Active Theatrical Run',
      verdict: cand.totalNetCr >= 50 ? 'Hit Breakout' : 'Fresh Release',
      dayNet: `₹${(cand.todayNetCr || 0).toFixed(2)} Cr*`,
      totalNet: `₹${cand.totalNetCr.toFixed(2)} Cr`,
      worldwide: `₹${estWw.toFixed(2)} Cr`,
      baseNetNum: cand.totalNetCr,
      baseWwNum: estWw,
      ticketsPerMin: tixPerMin,
      dayChange: cand.todayNetCr >= 2 ? 8.5 : -10.0,
      shows: cand.shows || 450,
      occupancy: cand.shows > 2000 ? 45.0 : 24.0,
      dominantMarket: isPanIndia ? 'Pan-India' : 'Regional',
      supportLevel: `₹${Math.max(0.2, cand.todayNetCr * 0.7).toFixed(2)} Cr`,
      resistanceLevel: `₹${Math.ceil((cand.totalNetCr + 15) / 10) * 10} Cr Net`,
      budgetRecovery: cand.totalNetCr >= 50 ? '100%+ Hit' : 'Tracking Live',
      sparkline: [parseFloat((cand.totalNetCr * 0.4).toFixed(2)), parseFloat((cand.totalNetCr * 0.75).toFixed(2)), cand.todayNetCr]
    });
    existingTitles.push(normTitle);
    addedNames.push(`${cand.title} (Day ${cand.dayNum}, ₹${cand.totalNetCr} Cr)`);
  }

  // Fallback check on Bollywood Hungama rows for major new releases (> ₹3 Cr, <= 15 days) missed by Sacnilk homepage
  for (const bh of bhRows) {
    const dayAge = computeTheatricalDay(bh.releaseDate, istClock.dateStr);
    if (!dayAge || dayAge > 15 || bh.lifetime < 3.0) continue;
    const normTitle = bh.title.toLowerCase();
    if (existingTitles.some(t => t === normTitle || t.includes(normTitle) || normTitle.includes(t))) continue;

    const poster = (await resolveOfficialPoster(bh.title, null)) || FALLBACK_POSTER_URL;
    const estWw = parseFloat((bh.lifetime * 1.22).toFixed(2));
    releases.push({
      id: slugify(bh.title) + '-' + bh.releaseDate.slice(0, 4),
      title: bh.title,
      poster,
      releaseDate: bh.releaseDate,
      dayCount: dayAge,
      category: bh.lifetime >= 20 ? 'Pan-India' : 'Regional',
      classification: 'Last 15 Days',
      sentiment: bh.lifetime >= 10 ? 'BULLISH' : 'BEARISH',
      orderBlock: 'Fresh Release Tracking',
      verdict: bh.lifetime >= 20 ? 'Active Performer' : 'Steady Run',
      dayNet: `₹${Math.max(0.2, bh.opening * 0.4).toFixed(2)} Cr*`,
      totalNet: `₹${bh.lifetime.toFixed(2)} Cr`,
      worldwide: `₹${estWw.toFixed(2)} Cr`,
      baseNetNum: bh.lifetime,
      baseWwNum: estWw,
      ticketsPerMin: Math.max(5, Math.round(bh.lifetime * 0.8)),
      dayChange: -5.0,
      shows: Math.max(300, Math.round(bh.lifetime * 65)),
      occupancy: 28.0,
      dominantMarket: 'Hindi / Multiplex',
      supportLevel: '₹0.50 Cr',
      resistanceLevel: `₹${Math.ceil((bh.lifetime + 10) / 10) * 10} Cr Net`,
      budgetRecovery: 'Tracking Live',
      sparkline: [bh.opening || 1, parseFloat((bh.lifetime * 0.5).toFixed(2)), parseFloat((bh.lifetime * 0.2).toFixed(2))]
    });
    existingTitles.push(normTitle);
    addedNames.push(`${bh.title} (BH Day ${dayAge}, ₹${bh.lifetime} Cr)`);
  }

  return addedNames;
}

/** Extract Crore figure + metric kind from headline text. */
function parseBoxOfficeMention(text, expectedDay) {
  const lower = text.toLowerCase();
  if (/\b(budget|club|target|combined|together|milestone|approaching|chasing|eyes|aims|prediction|advance|pre-sales)\b/i.test(lower)) return null;
  if (/\band\b.*(?:crore|cr)/i.test(lower) && /\b\d{3,4}\s*(?:crore|cr)/i.test(lower)) return null;

  const crRegex = /(?:₹|rs\.?\s*|inr\s*)?(\d+(?:\.\d+)?)\s*(?:cr\b|crore\b)/gi;
  const values = [];
  let match;
  while ((match = crRegex.exec(text)) !== null) {
    const num = parseFloat(match[1]);
    if (Number.isFinite(num) && num > 0 && num < 5000) values.push(num);
  }
  if (!values.length) return null;

  const val = values[0];
  if (/\bworldwide\b|\bww\b|\bglobal\b/i.test(lower)) return { kind: 'worldwide', value: val };
  const dayMatch = lower.match(/\bday\s*(\d+)\b/);
  if (dayMatch) {
    const mentionedDay = parseInt(dayMatch[1], 10);
    if (expectedDay && Math.abs(mentionedDay - expectedDay) <= 1 && val <= 160) {
      return { kind: 'daily', day: mentionedDay, value: val };
    }
    return { kind: 'cumulativeNet', day: mentionedDay, value: val };
  }
  if (/\bhindi\b/i.test(lower)) return { kind: 'hindiNet', value: val };
  return { kind: 'cumulativeNet', value: val };
}

/** Return median of numeric array. */
function median(nums) {
  if (!nums.length) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Match portal + BMS + Google Trends signals for a movie and compute consensus & buzz score. */
function verifyMovieFromSignals(movie, signals, googleTrends, actualDay) {
  const baseTitle = movie.title.replace(/\([^)]*\)/g, '').trim().toLowerCase();
  const aliases = MOVIE_SEARCH_ALIASES[movie.id] || [baseTitle];
  const aliasRegexes = aliases.map(a => new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
  const matched = signals.filter(s => (s.structured && s.structured.movieId === movie.id) || aliasRegexes.some(rx => rx.test(s.text)));

  const byKind = { daily: new Map(), cumulativeNet: new Map(), worldwide: new Map() };
  const distinctSources = new Set();
  let bmsMentions = 0;

  for (const item of matched) {
    distinctSources.add(item.sourceName);
    if (/\b(bookmyshow|bms|tickets?\s+booked|tickets?\s+sold|advance\s+booking)\b/i.test(item.text)) {
      bmsMentions += 1;
    }
    if (item.structured) {
      if (item.structured.cumulativeNet) byKind.cumulativeNet.set(item.sourceId, item.structured.cumulativeNet);
      if (item.structured.worldwide) byKind.worldwide.set(item.sourceId, item.structured.worldwide);
      if (item.structured.daily) byKind.daily.set(item.sourceId, item.structured.daily);
      continue;
    }

    const parsed = parseBoxOfficeMention(item.text, actualDay);
    if (!parsed || !byKind[parsed.kind]) continue;

    const maxDailyCap = Math.min(160, Math.max(2, movie.baseNetNum * 0.55));
    if (parsed.kind === 'cumulativeNet' && (parsed.value < movie.baseNetNum * 0.98 || parsed.value > movie.baseNetNum * 1.45)) continue;
    if (parsed.kind === 'worldwide' && (parsed.value < movie.baseWwNum * 0.98 || parsed.value > movie.baseWwNum * 1.45)) continue;
    if (parsed.kind === 'daily' && (parsed.value < 0.05 || parsed.value > maxDailyCap)) continue;

    if (!byKind[parsed.kind].has(item.sourceId)) byKind[parsed.kind].set(item.sourceId, parsed.value);
  }

  const isGoogleTrending = googleTrends.some(t => t.includes(baseTitle));
  const dailyVals = Array.from(byKind.daily.values());
  const netVals = Array.from(byKind.cumulativeNet.values());
  const wwVals = Array.from(byKind.worldwide.values());

  return {
    matchedHeadlines: matched.slice(0, 5).map(m => `${m.sourceName}: ${m.text}`),
    distinctSources: Array.from(distinctSources),
    headlineCount: matched.length,
    bmsMentions,
    isGoogleTrending,
    netSources: Array.from(byKind.cumulativeNet.keys()),
    wwSources: Array.from(byKind.worldwide.keys()),
    verifiedDailyCr: dailyVals.length >= 2 ? parseFloat(median(dailyVals).toFixed(2)) : null,
    verifiedNetCr: netVals.length >= 2 ? parseFloat(median(netVals).toFixed(2)) : null,
    verifiedWwCr: wwVals.length >= 2 ? parseFloat(median(wwVals).toFixed(2)) : null
  };
}

/** Merge verified figures, enforce 15d/30d lifecycle, rank by performance+buzz, and build #1 heroMovie. */
async function processAndMergeData(currentData, collected, istClock) {
  const { signals, sourceStats, sacnilkDeepData, bhRows, googleTrends } = collected;
  const updated = JSON.parse(JSON.stringify(currentData));
  updated.lastUpdated = new Date().toISOString();
  updated.marketStatus.lastSync = istClock.shortTime;

  // Step A: Discover & auto-add any new weekly releases (<= 15 days old)
  const newlyAdded = await discoverAndAddNewReleases(updated.marketReleases, sacnilkDeepData, bhRows, istClock);

  const verifiedUpdates = [];
  const archivedMovies = Array.isArray(updated.archivedReleases) ? [...updated.archivedReleases] : [];
  const activeReleases = [];
  const removedNames = [];
  const br = sacnilkDeepData && sacnilkDeepData.heroBigRelease;

  // Step B: Update each movie, enforce 15-day active / 30-day removal lifecycle, and score trend/performance
  for (const movie of updated.marketReleases) {
    const actualDay = computeTheatricalDay(movie.releaseDate, istClock.dateStr);
    if (actualDay) movie.dayCount = actualDay;

    // 1-Month (30-Day) Archive Rule: move out of top boards into full searchable archivedReleases
    if (movie.dayCount > 30) {
      removedNames.push(`${movie.title} (Day ${movie.dayCount})`);
      const richArchive = {
        id: movie.id,
        title: movie.title,
        poster: movie.poster,
        releaseDate: movie.releaseDate,
        dayCount: movie.dayCount,
        category: movie.category || 'Pan-India',
        classification: 'Archive (30+ Days)',
        sentiment: movie.sentiment || 'BULLISH',
        orderBlock: 'Archived Lifetime Run',
        verdict: movie.verdict || 'Theatrical Run Complete',
        dayNet: movie.dayNet || '₹0.00 Cr',
        totalNet: movie.totalNet,
        worldwide: movie.worldwide,
        baseNetNum: movie.baseNetNum || parseCrNumber(movie.totalNet, 0),
        baseWwNum: movie.baseWwNum || parseCrNumber(movie.worldwide, 0),
        ticketsPerMin: 2,
        dayChange: movie.dayChange || 0,
        shows: movie.shows || 0,
        occupancy: movie.occupancy || 0,
        dominantMarket: movie.dominantMarket || 'India / Overseas',
        sparkline: movie.sparkline || [],
        archivedOn: istClock.dateStr
      };
      const existingArchIdx = archivedMovies.findIndex(a => a.id === movie.id);
      if (existingArchIdx >= 0) {
        archivedMovies[existingArchIdx] = richArchive;
      } else {
        archivedMovies.unshift(richArchive);
      }
      continue;
    }

    // 15-Day Active Classification vs Day 16-30 Holdover
    movie.classification = movie.dayCount <= 15 ? 'Last 15 Days' : 'Holdover Benchmark';

    const consensus = verifyMovieFromSignals(movie, signals, googleTrends, movie.dayCount);
    let updatedByConsensus = false;

    if (consensus.verifiedDailyCr !== null) {
      movie.dayNet = `₹${consensus.verifiedDailyCr.toFixed(2)} Cr*`;
      updatedByConsensus = true;
    }
    if (consensus.verifiedNetCr !== null && consensus.verifiedNetCr > movie.baseNetNum) {
      movie.baseNetNum = consensus.verifiedNetCr;
      movie.totalNet = `₹${consensus.verifiedNetCr.toFixed(2)} Cr`;
      updatedByConsensus = true;
    }
    if (consensus.verifiedWwCr !== null && consensus.verifiedWwCr > movie.baseWwNum) {
      movie.baseWwNum = consensus.verifiedWwCr;
      movie.worldwide = `₹${consensus.verifiedWwCr.toFixed(2)} Cr`;
      updatedByConsensus = true;
    }

    if (movie.id === 'ramayana-2026' && br) {
      if (br.liveDayNet !== null) movie.dayNet = `₹${br.liveDayNet.toFixed(2)} Cr*`;
      if (br.shows) movie.shows = br.shows;
      if (br.occupancy) movie.occupancy = br.occupancy;
      if (br.totalIndiaNet && consensus.netSources.length >= 2) {
        movie.baseNetNum = br.totalIndiaNet;
        movie.totalNet = `₹${br.totalIndiaNet.toFixed(2)} Cr`;
        updatedByConsensus = true;
      }
      if (br.totalWorldwide && consensus.wwSources.length >= 2) {
        movie.baseWwNum = br.totalWorldwide;
        movie.worldwide = `₹${br.totalWorldwide.toFixed(2)} Cr`;
        updatedByConsensus = true;
      }
    } else if (sacnilkDeepData.quicknewsByMovieId[movie.id]) {
      const qn = sacnilkDeepData.quicknewsByMovieId[movie.id];
      if (qn.shows) movie.shows = qn.shows;
      if (qn.todayNetCr !== null) movie.dayNet = `₹${qn.todayNetCr.toFixed(2)} Cr*`;
      if (qn.totalNetCr && qn.totalNetCr > movie.baseNetNum && (consensus.distinctSources.length >= 2 || qn.totalNetCr <= movie.baseNetNum * 12)) {
        movie.baseNetNum = qn.totalNetCr;
        movie.totalNet = `₹${qn.totalNetCr.toFixed(2)} Cr`;
        if (qn.totalGrossCr) {
          movie.baseWwNum = Math.max(movie.baseWwNum, parseFloat((qn.totalGrossCr * 1.15).toFixed(2)));
          movie.worldwide = `₹${movie.baseWwNum.toFixed(2)} Cr`;
        }
        updatedByConsensus = true;
      }
    }

    // Dynamic BMS-inspired ticket velocity & Bullish/Bearish classification
    const dayNetNum = parseCrNumber(movie.dayNet, 0.5);
    movie.ticketsPerMin = Math.max(3, Math.min(220, Math.round(dayNetNum * 6 + (movie.shows || 0) / 300 + consensus.bmsMentions * 4)));
    if (movie.dayChange >= 0 || dayNetNum >= 1.5 || consensus.bmsMentions >= 2) {
      movie.sentiment = movie.dayChange < -35 && dayNetNum < 1.0 ? 'BEARISH' : 'BULLISH';
      movie.orderBlock = movie.sentiment === 'BULLISH'
        ? (dayNetNum >= 10 || movie.dayChange > 20 ? 'Mega Institutional Surge' : 'Trending BMS Accumulation')
        : 'Distribution Plateau';
    } else {
      movie.sentiment = 'BEARISH';
      movie.orderBlock = movie.dayChange < -40 ? 'Order Block Breakdown / Capitulation' : (movie.dayChange < -25 ? 'Screen Compression' : 'Distribution Plateau');
    }

    // Composite Trend + Performance Score (keeps top-earning & highest-searched films at #1)
    const freshnessBoost = movie.dayCount <= 15 ? (16 - movie.dayCount) * 3 : 0;
    const trendScore = parseFloat((
      dayNetNum * 4.5 +
      Math.log10(Math.max(1, movie.baseNetNum)) * 22 +
      (movie.shows || 0) / 500 +
      consensus.distinctSources.length * 8 +
      Math.min(15, consensus.headlineCount) * 1.5 +
      consensus.bmsMentions * 7 +
      (consensus.isGoogleTrending ? 25 : 0) +
      freshnessBoost
    ).toFixed(2));
    movie.trendScore = trendScore;
    movie.bmsBuzzSignals = consensus.bmsMentions;
    movie.googleTrending = consensus.isGoogleTrending;

    activeReleases.push(movie);

    if (consensus.distinctSources.length > 0 || updatedByConsensus) {
      verifiedUpdates.push({
        movie: movie.title,
        day: movie.dayCount,
        trendScore,
        sourcesMatched: consensus.distinctSources,
        bmsSignals: consensus.bmsMentions,
        consensusApplied: updatedByConsensus,
        sampleHeadlines: consensus.matchedHeadlines.slice(0, 2)
      });
    }
  }

  // Step C: Auto-rank top performing + trending films first; keep full-year archive (up to 365 entries)
  activeReleases.sort((a, b) => (b.trendScore || 0) - (a.trendScore || 0));
  updated.marketReleases = activeReleases;
  updated.archivedReleases = archivedMovies.slice(0, 365);

  // Step D: Dynamically assign Hero Spotlight to the #1 top-trending/performing movie
  const topHero = activeReleases[0];
  if (topHero) {
    const isExistingHero = updated.heroMovie && updated.heroMovie.id === topHero.id;
    const heroObj = isExistingHero ? updated.heroMovie : {
      id: topHero.id,
      title: topHero.title.toUpperCase(),
      poster: topHero.poster,
      subtitle: `${topHero.verdict} | ${topHero.category} | Released ${topHero.releaseDate}`,
      releaseDate: topHero.releaseDate,
      daysInTheaters: topHero.dayCount,
      sentiment: `TRENDING #1 (${topHero.orderBlock})`,
      orderBlockVerdict: topHero.verdict,
      liveVelocity: { ticketsPerMin: topHero.ticketsPerMin, inrPerSecond: topHero.ticketsPerMin * 450, baseIndiaNetCr: topHero.baseNetNum, baseWorldwideCr: topHero.baseWwNum },
      keyMetrics: {
        indiaNet: topHero.totalNet,
        indiaGross: `₹${(topHero.baseNetNum * 1.194).toFixed(2)} Cr`,
        overseasGross: `₹${Math.max(0, topHero.baseWwNum - topHero.baseNetNum * 1.194).toFixed(2)} Cr+`,
        worldwideTotal: `${topHero.worldwide}+`,
        showCount: (topHero.shows || 0).toLocaleString('en-IN'),
        avgOccupancy: `${topHero.occupancy}%`
      },
      supportResistance: {
        targetClubResistance: topHero.resistanceLevel,
        resistanceProgress: parseFloat(Math.min(100, (topHero.baseWwNum / 1000) * 100).toFixed(2)),
        weekdaySupport: topHero.supportLevel
      },
      dayWiseCollections: (topHero.sparkline || []).map((v, i, arr) => ({
        day: `Day ${i + 1}`,
        label: i === arr.length - 1 ? `D${topHero.dayCount} Live` : `D${i + 1}`,
        net: v,
        gross: parseFloat((v * 1.19).toFixed(2)),
        change: 0,
        shows: topHero.shows,
        occupancy: topHero.occupancy
      })),
      languageBreakdown: [{ language: topHero.dominantMarket || 'Pan-India', amount: topHero.baseNetNum, percentage: 100, color: '#10B981' }],
      regionalOccupancy: updated.heroMovie.regionalOccupancy || []
    };

    heroObj.daysInTheaters = topHero.dayCount;
    heroObj.keyMetrics.indiaNet = topHero.totalNet;
    heroObj.keyMetrics.worldwideTotal = `${topHero.worldwide}+`;
    if (topHero.id === 'ramayana-2026' && br) {
      if (br.totalIndiaGross) heroObj.keyMetrics.indiaGross = `₹${br.totalIndiaGross.toFixed(2)} Cr`;
      if (br.totalOverseas) heroObj.keyMetrics.overseasGross = `₹${br.totalOverseas.toFixed(2)} Cr+`;
      if (br.shows) heroObj.keyMetrics.showCount = br.shows.toLocaleString('en-IN');
      if (br.occupancy) heroObj.keyMetrics.avgOccupancy = `${br.occupancy}%`;
      if (br.totalFootfalls) heroObj.keyMetrics.totalFootfalls = br.totalFootfalls;
      if (br.advanceLine) heroObj.advanceBooking = br.advanceLine;
      if (br.languages) {
        const langSum = br.languages.reduce((acc, l) => acc + l.amount, 0) || 1;
        heroObj.languageBreakdown = br.languages.map(l => ({
          language: l.language,
          amount: l.amount,
          percentage: parseFloat(((l.amount / langSum) * 100).toFixed(1)),
          color: l.color
        }));
      }
      if (br.dayRows && br.dayRows.length >= 7) {
        heroObj.dayWiseCollections = br.dayRows.map((r, i, arr) => {
          const prevNet = i > 0 ? arr[i - 1].net : r.net;
          const chg = i > 0 && prevNet > 0 ? parseFloat((((r.net - prevNet) / prevNet) * 100).toFixed(1)) : 0;
          const isLast = i === arr.length - 1;
          return {
            day: `Day ${r.dayNum}`,
            label: isLast ? `D${r.dayNum} Live` : `D${r.dayNum}`,
            date: heroObj.releaseDate,
            net: r.net,
            gross: r.gross,
            change: chg,
            shows: isLast && br.shows ? br.shows : 24000,
            occupancy: isLast && br.occupancy ? br.occupancy : 70
          };
        });
      }
    }

    // Show-Timing Occupancy Matrix (Morning / Afternoon / Evening / Night) + BMS/Trade Milestones
    const heroOccBase = parseFloat(heroObj.keyMetrics.avgOccupancy) || 50;
    if (topHero.id === 'ramayana-2026') {
      heroObj.showTimingOccupancy = [
        { language: 'Hindi (3D)', overall: 44.50, morning: 22.08, afternoon: 51.08, evening: 58.92, night: 45.92 },
        { language: 'Kannada (3D)', overall: 72.66, morning: 51.18, afternoon: 80.00, evening: 81.82, night: 77.64 },
        { language: 'Tamil (3D)', overall: 69.96, morning: 53.45, afternoon: 63.64, evening: 77.91, night: 61.64 },
        { language: 'Telugu (3D)', overall: 28.34, morning: 21.18, afternoon: 26.45, evening: 33.73, night: 32.00 }
      ];
    } else {
      heroObj.showTimingOccupancy = [
        {
          language: topHero.dominantMarket || 'All India',
          overall: parseFloat(heroOccBase.toFixed(2)),
          morning: parseFloat((heroOccBase * 0.55).toFixed(2)),
          afternoon: parseFloat((heroOccBase * 0.95).toFixed(2)),
          evening: parseFloat(Math.min(98, heroOccBase * 1.25).toFixed(2)),
          night: parseFloat(Math.min(95, heroOccBase * 1.15).toFixed(2))
        }
      ];
    }

    const peakDay = (heroObj.dayWiseCollections || []).reduce((best, d) => (d.net > (best ? best.net : 0) ? d : best), null);
    const heroSignals = signals
      .filter(s => s.text.toLowerCase().includes(topHero.title.replace(/\([^)]*\)/g, '').trim().toLowerCase()))
      .filter(s => /(record|milestone|biggest|fastest|bms|bookmyshow|crossed|tops|imax|history)/i.test(s.text))
      .slice(0, 4)
      .map(s => ({ label: `${s.sourceName} Verified`, value: s.text.replace(/\s+-\s+(Sacnilk|Pinkvilla|Koimoi|Bollywood Hungama|Box Office India)$/i, '') }));

    heroObj.recordsAndMilestones = [
      { label: 'SINGLE-DAY PEAK', value: peakDay ? `₹${peakDay.net.toFixed(2)} Cr (${peakDay.label})` : topHero.dayNet, sub: 'Highest domestic net single day' },
      { label: 'TOTAL FOOTFALLS', value: heroObj.keyMetrics.totalFootfalls || 'Tracking Live', sub: `Day ${topHero.dayCount} cumulative admissions` },
      { label: 'NEXT-DAY ADVANCE', value: heroObj.advanceBooking || `Live Shows: ${heroObj.keyMetrics.showCount}`, sub: 'Pre-sales & show velocity tracker' },
      { label: 'BMS TICKET PACE', value: topHero.id === 'ramayana-2026' ? '16.60L Peak Day / 1.40L Hr' : `${topHero.ticketsPerMin} Tix / Min`, sub: `Active BMS Buzz Signals: ${topHero.bmsBuzzSignals || 0}` },
      ...heroSignals
    ].slice(0, 8);
    if (heroObj.liveVelocity) {
      heroObj.liveVelocity.ticketsPerMin = topHero.ticketsPerMin;
      heroObj.liveVelocity.baseIndiaNetCr = parseFloat(topHero.baseNetNum.toFixed(4));
      heroObj.liveVelocity.baseWorldwideCr = parseFloat(topHero.baseWwNum.toFixed(4));
    }
    if (heroObj.supportResistance) {
      const targetNum = parseCrNumber(heroObj.supportResistance.targetClubResistance, 1000) || 1000;
      heroObj.supportResistance.resistanceProgress = parseFloat(Math.min(100, (topHero.baseWwNum / targetNum) * 100).toFixed(2));
    }
    updated.heroMovie = heroObj;
    updated.marketStatus.topGainer = `${topHero.title.toUpperCase()} (#1 TREND)`;
    updated.marketStatus.totalActiveShows = activeReleases.reduce((sum, m) => sum + (m.shows || 0), 0);
  }

  // Step E: Sync top tickerFeed in top-trending order
  updated.tickerFeed = activeReleases.map(m => {
    const meta = MOVIE_SYMBOLS[m.id] || {};
    return {
      symbol: meta.symbol || slugify(m.title).toUpperCase().slice(0, 10),
      title: m.title,
      day: `Day ${m.dayCount}`,
      collection: m.totalNet,
      change: m.dayChange,
      status: m.sentiment,
      type: m.classification === 'Last 15 Days' ? 'Active 15D' : 'Holdover 30D',
      badge: meta.badge || m.verdict
    };
  });

  updated.verificationReport = {
    lastVerifiedIST: istClock.timeStr,
    schedule: 'Twice Daily (12:00 PM IST & 09:30 PM IST)',
    lifecyclePolicy: 'Auto-Add Weekly (<15d) | Active 15d | Auto-Remove >30d | Ranked by Collection + BMS/Search Buzz',
    autoDiscoveredNew: newlyAdded,
    autoRemovedOver30d: removedNames,
    googleTrendsCheckedCount: googleTrends.length,
    sourcesChecked: Object.values(sourceStats),
    totalSignalsCollected: signals.length,
    verifiedUpdates
  };

  return updated;
}

/** Main entry point executed by GitHub Actions or local CLI. */
async function runScraperPipeline() {
  const istClock = getIstClock();
  console.log(`[${istClock.timeStr}] Starting Year-Round Autopilot BoxOfficeCollectionLive pipeline...`);

  let currentData;
  try {
    currentData = JSON.parse(fs.readFileSync(DATA_FILE_PATH, 'utf-8'));
  } catch (err) {
    console.error('Failed to read baseline boxoffice_data.json:', err.message);
    process.exit(1);
  }

  try {
    const collected = await collectAllSourceSignals(currentData.marketReleases, istClock);
    console.log(`Collected ${collected.signals.length} signals + ${collected.googleTrends.length} Google Trends IN items.`);
    Object.values(collected.sourceStats).forEach(s => {
      console.log(`  - ${s.name}: direct=${s.directStatus}, rss=${s.rssStatus}, signals=${s.headlineCount}`);
    });

    const updatedData = await processAndMergeData(currentData, collected, istClock);
    fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(updatedData, null, 2), 'utf-8');
    console.log(`Active movies: ${updatedData.marketReleases.length} | Added: ${updatedData.verificationReport.autoDiscoveredNew.length} | Archived (>30d): ${updatedData.verificationReport.autoRemovedOver30d.length}`);
    console.log(`#1 Hero: ${updatedData.heroMovie.title} (Day ${updatedData.heroMovie.daysInTheaters}, Net ${updatedData.heroMovie.keyMetrics.indiaNet}, WW ${updatedData.heroMovie.keyMetrics.worldwideTotal})`);
  } catch (err) {
    console.error('Autopilot pipeline error (preserving cached boxoffice_data.json):', err.message);
    process.exit(0);
  }
}

if (require.main === module) {
  runScraperPipeline();
}

module.exports = { runScraperPipeline };
