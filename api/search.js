// GET /api/search?q=<username>&limit=<n>
// Searches public launcher profiles by username or display name (substring).
// Requires Vercel env vars: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PUBLIC_COLUMNS = 'id,username,display_name,avatar_url,discord_id,game_stats';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({
      error: 'Server not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in the Vercel project env.',
    });
  }

  const url = new URL(req.url, 'http://localhost');
  const q = (url.searchParams.get('q') || '').trim();
  if (!q) return res.status(400).json({ error: 'Missing q parameter.' });
  if (q.length > 32) return res.status(400).json({ error: 'Query too long (max 32 chars).' });

  const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '8', 10) || 8, 1), 20);
  const esc = encodeURIComponent(q);

  const endpoint =
    `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/profiles` +
    `?or=(username.ilike.*${esc}*,display_name.ilike.*${esc}*)` +
    `&select=${PUBLIC_COLUMNS}&limit=${limit}`;

  try {
    const r = await fetch(endpoint, {
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      },
    });

    if (!r.ok) {
      return res.status(502).json({ error: `Supabase returned ${r.status}` });
    }

    const rows = await r.json();
    if (!Array.isArray(rows)) return res.status(502).json({ error: 'Unexpected Supabase response.' });

    return res.status(200).json(rows);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
