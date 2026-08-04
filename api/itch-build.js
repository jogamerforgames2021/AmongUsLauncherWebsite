// api/itch-build.js
// Returns the latest Among Us build info straight from Innersloth's itch.io
// page — version, upload id, timestamp, and a fresh (signed, expiring) direct
// download URL. Protected by a Bearer API key, with per-key rate limits and
// request tracking stored in Supabase.
//
// Auth:
//   Authorization: Bearer <key>        (recommended)
//   or ?key=<key>                       (for testing in a browser)
//
// Supabase schema (run once in the SQL Editor):
//   create table if not exists public.api_keys (
//     id             text primary key,
//     name           text default '',
//     enabled        boolean default true,
//     rate_limit     int default 30,
//     window_seconds int default 60,
//     total_requests bigint default 0,
//     last_used_at   timestamptz,
//     created_at     timestamptz default now()
//   );
//   create table if not exists public.api_key_usage (
//     id     text not null,
//     bucket bigint not null,
//     count  int  not null default 1,
//     primary key (id, bucket)
//   );
//   create or replace function increment_usage(k text, w int)
//   returns int language plpgsql as $$
//   declare
//     bucket bigint := floor(extract(epoch from now()) / w);
//     new_count int;
//   begin
//     insert into api_key_usage (id, bucket, count)
//     values (k, bucket, 1)
//     on conflict (id, bucket) do update
//       set count = api_key_usage.count + 1
//     returning count into new_count;
//     update api_keys
//       set total_requests = total_requests + 1, last_used_at = now()
//       where id = k;
//     return new_count;
//   end $$;
//
// Env vars:
//   SUPABASE_URL             (already used by api/user.js)
//   SUPABASE_SERVICE_ROLE_KEY
//   API_KEYS                 fallback comma list if Supabase is not set
//   ITCH_URL / ITCH_DOWNLOAD_KEY / ITCH_COOKIES
//
// Response includes rate-limit info + headers:
//   X-RateLimit-Limit / X-RateLimit-Remaining / X-RateLimit-Reset

const DEFAULT_URL = 'https://innersloth.itch.io/among-us/download/qyosUvijZ_NJHO1PbXFa0fDpi0WxpCoHp5qWYQRP';

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

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
    const m = rawTimestamp.replace(' UTC', '').replace(' @', '').match(/(\d+) (\w+) (\d{4}) (\d+):(\d+)/);
    if (m) {
      const months = { january:0, february:1, march:2, april:3, may:4, june:5, july:6, august:7, september:8, october:9, november:10, december:11 };
      const month = months[String(m[2]).toLowerCase()];
      if (month !== undefined) {
        const dt = new Date(Date.UTC(+m[3], month, +m[1], +m[4], +m[5]));
        const diffSec = Math.floor((Date.now() - dt.getTime()) / 1000);
        if (diffSec < 60)    return 'just now';
        if (diffSec < 3600)  return `${Math.floor(diffSec / 60)} minute${Math.floor(diffSec / 60) > 1 ? 's' : ''} ago`;
        if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} hour${Math.floor(diffSec / 3600) > 1 ? 's' : ''} ago`;
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

// ── Supabase key config + rate limiting ──────────────────────────────

async function getKeyConfig(key) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null; // fallback mode
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/api_keys?select=id,name,enabled,rate_limit,window_seconds&id=eq.${encodeURIComponent(key)}`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return rows[0] || null;
  } catch (e) {
    return null;
  }
}

// Atomically counts this request; returns { count, limited }.
async function checkRateLimit(cfg) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { count: 0, limited: false };
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_usage`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ k: cfg.id, w: cfg.window_seconds }),
    });
    if (!r.ok) return { count: 0, limited: false }; // fail open on infra errors
    const count = await r.json();
    return { count, limited: count > cfg.rate_limit };
  } catch (e) {
    return { count: 0, limited: false };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Auth: Bearer header, or ?key= for quick browser testing
  const auth = req.headers.authorization || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : (req.query.key || '');
  if (!key) return res.status(401).json({ error: 'Unauthorized' });

  let cfg = await getKeyConfig(key);

  // Fallback: env comma list (no rate limiting) if Supabase isn't set up
  if (!cfg) {
    const allowedKeys = (process.env.API_KEYS || '').split(',').map(k => k.trim()).filter(Boolean);
    if (!allowedKeys.includes(key)) return res.status(401).json({ error: 'Unauthorized' });
    cfg = { id: key, name: 'env', enabled: true, rate_limit: Infinity, window_seconds: 60 };
  }

  if (!cfg.enabled) return res.status(403).json({ error: 'Key disabled' });

  const { count, limited } = await checkRateLimit(cfg);
  const windowSec = cfg.window_seconds || 60;
  const bucket = Math.floor(Date.now() / 1000 / windowSec);
  const resetAt = new Date((bucket + 1) * windowSec * 1000);

  res.setHeader('X-RateLimit-Limit', String(cfg.rate_limit));
  res.setHeader('X-RateLimit-Remaining', String(Math.max(0, cfg.rate_limit - count)));
  res.setHeader('X-RateLimit-Reset', String(Math.floor(resetAt.getTime() / 1000)));

  if (limited) {
    return res.status(429).json({
      error: 'Rate limit exceeded',
      retry_after_seconds: Math.max(1, Math.ceil((resetAt - Date.now()) / 1000)),
    });
  }

  // Fresh data on every call (rate limit is authoritative — no edge cache)
  res.setHeader('Cache-Control', 'no-store');

  const pageUrl = process.env.ITCH_URL || DEFAULT_URL;
  const gameBase = pageUrl.split('/').slice(0, 4).join('/');
  const downloadKey = process.env.ITCH_DOWNLOAD_KEY || '';
  const cookies = process.env.ITCH_COOKIES || '';

  if (!downloadKey) return res.status(500).json({ error: 'ITCH_DOWNLOAD_KEY not set' });
  if (!cookies) return res.status(500).json({ error: 'ITCH_COOKIES not set' });

  let html;
  try {
    const r = await fetch(pageUrl, { headers: HEADERS(pageUrl, cookies) });
    if (!r.ok) return res.status(502).json({ error: `itch.io returned ${r.status} — cookies may need refreshing` });
    html = await r.text();
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }

  const uploadId    = extractUploadId(html);
  const timestamp   = extractTimestamp(html);
  const version     = extractVersion(html);
  const csrf        = extractCsrf(html);
  const timeAgo     = formatTimeAgo(timestamp);
  const downloadUrl = uploadId
    ? await getDownloadUrl(gameBase, uploadId, downloadKey, csrf, cookies)
    : 'No Upload ID';

  return res.status(200).json({
    ok: true,
    key: cfg.name || cfg.id,
    upload_id: uploadId,
    timestamp,
    time_ago: timeAgo,
    version,
    download_url: downloadUrl,
    rate: {
      limit: cfg.rate_limit,
      remaining: Math.max(0, cfg.rate_limit - count),
      reset_at: resetAt.toISOString(),
    },
    checked_at: new Date().toISOString(),
  });
}
