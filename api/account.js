const ITCH_ME = 'https://itch.io/api/1/key/me';
const EOS_AUTH = 'https://accounts.innersloth.com/eos-auth';
const EOS_MERGE = 'https://backend.innersloth.com/api/user/query-primary-before-merge';
const EOS_USERNAME = 'https://backend.innersloth.com/api/user/username';

const PLATFORM_LABELS = {
  itchio: 'itch.io', itch: 'itch.io',
  steam: 'Steam',
  epic: 'Epic Games', epicgames: 'Epic Games',
  xbox: 'Xbox', xboxlive: 'Xbox',
  playstation: 'PlayStation', psn: 'PlayStation',
  nintendo: 'Nintendo', switch: 'Nintendo Switch',
  ios: 'iOS', android: 'Android',
  google: 'Google Play',
};

function platformLabel(p) {
  return PLATFORM_LABELS[String(p).toLowerCase()] || String(p);
}

function getToken(req) {
  const header = req.headers.authorization;
  if (header) return header.trim();
  const query = new URL(req.url, 'http://localhost').searchParams.get('token');
  if (query) return query.trim();
  return null;
}

async function fetchItchProfile(token) {
  const res = await fetch(ITCH_ME, { headers: { Authorization: token } });
  if (res.status === 401) {
    return { ok: false, status: 401, error: 'Invalid or expired itch.io token' };
  }
  if (!res.ok) {
    return { ok: false, status: res.status, error: `Itch.io returned ${res.status}` };
  }
  const data = await res.json();
  const user = data.user;
  if (!user || (!user.username && !user.id)) {
    return { ok: false, status: 422, error: 'Itch.io did not return a user for this token' };
  }
  return { ok: true, user };
}

async function fetchInnersloth(token) {
  const auth = await (await fetch(
    `${EOS_AUTH}?store=itchio&token=${encodeURIComponent(token)}`,
    { headers: { Accept: 'application/json' } },
  )).json();

  if (!auth.id_token) return null;

  const headers = {
    Authorization: `Bearer ${auth.id_token}`,
    Accept: 'application/vnd.api+json',
  };

  const mergePromise = fetch(`${EOS_MERGE}?access_token=${encodeURIComponent(auth.token || '')}`, { headers })
    .then(r => r.json()).catch(() => null);
  const usernamePromise = fetch(EOS_USERNAME, { headers }).then(r => r.json()).catch(() => null);

  const [merge, username] = await Promise.all([mergePromise, usernamePromise]);

  const mergeData = merge?.data || {};
  const usernameAttrs = username?.data?.attributes || {};

  let platforms = mergeData.platforms || [];
  if (!platforms.length) {
    const current = mergeData.platform || auth.account?.idp;
    if (current) platforms = [current];
  }

  return {
    username: usernameAttrs.username || null,
    discriminator: usernameAttrs.discriminator || null,
    friend_code: usernameAttrs.username && usernameAttrs.discriminator
      ? `${usernameAttrs.username}#${usernameAttrs.discriminator}`
      : null,
    platforms,
    platforms_labeled: platforms.map(platformLabel),
    merged: (mergeData.platforms || []).length > 0,
  };
}

export default async function handler(req, res) {
  const token = getToken(req);

  if (!token) {
    return res.status(400).json({ error: 'Missing token. Pass it in the Authorization header or as a ?token= query param.' });
  }

  const profile = await fetchItchProfile(token);
  if (!profile.ok) {
    return res.status(profile.status).json({ error: profile.error });
  }

  const account = await fetchInnersloth(token);

  return res.status(200).json({
    ok: true,
    itch: {
      username: profile.user.username,
      url: profile.user.url,
      cover_url: profile.user.cover_url,
    },
    innersloth: account,
  });
}
