import roomHandler from './room.js';

const SOFT_LIMIT = 40;
const SOFT_WINDOW_MS = 60 * 1000;

const hits = new Map();

function ipOf(req) {
  const fwd = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return fwd || req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

function softLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < SOFT_WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > SOFT_LIMIT;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const key = String(
    process.env.LOBBY_API_KEY ||
    (process.env.API_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean)[0] || ''
  ).trim();
  if (!key) return res.status(500).json({ error: 'LOBBY_API_KEY not configured' });

  const ip = ipOf(req);
  if (softLimited(ip)) {
    return res.status(429).json({ error: 'Rate limit exceeded', retry_after_seconds: 60 });
  }

  req.query = { ...(req.query || {}), key };
  return roomHandler(req, res);
}
