// GET /api/user?discord_id=<discord id>
// Returns a public launcher profile (username, display name, avatar, about,
// game stats, achievements) looked up by Discord ID.
// Requires Vercel env vars: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const PUBLIC_COLUMNS = 'id,username,display_name,avatar_url,about_me,discord_id,game_stats,achievements';

function validDiscordId(v) {
  return typeof v === 'string' && /^\d{15,20}$/.test(v);
}

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
  const discordId = url.searchParams.get('discord_id');

  if (!validDiscordId(discordId)) {
    return res.status(400).json({ error: 'Invalid Discord ID. Expected 15-20 digits.' });
  }

  const endpoint =
    `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1/profiles` +
    `?discord_id=eq.${encodeURIComponent(discordId)}&select=${PUBLIC_COLUMNS}`;

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
    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({ error: 'No profile found for that Discord ID.' });
    }

    return res.status(200).json(rows[0]);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
