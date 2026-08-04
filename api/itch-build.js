// api/itch-build.js
// Returns the latest Among Us build info straight from Innersloth's itch.io
// page — version, upload id, timestamp, and a fresh (signed, expiring) direct
// download URL. Protected by a Bearer API key.
//
// Auth:  Authorization: Bearer <key>   (key(s) in API_KEYS, comma-separated)
// Secrets (Vercel env vars):
//   ITCH_URL           — the itch download page (default below)
//   ITCH_DOWNLOAD_KEY  — the game's download key
//   ITCH_COOKIES       — one Cookie header string: cf_clearance=...; itchio=...; itchio_token=...
//   API_KEYS           — "key1,key2"
//
// Response:
// {
//   "ok": true,
//   "upload_id": "123456",
//   "timestamp": "05 June 2026 @ 23:01 UTC",
//   "time_ago": "2 hours ago",
//   "version": "2026.6.5",
//   "download_url": "https://...cloudflare-signed...",
//   "checked_at": "2026-08-04T..."
// }

const DEFAULT_URL = 'https://innersloth.itch.io/among-us/download/qyosUvijZ_NJHO1PbXFa0fDpi0WxpCoHp5qWYQRP';

const HEADERS = (pageUrl, cookies) => ({
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:153.0) Gecko/20100101 Firefox/153.0',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': pageUrl,
  'Cookie': cookies,
});

function formatTimeAgo(rawTimestamp) {
  if (!rawTimestamp) return 'Unknown time ago';
  try {
    // "05 June 2026 @ 23:01 UTC"
    const m = rawTimestamp.replace(' UTC', '').replace(' @', '').match(/(\d+) (\w+) (\d{4}) (\d+):(\d+)/);
    if (m) {
      const months = { january:0, february:1, march:2, april:3, may:4, june:5, july:6, august:7, september:8, october:9, november:10, december:11 };
      const month = months[String(m[2]).toLowerCase()];
      if (month !== undefined) {
        const dt = new Date(Date.UTC(+m[3], month, +m[1], +m[4], +m[5]));
        const diffSec = Math.floor((Date.now() - dt.getTime()) / 1000);
        if (diffSec < 60)      return 'just now';
        if (diffSec < 3600)    return `${Math.floor(diffSec / 60)} minute${Math.floor(diffSec / 60) > 1 ? 's' : ''} ago`;
        if (diffSec < 86400)   return `${Math.floor(diffSec / 3600)} hour${Math.floor(diffSec / 3600) > 1 ? 's' : ''} ago`;
        return `${Math.floor(diffSec / 86400)} day${Math.floor(diffSec / 86400) > 1 ? 's' : ''} ago`;
      }
    }
  } catch (e) {}
  return rawTimestamp;
}

function extractUploadId(html) {
  const m = html.match(/download_btn[^>]*data-upload_id="(\d+)"/) || html.match(/data-upload_id="(\d+)"/);
  return m ? m[1] : null;
}

function extractVersion(html) {
  const m = html.match(/class="version_name"[^>]*>([\s\S]*?)<\/div>/);
  if (!m) return 'Unknown';
  return m[1]
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s*(?:just now|\d+\s*(?:second|minute|hour|day)s?\s+ago).*$/i, '')
    .trim() || 'Unknown';
}

function extractTimestamp(html) {
  const m = html.match(/version_date[^>]*>[\s\S]*?<abbr[^>]*title="([^"]+)"/);
  return m ? m[1] : null;
}

function extractCsrf(html) {
  const m = html.match(/name="csrf_token"[^>]*value="([^"]*)"/) || html.match(/value="([^"]*)"[^>]*name="csrf_token"/);
  return m ? m[1] : null;
}

async function getDownloadUrl(gameBase, uploadId, key, csrfToken, cookies) {
  const apiUrl = `${gameBase}/file/${uploadId}?source=game_download&key=${encodeURIComponent(key)}`;
  try {
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        ...HEADERS(`${gameBase}/download`, cookies),
        'X-Requested-With': 'XMLHttpRequest',
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      },
      body: csrfToken ? `csrf_token=${encodeURIComponent(csrfToken)}` : '',
    });
    if (res.ok) {
      const data = await res.json();
      return data.url || 'No URL found in JSON response';
    }
    return `HTTP Error ${res.status} while fetching link`;
  } catch (e) {
    return `Error fetching direct link: ${e.message}`;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const allowedKeys = (process.env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ') || !allowedKeys.includes(auth.slice(7).trim())) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Same data for every caller with a key — cache at the edge for 5 minutes
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  const pageUrl = process.env.ITCH_URL || DEFAULT_URL;
  const gameBase = pageUrl.split('/').slice(0, 4).join('/'); // https://innersloth.itch.io/among-us
  const key = process.env.ITCH_DOWNLOAD_KEY || '';
  const cookies = process.env.ITCH_COOKIES || '';

  if (!key) return res.status(500).json({ error: 'ITCH_DOWNLOAD_KEY not set' });
  if (!cookies) return res.status(500).json({ error: 'ITCH_COOKIES not set' });

  let html;
  try {
    const r = await fetch(pageUrl, { headers: HEADERS(pageUrl, cookies) });
    if (!r.ok) return res.status(502).json({ error: `itch.io returned ${r.status} — cookies may need refreshing` });
    html = await r.text();
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }

  const uploadId   = extractUploadId(html);
  const timestamp  = extractTimestamp(html);
  const version    = extractVersion(html);
  const csrf       = extractCsrf(html);
  const timeAgo    = formatTimeAgo(timestamp);
  const downloadUrl = uploadId
    ? await getDownloadUrl(gameBase, uploadId, key, csrf, cookies)
    : 'No Upload ID';

  return res.status(200).json({
    ok: true,
    upload_id: uploadId,
    timestamp,
    time_ago: timeAgo,
    version,
    download_url: downloadUrl,
    checked_at: new Date().toISOString(),
  });
}
