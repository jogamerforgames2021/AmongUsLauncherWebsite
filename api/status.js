// api/status.js
// Returns whether the launcher's hosted Among Us builds are behind Innersloth.
//
// Source of truth: AppDetail.json in the BootstrapperTEST repo, the exact file
// the launcher reads to decide whether to show its "BEHIND" staleness banner.
//   repository_version — the latest game build the launcher hosts
//   uploaded_version   — the latest version Innersloth has pushed (tracked here)
//
// Response:
// {
//   "ok": true,
//   "source": ".../AppDetail.json",
//   "repository_version": "17.4I",
//   "uploaded_version":   "17.4I",
//   "outdated": false,
//   "status": "up_to_date" | "behind",
//   "message": "...",
//   "checked_at": "2026-08-03T...Z"
// }

const APP_DETAIL_URL = 'https://raw.githubusercontent.com/jogamerforgames2021/BootstrapperTEST/main/AppDetail.json';

function parseVersion(v) {
  // Handles "17.4I", "17.2.2", "2026.17.4", "2023.11.28" — numeric dotted prefix + optional letter suffix
  const str = String(v || '').trim();
  const m = str.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return { nums: [], letter: '' };
  return {
    nums: [m[1], m[2], m[3]].filter(Boolean).map(Number),
    letter: str.replace(/^[\d.]+/, '').toUpperCase() || '',
  };
}

// Returns <0 if a < b, >0 if a > b, 0 if equal (same logic spirit as the launcher's version_is_newer)
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const n = Math.max(pa.nums.length, pb.nums.length);
  for (let i = 0; i < n; i++) {
    const x = pa.nums[i] || 0;
    const y = pb.nums[i] || 0;
    if (x !== y) return x - y;
  }
  const la = pa.letter;
  const lb = pb.letter;
  if (la !== lb) {
    if (!la) return -1;  // "17.4" < "17.4I"
    if (!lb) return 1;
    return la < lb ? -1 : 1;
  }
  return 0;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Cache at the edge for 2 minutes — AppDetail.json doesn't change often
  res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');

  let data;
  try {
    const r = await fetch(APP_DETAIL_URL, { headers: { 'User-Agent': 'au-launcher-api/1.0' } });
    if (!r.ok) {
      return res.status(502).json({ error: `AppDetail.json returned ${r.status}`, status: r.status });
    }
    data = await r.json();
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }

  const repoVer     = String(data.repository_version || '').trim();
  const uploadedVer = String(data.uploaded_version || '').trim();

  if (!repoVer && !uploadedVer) {
    return res.status(502).json({ error: 'AppDetail.json is missing version fields' });
  }

  const cmp = compareVersions(repoVer, uploadedVer);
  const outdated = cmp < 0; // Innersloth's latest is newer than what the launcher hosts

  let status  = 'up_to_date';
  let message = 'Launcher builds are up to date.';
  if (outdated) {
    status = 'behind';
    message = `Innersloth pushed ${uploadedVer || 'a newer version'} but the latest hosted build is still ${repoVer || 'unknown'}.`;
  } else if (cmp === 0) {
    message = `Latest hosted build (${repoVer}) matches Innersloth's current version.`;
  } else {
    message = `Hosted build (${repoVer}) is ahead of the tracked Innersloth version (${uploadedVer}).`;
  }

  return res.status(200).json({
    ok: true,
    source: APP_DETAIL_URL,
    repository_version: repoVer || null,
    uploaded_version:   uploadedVer || null,
    outdated,
    status,
    message,
    checked_at: new Date().toISOString(),
  });
}
