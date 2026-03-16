// api/send.js
// Posts a message to Discord general chat via webhook
// Rate limited to prevent spam

const MESSAGE_COOLDOWN_MS = 2000;
const lastSend = {};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { username, content } = req.body || {};

  // Validate
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'content is required' });
  }
  if (content.trim().length === 0) {
    return res.status(400).json({ error: 'Message cannot be empty' });
  }
  if (content.length > 500) {
    return res.status(400).json({ error: 'Message too long (max 500 chars)' });
  }

  // Sanitize username
  const displayName = (username || 'Launcher User')
    .replace(/[<>@#&]/g, '')
    .trim()
    .slice(0, 32) || 'Launcher User';

  // Basic IP rate limit
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  if (lastSend[ip] && now - lastSend[ip] < MESSAGE_COOLDOWN_MS) {
    return res.status(429).json({ error: 'Slow down! Wait a moment before sending again.' });
  }
  lastSend[ip] = now;

  // Clean up old entries (simple memory management)
  if (Object.keys(lastSend).length > 500) {
    const cutoff = now - 60000;
    for (const k of Object.keys(lastSend)) {
      if (lastSend[k] < cutoff) delete lastSend[k];
    }
  }

  try {
    const response = await fetch(process.env.DISCORD_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username:   `${displayName} · Launcher`,
        content:    content.trim(),
        avatar_url: `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=7b61ff&color=fff&size=64&bold=true&rounded=true`,
      }),
    });

    if (!response.ok && response.status !== 204) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}