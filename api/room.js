// api/room.js
// Among Us room-code lookup. Key-protected (same api_keys / rate-limit infra as itch-build.js).
//
// Auth:
//   Authorization: Bearer <key>        (recommended)
//   or ?key=<key>                       (for testing in a browser)
//
// Usage:
//   GET /api/room?code=XXXXXX[&region=eu|na|as]   (region defaults to eu)
//
// Flow: V2 code -> GameId -> EOS id_token (itchio key) -> matchmaker token -> GET /api/games/{GameId}.
// Player IP/port are deliberately NOT returned.

import { randomBytes } from 'node:crypto';

// ---- EOS / matchmaker consts (Among Us v17.4i) ----
const DEPLOYMENT_ID = '503cd077a7804777aee5a6eeb5cfe62d';
const PRODUCT_USER_ID = '000232b2118147a7a6b27907bd9ea169';
const LOCAL_NAME = 'Lewis';
const CLIENT_VERSION = 50656300;
const UNITY_VERSION = '2022.3.44f1';

const REGIONS = {
  eu: 'matchmaker-eu.among.us',
  na: 'matchmaker.among.us',
  as: 'matchmaker-as.among.us',
};

// ---- V2 code <-> GameId ----
const CHAR_SET = 'QWXRTYLPESDFGHUJKZOCVBINMA';
const CHAR_MAP = [25, 21, 19, 10, 8, 11, 12, 13, 22, 15, 16, 6, 24, 23, 18, 7, 0, 3, 9, 4, 14, 20, 1, 2, 5, 17];

function codeToGameId(code) {
  code = String(code || '').toUpperCase().trim();
  if (code.length !== 6) throw new Error(`expected 6-char code, got ${code.length}`);
  for (const ch of code) {
    if (!CHAR_SET.includes(ch)) throw new Error(`bad char ${JSON.stringify(ch)} in code ${JSON.stringify(code)}`);
  }
  const v = [...code].map((c) => CHAR_MAP[c.charCodeAt(0) - 65]);
  const firstTwo = (v[0] + 26 * v[1]) & 0x3ff;
  const lastFour = v[2] + 26 * (v[3] + 26 * (v[4] + 26 * v[5]));
  let gid = (firstTwo | ((lastFour << 10) & 0x3ffffc00)) | 0x80000000;
  if (gid >= 0x80000000) gid -= 0x100000000;
  return gid;
}

// ---- game options decode ----
const GAME_MODE_NAMES = { 0: 'None', 1: 'Normal', 2: 'HideNSeek', 3: 'NormalFools', 4: 'SeekFools' };
const SPECIAL_MODE_NAMES = { 0: 'None', 1: 'AprilFools' };
const RULES_PRESET_NAMES = { 0: 'Standard', 1: 'StandardRoles', 2: 'Flashlight', 100: 'Custom' };
const MAP_NAMES = { 0: 'The Skeld', 1: 'Mira HQ', 2: 'Polus', 3: 'Dleks', 4: 'The Airship', 5: 'The Fungle' };
const KILL_DISTANCE_NAMES = { 0: 'Short', 1: 'Medium', 2: 'Long' };
const TASK_BAR_NAMES = { 0: 'Always', 1: 'During Meetings', 2: 'Never' };
const KEYWORD_FLAGS = [
  [1, 'Other'], [2, 'SpanishLA'], [4, 'Korean'], [8, 'Russian'], [16, 'Portuguese'],
  [32, 'Arabic'], [64, 'Filipino'], [128, 'Polish'], [256, 'English'], [512, 'Japanese'],
  [1024, 'SpanishEU'], [2048, 'Brazilian'], [4096, 'Dutch'], [8192, 'French'],
  [16384, 'German'], [32768, 'Italian'], [65536, 'SChinese'], [131072, 'TChinese'], [262144, 'Irish'],
];
const ROLE_NAMES = {
  2: 'Scientist', 3: 'Engineer', 4: 'Guardian Angel', 5: 'Shapeshifter',
  8: 'Noisemaker', 9: 'Phantom', 10: 'Tracker', 12: 'Detective', 18: 'Viper',
};
const ROLE_FIELDS = {
  2: ['Cooldown', 'BatteryCharge'],
  3: ['Cooldown', 'InVentMaxTime'],
  4: ['Cooldown', 'ProtectionDuration', 'ImpostorsCanSeeProtect'],
  5: ['LeaveSkin', 'Cooldown', 'Duration'],
  8: ['AlertDuration', 'ImpostorAlert'],
  9: ['Cooldown', 'Duration'],
  10: ['Cooldown', 'Duration', 'Delay'],
  12: ['DetectiveSuspectLimit'],
  18: ['ViperDissolveTime'],
};

const round2 = (x) => Math.round(x * 100) / 100;
const named = (n, table) => `${n} (${table[n] ?? '?'})`;

function decodeOptions(b64) {
  const b = Buffer.from(b64, 'base64');
  if (b.length < 8) return { error: `blob too short (${b.length} bytes)` };
  if (b[0] !== 10) return { error: `unexpected version byte 0x${b[0].toString(16).padStart(2, '0')} (expected 0x0a = 10)` };
  let i = 0;
  const u8 = () => b[i++];
  const u32 = () => { const v = b.readUInt32LE(i); i += 4; return v; };
  const i32 = () => { const v = b.readInt32LE(i); i += 4; return v; };
  const f32 = () => { const v = b.readFloatLE(i); i += 4; return v; };
  const u8flag = () => Boolean(u8());

  const opts = {};
  opts.version = u8();
  opts.innerLen = u8();
  i += 2; // wrapper zeros
  const gm = u8();
  opts.gameMode = named(gm, GAME_MODE_NAMES);
  opts.specialMode = named(u8(), SPECIAL_MODE_NAMES);
  opts.rulesPreset = named(u8(), RULES_PRESET_NAMES);
  opts.maxPlayers = u8();
  const kw = u32();
  opts.keywords = KEYWORD_FLAGS.filter(([mask]) => kw & mask).map(([, name]) => name).join(', ') || `0x${kw.toString(16)}`;
  opts.map = named(u8(), MAP_NAMES);
  opts.playerSpeedMod = round2(f32());
  opts.crewLightMod = round2(f32());
  opts.impostorLightMod = round2(f32());
  opts.killCooldownSec = round2(f32());
  opts.numCommonTasks = u8();
  opts.numLongTasks = u8();
  opts.numShortTasks = u8();
  opts.numEmergencyMeetings = i32();
  opts.numImpostors = u8();
  opts.killDistance = named(u8(), KILL_DISTANCE_NAMES);
  opts.discussionTimeSec = i32();
  opts.votingTimeSec = i32();
  opts.isDefaults = u8flag();
  opts.emergencyCooldownSec = u8();
  opts.confirmImpostor = u8flag();
  opts.visualTasks = u8flag();
  opts.anonymousVotes = u8flag();
  opts.taskBarUpdate = named(u8(), TASK_BAR_NAMES);
  opts.tag = u8();
  if (gm !== 1) opts.warning = `non-Normal gameMode (${gm}); fields after RulesPreset may not parse`;
  opts.roles = decodeRoles(b, i);
  return opts;
}

function decodeRoles(b, i) {
  const roles = [];
  let count = 0;
  let shift = 0;
  while (true) {
    const x = b[i++];
    count |= (x & 0x7f) << shift;
    if (!(x & 0x80)) break;
    shift += 7;
  }
  for (let n = 0; n < count; n++) {
    const rtype = b.readUInt16LE(i); i += 2;
    const maxCount = b[i++];
    const chance = b[i++];
    const nfields = b[i++];
    i += 2; // fixed 0x00 0x00 prefix
    const vals = [...b.subarray(i, i + nfields)];
    i += nfields;
    if (!(rtype in ROLE_FIELDS)) {
      roles.push({ type: rtype, maxCount, chancePct: chance, rawValues: vals, unknown: true });
      continue;
    }
    const opts = { type: ROLE_NAMES[rtype] ?? String(rtype), maxCount, chancePct: chance };
    ROLE_FIELDS[rtype].forEach((name, idx) => {
      if (name === 'LeaveSkin' || name === 'ImpostorsCanSeeProtect' || name === 'ImpostorAlert') opts[name] = Boolean(vals[idx]);
      else opts[name] = vals[idx];
    });
    roles.push(opts);
  }
  return roles;
}

// ---- reason codes ----
const REASON_NAMES = {
  0: 'ExitGame', 1: 'GameFull', 2: 'GameStarted', 3: 'GameNotFound',
  5: 'IncorrectVersion', 6: 'Banned', 7: 'Kicked', 8: 'Custom',
  9: 'InvalidName', 10: 'Hacking', 11: 'NotAuthorized', 12: 'ConnectionLimit',
  16: 'Destroy', 17: 'Error', 18: 'IncorrectGame',
};
const reasonName = (code) => REASON_NAMES[code] ?? `Reason${code}`;
const REVERSE_REASON_NAMES = Object.fromEntries(Object.entries(REASON_NAMES).map(([k, v]) => [v, Number(k)]));

function normalizeReason(raw) {
  if (typeof raw === 'string') {
    return { state: raw, code: REVERSE_REASON_NAMES[raw] ?? raw };
  }
  return { state: reasonName(raw), code: raw };
}

// ---- HTTP ----
const GAME_UA = 'UnityPlayer/2022.3.44f1 (UnityWebRequest/1.0, libcurl/8.5.0-DEV)';

async function getIdToken() {
  const body = new URLSearchParams({
    grant_type: 'external_auth',
    external_auth_type: 'itchio_key',
    external_auth_token: process.env.ITCH_KEY,
    deployment_id: DEPLOYMENT_ID,
    nonce: randomBytes(24).toString('base64url'),
  }).toString();
  const res = await fetch('https://api.epicgames.dev/auth/v1/oauth/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${process.env.EOS_CLIENT_BASIC}`,
    },
    body,
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`EOS auth failed (${res.status}): ${txt}`);
  return JSON.parse(txt).id_token;
}

async function getMatchmakerToken(idToken, host) {
  const res = await fetch(`https://${host}/api/user`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/plain',
      Authorization: `Bearer ${idToken}`,
      'X-Unity-Version': UNITY_VERSION,
    },
    body: JSON.stringify({
      Puid: PRODUCT_USER_ID,
      Username: LOCAL_NAME,
      ClientVersion: CLIENT_VERSION,
      Language: 0,
    }),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`/api/user failed (${res.status}): ${txt}`);
  return txt.trim();
}

async function lookupGame(gameId, mtmToken, host) {
  const res = await fetch(`https://${host}/api/games/${gameId}`, {
    headers: {
      Authorization: `Bearer ${mtmToken}`,
      Accept: 'text/plain',
      'X-Unity-Version': UNITY_VERSION,
    },
  });
  const txt = await res.text();
  let data = null;
  try { data = JSON.parse(txt); } catch { /* non-JSON */ }
  return { status: res.status, data, txt };
}

function buildGame(g) {
  const game = {
    game_id: g.GameId ?? null,
    host: g.TrueHostName || g.HostName || null,
    platform: g.HostPlatformName ?? null,
    platform_id: g.Platform ?? null,
    player_count: g.PlayerCount ?? 0,
    max_players: g.MaxPlayers ?? 0,
    impostors: g.NumImpostors ?? 0,
    map: { id: g.MapId ?? null, name: MAP_NAMES[g.MapId] ?? null },
    language: g.Language ?? null,
    quick_chat: g.QuickChat ?? null,
    age_ms: g.Age ?? null,
    options: g.Options ? decodeOptions(g.Options) : null,
  };
  if (Array.isArray(g.Players)) {
    game.players = g.Players.map((p) => ({
      name: p.Name ?? p.TrueName ?? null,
      platform: p.Platform ?? null,
    }));
  }
  return game;
}

// ---- Supabase key config + rate limiting (same as itch-build.js) ----
const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';

async function getKeyConfig(key) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return null;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/api_keys?select=id,name,enabled,rate_limit,window_seconds&id=eq.${encodeURIComponent(key)}`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
    );
    if (!r.ok) return null;
    const rows = await r.json();
    return rows[0] || null;
  } catch { return null; }
}

async function checkRateLimit(cfg) {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { count: 0, limited: false };
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/increment_usage`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ k: cfg.id, w: cfg.window_seconds }),
    });
    if (!r.ok) return { count: 0, limited: false };
    const count = await r.json();
    return { count, limited: count > cfg.rate_limit };
  } catch { return { count: 0, limited: false }; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // Auth
  const auth = req.headers.authorization || '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7).trim() : (req.query.key || '');
  if (!key) return res.status(401).json({ error: 'Unauthorized' });

  let cfg = await getKeyConfig(key);
  if (!cfg) {
    const allowedKeys = (process.env.API_KEYS || '').split(',').map((k) => k.trim()).filter(Boolean);
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

  res.setHeader('Cache-Control', 'no-store');

  // Validate inputs
  const code = (req.query.code || '').toString();
  const regionParam = (req.query.region || '').toString().toLowerCase();
  if (!code) return res.status(400).json({ error: 'code is required (?code=XXXXXX)' });
  if (regionParam && !(regionParam in REGIONS)) {
    return res.status(400).json({ error: `bad region ${JSON.stringify(regionParam)}; use eu/na/as or omit for all` });
  }
  const regionsToCheck = regionParam ? [regionParam] : Object.keys(REGIONS);

  let gameId;
  try {
    gameId = codeToGameId(code);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }

  try {
    if (!process.env.ITCH_KEY || !process.env.EOS_CLIENT_BASIC) {
      return res.status(500).json({ error: 'ITCH_KEY / EOS_CLIENT_BASIC not set' });
    }

    const idToken = await getIdToken();
    const regionResults = [];

    for (const region of regionsToCheck) {
      const host = REGIONS[region];
      const mtmToken = await getMatchmakerToken(idToken, host);
      const { data, txt } = await lookupGame(gameId, mtmToken, host);

      if (!data) {
        regionResults.push({ region, state: 'MatchmakerError', raw: txt.slice(0, 200) });
        continue;
      }

      const g = data.Game;
      const errs = Array.isArray(data.Errors) ? data.Errors : [];
      const errState = errs.length > 0 ? normalizeReason(errs[0].Reason ?? 17) : null;

      // The matchmaker may return Errors (GameStarted/GameFull/...) together with
      // a valid Game object — same as lookup.py: still return the room.
      if (!g) {
        regionResults.push({
          region,
          state: errState ? errState.state : 'NoGame',
          reason_code: errState ? errState.code : null,
        });
        continue;
      }

      const payload = { ok: true, found: true, code, region, game_id: gameId, game: buildGame(g) };
      if (errState) {
        payload.state = errState.state;
        payload.reason_code = errState.code;
      }
      return res.status(200).json(payload);
    }

    // Not found in any checked region
    const states = regionResults.map((r) => r.state);
    const notFoundState =
      states.every((s) => s === 'GameNotFound' || s === 'NoGame') ? 'GameNotFound'
      : states[states.length - 1] || 'GameNotFound';

    return res.status(200).json({
      ok: true,
      found: false,
      code,
      game_id: gameId,
      region: regionParam || null,
      state: notFoundState,
      regions: regionResults,
    });
  } catch (e) {
    return res.status(502).json({ error: e.message });
  }
}
