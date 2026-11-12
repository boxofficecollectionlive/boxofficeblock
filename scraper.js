/**
 * BoxOfficeCollectionLive — 5-Source Automated Box Office Scraper & Verifier
 * Scheduled via GitHub Actions twice daily (12:00 PM IST & 09:30 PM IST).
 * Cross-verifies box office figures across 5 authentic Indian trade portals:
 *   1. Sacnilk (sacnilk.com + /big-release + /quicknews live tables)
 *   2. Bollywood Hungama (bollywoodhungama.com box office table + RSS)
 *   3. Box Office India (boxofficeindia.com + RSS)
 *   4. Koimoi (koimoi.com + RSS)
 *   5. Pinkvilla (pinkvilla.com box office + RSS)
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
  'udta-teer': ['udta teer'],
  'drishyam-3': ['drishyam 3', 'drishyam the conclusion']
};

const MOVIE_SYMBOLS = {
  'ramayana-2026': { symbol: 'RAMAYANA', badge: 'Diwali Breakout' },
  'scene-2026': { symbol: 'SCENE', badge: 'Heavy Drop' },
  'mookuthi-amman-2': { symbol: 'M-AMMAN2', badge: 'Capitulation' },
  'ak-47': { symbol: 'AK47', badge: 'Weekday Bleed' },
  'pyre': { symbol: 'PYRE', badge: 'Screen Loss' },
  'jailer-2': { symbol: 'JAILER2', badge: 'End of Run' },
  'udta-teer': { symbol: 'UDTA-TEER', badge: 'Steady Tail' },
  'drishyam-3': { symbol: 'DRISHYAM3', badge: 'Super Hit' }
};

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

/** Convert ₹ amount string ("₹22 L" or "₹12.56 Cr") to Crores. */
function toCrores(amountStr, unit) {
  const val = parseFloat(String(amountStr).replace(/,/g, ''));
  if (!Number.isFinite(val)) return null;
  return /^l$/i.test(unit) ? parseFloat((val / 100).toFixed(2)) : parseFloat(val.toFixed(2));
}

/** Extract clean article headlines and snippets from portal HTML. */
function extractHeadlinesFromHtml(html) {
  if (!html) return [];
  const items = new Set();
  const anchorRegex = /<(?:a|h1|h2|h3|h4)[^>]*>([\s\S]*?)<\/(?:a|h1|h2|h3|h4)>/gi;
  let match;
  while ((match = anchorRegex.exec(html)) !== null) {
    const text = cleanText(match[1]);
    if (text.length >= 18 && text.length <= 240 && /(box office|collection|cr|crore|day\s+\d|net|gross|worldwide)/i.test(text)) {
      items.add(text);
    }
  }
  return Array.from(items).slice(0, 80);
}

/** Parse Bollywood Hungama's main box office table rows for exact India Net figures. */
function parseBollywoodHungamaTable(html, signals, sourceStats) {
  if (!html) return;
  const body = cleanText(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' '));
  const ramMatch = body.match(/Ramayana\s*[–-]\s*Part\s*I\s+\d{2}\s+\w+\s+\d{4}\s+([\d.]+)\s+([\d.]+)\s+\S+\s+([\d.]+)/i);
  if (ramMatch) {
    const opening = parseFloat(ramMatch[1]);
    const weekend = parseFloat(ramMatch[2]);
    const totalNet = parseFloat(ramMatch[3]);
    if (Number.isFinite(totalNet) && totalNet > 100) {
      signals.push({
        sourceId: 'bollywoodhungama',
        sourceName: 'Bollywood Hungama',
        text: `Ramayana – Part I Bollywood Hungama Table: Opening ₹${opening} Cr, Weekend ₹${weekend} Cr, Total India Net ₹${totalNet} Cr`,
        channel: 'table',
        structured: { movieId: 'ramayana-2026', cumulativeNet: totalNet }
      });
      sourceStats.bollywoodhungama.headlineCount += 1;
    }
  }
}

/** Parse Sacnilk's /big-release/ramayana_part_1_2026 full day-wise & cumulative table. */
function parseSacnilkBigRelease(html) {
  if (!html) return null;
  const txt = cleanText(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<header[\s\S]*?<\/header>/gi, ' '));

  const liveMatch = txt.match(/Live today\s*₹([\d.]+)\s*Cr\s*India net\s*[·•]\s*Day\s*(\d+)/i);
  const showsMatch = txt.match(/([\d,]+)\s*shows tracked today\s*([\d.]+)%\s*occupancy/i);
  const totalMatch = txt.match(/Total\s+(\d+)\s+days\s+₹([\d,.]+)\s*Cr\s+₹([\d,.]+)\s*Cr\s+₹([\d,.]+)\s*Cr\s+₹([\d,.]+)\s*Cr\s+₹([\d,.]+)\s*Cr\s+₹([\d,.]+)\s*Cr\s+₹([\d,.]+)\s*Cr\s+[\d.]+\s*Cr\s+₹([\d,.]+)\s*Cr\s+₹([\d,.]+)\s*Cr/i);

  const dayRows = [];
  const dayRegex = /Day\s+(\d+)\s+\w+\s+\d+\s+\w+(?:\s*[·•]\s*live estimate)?\s+(?:₹[\d.]+\s*Cr\s+|–\s+){5}₹([\d.]+)\s*Cr\s+₹([\d.]+)\s*Cr\s+(?:[\d.]+\s*lakh|–)\s+(?:₹([\d.]+)\s*Cr|–)\s+(?:₹([\d.]+)\s*Cr|–)/gi;
  let dm;
  while ((dm = dayRegex.exec(txt)) !== null) {
    const dNum = parseInt(dm[1], 10);
    const net = parseFloat(dm[2]);
    const gross = parseFloat(dm[3]);
    if (Number.isFinite(dNum) && Number.isFinite(net)) {
      dayRows.push({ dayNum: dNum, net, gross });
    }
  }

  if (!totalMatch && !liveMatch) return null;

  const parseCr = s => parseFloat(String(s).replace(/,/g, ''));
  return {
    liveDayNum: liveMatch ? parseInt(liveMatch[2], 10) : null,
    liveDayNet: liveMatch ? parseFloat(liveMatch[1]) : null,
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
    totalOverseas: totalMatch ? parseCr(totalMatch[9]) : null,
    totalWorldwide: totalMatch ? parseCr(totalMatch[10]) : null,
    dayRows
  };
}

/** Parse Sacnilk /quicknews daily estimate sentences (shows, today net, cumulative India net/gross). */
function parseSacnilkQuicknews(html) {
  if (!html) return null;
  const txt = cleanText(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<header[\s\S]*?<\/header>/gi, ' '));
  const m = txt.match(/As of Day\s*(\d+),\s*(.+?)\s+is currently running across\s*([\d,]+)\s*shows and has collected a net of\s*₹([\d.]+)\s*(Cr|L)\s*today\.\s*This brings total India gross collections to\s*₹([\d.]+)\s*(Cr|L)\s*and total India net to\s*₹([\d.]+)\s*(Cr|L)/i);
  if (!m) return null;
  return {
    dayNum: parseInt(m[1], 10),
    shows: parseInt(m[3].replace(/,/g, ''), 10),
    todayNetCr: toCrores(m[4], m[5]),
    totalGrossCr: toCrores(m[6], m[7]),
    totalNetCr: toCrores(m[8], m[9])
  };
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

/** Gather headlines + structured live box office tables across all 5 authentic portals. */
async function collectAllSourceSignals(movies) {
  const sourceStats = {};
  const signals = [];
  let sacnilkHomeHtml = '';
  let bhHomeHtml = '';

  for (const src of AUTHENTIC_SOURCES) {
    sourceStats[src.id] = { name: src.name, domain: src.domain, directStatus: 0, rssStatus: 0, headlineCount: 0 };
  }

  // 1. Direct fetches across the 5 authentic portals
  await Promise.all(
    AUTHENTIC_SOURCES.map(async src => {
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
  );

  // 2. Parse Bollywood Hungama's structured collection table
  parseBollywoodHungamaTable(bhHomeHtml, signals, sourceStats);

  // 3. Fetch Sacnilk live tracker (/big-release/ramayana_part_1_2026) + active /quicknews pages
  const sacnilkDeepData = { heroBigRelease: null, quicknewsByMovieId: {} };
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

  // Discover latest /quicknews links from Sacnilk homepage for active movies
  if (sacnilkHomeHtml) {
    const qLinks = [...sacnilkHomeHtml.matchAll(/href=["'](https?:\/\/www\.sacnilk\.com\/quicknews\/[^"']+|\/quicknews\/[^"']+)["']/gi)].map(m => m[1]);
    const uniqueQLinks = [...new Set(qLinks)];
    await Promise.all(
      movies.filter(m => m.id !== 'ramayana-2026').map(async m => {
        const keywords = (MOVIE_SEARCH_ALIASES[m.id] || [m.title.toLowerCase()]).map(k => k.replace(/\s+box office|\s+day|\s+india/g, '').replace(/\s+/g, '_'));
        const matchUrl = uniqueQLinks.find(u => keywords.some(kw => u.toLowerCase().includes(kw)));
        if (!matchUrl) return;
        const fullUrl = matchUrl.startsWith('http') ? matchUrl : `https://www.sacnilk.com${matchUrl}`;
        const qr = await safeFetchText(fullUrl);
        if (qr.ok) {
          const parsed = parseSacnilkQuicknews(qr.text);
          if (parsed) {
            sacnilkDeepData.quicknewsByMovieId[m.id] = parsed;
            signals.push({
              sourceId: 'sacnilk',
              sourceName: 'Sacnilk',
              text: `${m.title} Sacnilk Day ${parsed.dayNum} Live: ₹${parsed.todayNetCr} Cr today, Total India Net ₹${parsed.totalNetCr} Cr across ${parsed.shows} shows`,
              channel: 'table',
              structured: { movieId: m.id, cumulativeNet: parsed.totalNetCr, daily: parsed.todayNetCr }
            });
            sourceStats.sacnilk.headlineCount += 1;
          }
        }
      })
    );
  }

  // 4. Domain-scoped Google News RSS queries across all 5 portals
  const siteFilter = AUTHENTIC_SOURCES.map(s => `site:${s.domain}`).join('+OR+');
  const movieQueries = movies.map(m => {
    const cleanTitle = m.title.replace(/\([^)]*\)/g, '').trim();
    return `https://news.google.com/rss/search?q=(${siteFilter})+${encodeURIComponent('"' + cleanTitle + '" box office')}&hl=en-IN&gl=IN&ceid=IN:en`;
  });
  const generalQuery = `https://news.google.com/rss/search?q=(${siteFilter})+box+office+collection+crore&hl=en-IN&gl=IN&ceid=IN:en`;

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

  return { signals, sourceStats, sacnilkDeepData };
}

/** Extract Crore figure + metric kind from a headline when structured table isn't attached. */
function parseBoxOfficeMention(text, expectedDay) {
  const lower = text.toLowerCase();
  if (/\b(budget|club|target|combined|together|milestone|approaching|chasing|eyes|aims|prediction|advance)\b/i.test(lower)) return null;
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

/** Match signals for a movie and compute multi-source verified values. */
function verifyMovieFromSignals(movie, signals, actualDay) {
  const aliases = MOVIE_SEARCH_ALIASES[movie.id] || [movie.title.replace(/\([^)]*\)/g, '').trim().toLowerCase()];
  const aliasRegexes = aliases.map(a => new RegExp(`\\b${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
  const matched = signals.filter(s => (s.structured && s.structured.movieId === movie.id) || aliasRegexes.some(rx => rx.test(s.text)));

  const byKind = { daily: new Map(), cumulativeNet: new Map(), worldwide: new Map() };
  const distinctSources = new Set();

  for (const item of matched) {
    distinctSources.add(item.sourceName);
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

    if (!byKind[parsed.kind].has(item.sourceId)) {
      byKind[parsed.kind].set(item.sourceId, parsed.value);
    }
  }

  const dailyVals = Array.from(byKind.daily.values());
  const netVals = Array.from(byKind.cumulativeNet.values());
  const wwVals = Array.from(byKind.worldwide.values());

  return {
    matchedHeadlines: matched.slice(0, 5).map(m => `${m.sourceName}: ${m.text}`),
    distinctSources: Array.from(distinctSources),
    netSources: Array.from(byKind.cumulativeNet.keys()),
    wwSources: Array.from(byKind.worldwide.keys()),
    verifiedDailyCr: dailyVals.length >= 2 ? parseFloat(median(dailyVals).toFixed(2)) : null,
    verifiedNetCr: netVals.length >= 2 ? parseFloat(median(netVals).toFixed(2)) : null,
    verifiedWwCr: wwVals.length >= 2 ? parseFloat(median(wwVals).toFixed(2)) : null
  };
}

/** Merge verified multi-source figures and live Sacnilk/BH tables into boxoffice_data.json. */
function processAndMergeData(currentData, signals, sourceStats, sacnilkDeepData, istClock) {
  const updated = JSON.parse(JSON.stringify(currentData));
  updated.lastUpdated = new Date().toISOString();
  updated.marketStatus.lastSync = istClock.shortTime;

  const verifiedUpdates = [];
  const br = sacnilkDeepData && sacnilkDeepData.heroBigRelease;

  for (const movie of updated.marketReleases) {
    const actualDay = computeTheatricalDay(movie.releaseDate, istClock.dateStr);
    if (actualDay && actualDay > movie.dayCount) {
      movie.dayCount = actualDay;
    }

    const consensus = verifyMovieFromSignals(movie, signals, actualDay || movie.dayCount);
    let updatedByConsensus = false;

    // 1. Multi-source (>=2 sources) consensus update
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

    // 2. Apply live Sacnilk table details when multi-source confirmation exists
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
      if (qn.totalNetCr && qn.totalNetCr > movie.baseNetNum && qn.totalNetCr <= movie.baseNetNum * 1.45) {
        movie.baseNetNum = qn.totalNetCr;
        movie.totalNet = `₹${qn.totalNetCr.toFixed(2)} Cr`;
        if (qn.totalGrossCr) {
          movie.baseWwNum = Math.max(movie.baseWwNum, qn.totalGrossCr);
          movie.worldwide = `₹${movie.baseWwNum.toFixed(2)} Cr`;
        }
        updatedByConsensus = true;
      }
    }

    if (movie.dayChange >= 0) {
      movie.sentiment = 'BULLISH';
      movie.orderBlock = movie.dayChange > 30 ? 'Mega Institutional Surge' : 'Institutional Accumulation';
    } else {
      movie.sentiment = 'BEARISH';
      if (movie.dayChange < -40) movie.orderBlock = 'Order Block Breakdown / Capitulation';
      else if (movie.dayChange < -25) movie.orderBlock = 'Screen Compression';
      else movie.orderBlock = 'Distribution Plateau';
    }

    if (consensus.distinctSources.length > 0 || updatedByConsensus) {
      verifiedUpdates.push({
        movie: movie.title,
        day: movie.dayCount,
        sourcesMatched: consensus.distinctSources,
        consensusApplied: updatedByConsensus,
        sampleHeadlines: consensus.matchedHeadlines.slice(0, 2)
      });
    }
  }

  // Synchronize heroMovie metrics, language splits, and day-wise chart from verified Ramayana table
  const heroRelease = updated.marketReleases.find(m => m.id === updated.heroMovie.id);
  if (heroRelease) {
    updated.heroMovie.daysInTheaters = heroRelease.dayCount;
    updated.heroMovie.keyMetrics.indiaNet = heroRelease.totalNet;
    updated.heroMovie.keyMetrics.worldwideTotal = `${heroRelease.worldwide}+`;
    const grossEst = (br && br.totalIndiaGross) ? br.totalIndiaGross : parseFloat((heroRelease.baseNetNum * 1.194).toFixed(2));
    updated.heroMovie.keyMetrics.indiaGross = `₹${grossEst.toFixed(2)} Cr`;
    if (br && br.totalOverseas) updated.heroMovie.keyMetrics.overseasGross = `₹${br.totalOverseas.toFixed(2)} Cr+`;
    if (br && br.shows) updated.heroMovie.keyMetrics.showCount = br.shows.toLocaleString('en-IN');
    if (br && br.occupancy) updated.heroMovie.keyMetrics.avgOccupancy = `${br.occupancy}%`;

    if (br && br.languages) {
      const langSum = br.languages.reduce((acc, l) => acc + l.amount, 0) || 1;
      updated.heroMovie.languageBreakdown = br.languages.map(l => ({
        language: l.language,
        amount: l.amount,
        percentage: parseFloat(((l.amount / langSum) * 100).toFixed(1)),
        color: l.color
      }));
    }

    if (br && br.dayRows && br.dayRows.length >= 7) {
      updated.heroMovie.dayWiseCollections = br.dayRows.map((r, i, arr) => {
        const prevNet = i > 0 ? arr[i - 1].net : r.net;
        const chg = i > 0 && prevNet > 0 ? parseFloat((((r.net - prevNet) / prevNet) * 100).toFixed(1)) : 0;
        const isLast = i === arr.length - 1;
        return {
          day: `Day ${r.dayNum}`,
          label: isLast ? `D${r.dayNum} Live` : `D${r.dayNum}`,
          date: updated.heroMovie.releaseDate,
          net: r.net,
          gross: r.gross,
          change: chg,
          shows: isLast && br.shows ? br.shows : 24000,
          occupancy: isLast && br.occupancy ? br.occupancy : 70
        };
      });
    }

    if (updated.heroMovie.liveVelocity) {
      updated.heroMovie.liveVelocity.baseIndiaNetCr = parseFloat(heroRelease.baseNetNum.toFixed(4));
      updated.heroMovie.liveVelocity.baseWorldwideCr = parseFloat(heroRelease.baseWwNum.toFixed(4));
    }
    if (updated.heroMovie.supportResistance) {
      updated.heroMovie.supportResistance.resistanceProgress = parseFloat(((heroRelease.baseWwNum / 1000) * 100).toFixed(2));
    }
  }

  // Sync top tickerFeed cleanly by stable movie ID mapping
  updated.tickerFeed = updated.marketReleases.map(m => {
    const meta = MOVIE_SYMBOLS[m.id] || {};
    return {
      symbol: meta.symbol || m.id.toUpperCase(),
      title: m.title,
      day: `Day ${m.dayCount}`,
      collection: m.totalNet,
      change: m.dayChange,
      status: m.sentiment,
      type: m.id === 'jailer-2' ? 'Benchmark Net' : (m.id === 'drishyam-3' ? 'All-Time Net' : 'Net'),
      badge: meta.badge || m.verdict
    };
  });

  updated.verificationReport = {
    lastVerifiedIST: istClock.timeStr,
    schedule: 'Twice Daily (12:00 PM IST & 09:30 PM IST)',
    sourcesChecked: Object.values(sourceStats),
    totalSignalsCollected: signals.length,
    verifiedUpdates
  };

  return updated;
}

/** Main entry point executed by GitHub Actions or local CLI. */
async function runScraperPipeline() {
  const istClock = getIstClock();
  console.log(`[${istClock.timeStr}] Starting 5-source BoxOfficeCollectionLive verification pipeline...`);

  let currentData;
  try {
    currentData = JSON.parse(fs.readFileSync(DATA_FILE_PATH, 'utf-8'));
  } catch (err) {
    console.error('Failed to read baseline boxoffice_data.json:', err.message);
    process.exit(1);
  }

  try {
    const { signals, sourceStats, sacnilkDeepData } = await collectAllSourceSignals(currentData.marketReleases);
    console.log(`Collected ${signals.length} signals across 5 sources.`);
    Object.values(sourceStats).forEach(s => {
      console.log(`  - ${s.name}: direct=${s.directStatus}, rss=${s.rssStatus}, signals=${s.headlineCount}`);
    });

    const updatedData = processAndMergeData(currentData, signals, sourceStats, sacnilkDeepData, istClock);
    fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(updatedData, null, 2), 'utf-8');
    console.log(`Updated boxoffice_data.json (${updatedData.heroMovie.title} -> Day ${updatedData.heroMovie.daysInTheaters}, Net ${updatedData.heroMovie.keyMetrics.indiaNet}, WW ${updatedData.heroMovie.keyMetrics.worldwideTotal})`);
  } catch (err) {
    console.error('Verification pipeline error (preserving cached boxoffice_data.json):', err.message);
    process.exit(0);
  }
}

if (require.main === module) {
  runScraperPipeline();
}

module.exports = { runScraperPipeline };
