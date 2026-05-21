// api/game-versions.js
// Returns all Among Us game releases with version, date, download link, and size.
//
// Query params:
//   ?limit=N        — cap results to N most recent (default: all)
//   ?latest=true    — return only the single latest release object (not array)
//
// Response shape (array):
// [
//   {
//     "version":  "2023.11.28",
//     "date":     "2023-11-28",
//     "download": "https://github.com/.../releases/download/.../app.zip",
//     "size_mb":  312.47
//   },
//   ...
// ]
//
// Response shape (?latest=true — single object, not array):
// { "version": "...", "date": "...", "download": "...", "size_mb": ... }

const REPO       = 'jogamerforgames2021/AmongUsLauncherNew';
const ASSET_NAME = 'app.zip';

export default async function handler(req, res) {
  // CORS — allow any origin so people can call this from their own projects
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Cache at Vercel's edge for 5 minutes — fast responses, low GitHub rate limit usage
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  const latestOnly = req.query.latest === 'true';
  const limit      = parseInt(req.query.limit) || 0; // 0 = no cap

  try {
    // Fetch up to 100 releases from GitHub (their max per page)
    const ghRes = await fetch(
      `https://api.github.com/repos/${REPO}/releases?per_page=100`,
      {
        headers: {
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'au-launcher-api/1.0',
          // Optional: add Authorization header if you set GITHUB_TOKEN in Vercel env vars
          // This raises rate limit from 60 to 5000 req/hour
          ...(process.env.GITHUB_TOKEN
            ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
            : {}),
        },
      }
    );

    if (!ghRes.ok) {
      return res.status(502).json({
        error: 'GitHub API error',
        status: ghRes.status,
        message: await ghRes.text(),
      });
    }

    const releases = await ghRes.json();

    // Filter: only releases that have an app.zip asset, skip drafts and pre-releases
    const versions = releases
      .filter(r => !r.draft && !r.prerelease)
      .reduce((acc, r) => {
        const asset = (r.assets || []).find(a => a.name === ASSET_NAME);
        if (!asset) return acc;

        acc.push({
          version:  r.tag_name,
          date:     r.published_at ? r.published_at.slice(0, 10) : null,
          download: asset.browser_download_url,
          size_mb:  parseFloat((asset.size / 1048576).toFixed(2)),
        });

        return acc;
      }, []);

    // ?latest=true — return a single object
    if (latestOnly) {
      if (!versions.length) return res.status(404).json({ error: 'No releases found' });
      return res.status(200).json(versions[0]);
    }

    // ?limit=N — cap the array
    const result = limit > 0 ? versions.slice(0, limit) : versions;
    return res.status(200).json(result);

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}