// api/feedback.js
// Posts feedback to a dedicated Discord webhook channel
// Rate limited to 1 submission per minute per IP

const FEEDBACK_COOLDOWN_MS = 60 * 1000;
const lastFeedback = {};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { username, type, rating, content } = req.body || {};

  if (!content || typeof content !== 'string' || content.trim().length === 0)
    return res.status(400).json({ error: 'content is required' });
  if (content.length > 500)
    return res.status(400).json({ error: 'Message too long (max 500 chars)' });

  const displayName = (username || 'Launcher User')
    .replace(/[<>@#&]/g, '').trim().slice(0, 32) || 'Launcher User';

  // Rate limit per IP
  const ip = req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  if (lastFeedback[ip] && now - lastFeedback[ip] < FEEDBACK_COOLDOWN_MS) {
    const remaining = Math.ceil((FEEDBACK_COOLDOWN_MS - (now - lastFeedback[ip])) / 1000);
    return res.status(429).json({ error: `Please wait ${remaining}s before sending again.` });
  }
  lastFeedback[ip] = now;

  // Clean up old entries
  if (Object.keys(lastFeedback).length > 500) {
    const cutoff = now - FEEDBACK_COOLDOWN_MS * 2;
    for (const k of Object.keys(lastFeedback)) {
      if (lastFeedback[k] < cutoff) delete lastFeedback[k];
    }
  }

  // Build star display
  const ratingNum = Math.min(10, Math.max(0, Number(rating) || 0));
  const fullStars = Math.floor(ratingNum / 2);
  const halfStar  = ratingNum % 2 === 1;
  const emptyStars = 5 - fullStars - (halfStar ? 1 : 0);
  const starDisplay = '★'.repeat(fullStars) + (halfStar ? '½' : '') + '☆'.repeat(emptyStars);

  const webhookUrl = process.env.DISCORD_FEEDBACK_WEBHOOK_URL;
  if (!webhookUrl) return res.status(500).json({ error: 'Feedback webhook not configured' });

  try {
    const embed = {
      color: type === '🐛 Bug Report' ? 0xff4d6a
           : type === '💡 Suggestion' ? 0x7b61ff
           : type === '⭐ Compliment' ? 0x22c55e
           : 0x6b7194,
      author: {
        name: `${displayName} · ${type || 'Feedback'}`,
        icon_url: `https://ui-avatars.com/api/?name=${encodeURIComponent(displayName)}&background=7b61ff&color=fff&size=64&bold=true&rounded=true`,
      },
      description: content.trim(),
      fields: ratingNum > 0 ? [{ name: 'Rating', value: `${starDisplay}  **${ratingNum}/10**`, inline: true }] : [],
      footer: { text: `Among Us ShadowSlime Launcher · Feedback` },
      timestamp: new Date().toISOString(),
    };

    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });

    if (!response.ok && response.status !== 204) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    return res.status(200).json({ ok: true });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}