// api/messages.js
const CHANNELS = {
  general:   process.env.DISCORD_CHANNEL_ID,
  news:      '1166442814708650084',
  releases:  '1166442919029387335',
  giveaways: '1429437676083351725',
  trustwall: '1413093253229838406',
};

const userCache = {};

async function resolveUser(userId, token) {
  if (userCache[userId]) return userCache[userId];
  try {
    const r = await fetch(`https://discord.com/api/v10/users/${userId}`, {
      headers: { Authorization: `Bot ${token}` }
    });
    if (r.ok) {
      const u = await r.json();
      const name = u.global_name || u.username;
      userCache[userId] = name;
      return name;
    }
  } catch(e) {}
  return null;
}

function getAvatarUrl(author) {
  if (!author.avatar) {
    // Default Discord avatar
    return `https://cdn.discordapp.com/embed/avatars/${parseInt(author.discriminator || '0') % 5}.png`;
  }
  // Webhooks use a different avatar path vs regular users
  if (author.webhook_id) {
    return `https://cdn.discordapp.com/avatars/${author.webhook_id}/${author.avatar}.png?size=64`;
  }
  return `https://cdn.discordapp.com/avatars/${author.id}/${author.avatar}.png?size=64`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const channel   = req.query.channel || 'general';
  const channelId = CHANNELS[channel];
  if (!channelId) return res.status(400).json({ error: `Unknown channel: ${channel}` });

  const limit  = Math.min(parseInt(req.query.limit) || 50, 100);
  const before = req.query.before || '';
  const token  = process.env.DISCORD_BOT_TOKEN;

  try {
    const url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}${before ? `&before=${before}` : ''}`;
    const response = await fetch(url, {
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
    });
    if (!response.ok) return res.status(response.status).json({ error: await response.text() });

    const messages = await response.json();

    // Build mention map
    const mentionMap = {};
    for (const m of messages) {
      for (const u of (m.mentions || [])) {
        mentionMap[u.id] = u.global_name || u.username;
      }
      mentionMap[m.author.id] = m.author.global_name || m.author.username;
    }

    // Resolve unresolved IDs in content
    const unresolvedIds = new Set();
    for (const m of messages) {
      const matches = [...(m.content?.matchAll(/<@!?(\d+)>/g) || [])];
      for (const match of matches) {
        if (!mentionMap[match[1]]) unresolvedIds.add(match[1]);
      }
    }
    await Promise.all([...unresolvedIds].slice(0, 5).map(async id => {
      const name = await resolveUser(id, token);
      if (name) mentionMap[id] = name;
    }));

    const shaped = messages.map(m => {
      // Detect if this is a webhook message
      const isWebhook = !!m.webhook_id;
      const authorWithWebhook = { ...m.author, webhook_id: m.webhook_id };

      return {
        id:        m.id,
        content:   m.content || '',
        timestamp: m.timestamp,
        author: {
          id:           m.author.id,
          username:     m.author.username,
          display_name: m.author.global_name || m.author.username,
          avatar:       getAvatarUrl(authorWithWebhook),
          is_webhook:   isWebhook,
          bot:          m.author.bot || false,
        },
        mention_map: mentionMap,
        attachments: (m.attachments || []).map(a => ({
          url: a.url, filename: a.filename,
          content_type: a.content_type || '',
          width: a.width || null, height: a.height || null,
        })),
        // Sticker support
        stickers: (m.sticker_items || []).map(s => ({
          id:     s.id,
          name:   s.name,
          format: s.format_type, // 1=PNG, 2=APNG, 3=LOTTIE, 4=GIF
          url:    s.format_type === 3
            ? null  // Lottie stickers can't be rendered as img
            : `https://cdn.discordapp.com/stickers/${s.id}.${s.format_type === 4 ? 'gif' : 'png'}?size=160`,
        })),
        embeds: (m.embeds || []).map(e => ({
          title:       e.title       || null,
          description: e.description || null,
          url:         e.url         || null,
          color:       e.color       || null,
          fields:      (e.fields || []).map(f => ({ name: f.name, value: f.value, inline: f.inline })),
          image:       e.image?.url     || null,
          thumbnail:   e.thumbnail?.url || null,
          footer:      e.footer  ? { text: e.footer.text,  icon: e.footer.icon_url }              : null,
          author_meta: e.author  ? { name: e.author.name,  icon: e.author.icon_url, url: e.author.url } : null,
          type:        e.type || 'rich',
        })),
        components: (m.components || []).flatMap(row =>
          (row.components || []).map(c => ({
            type:     c.type,
            label:    c.label || '',
            url:      c.url   || null,
            style:    c.style || 1,
            disabled: c.disabled || false,
            emoji:    c.emoji?.name || null,
          }))
        ),
        reactions: (m.reactions || []).map(r => ({ emoji: r.emoji.name, count: r.count })),
        referenced_message: m.referenced_message ? {
          id:      m.referenced_message.id,
          content: m.referenced_message.content || '',
          author:  m.referenced_message.author?.global_name || m.referenced_message.author?.username || 'Unknown',
          author_id: m.referenced_message.author?.id || null,
        } : null,
      };
    });

    return res.status(200).json(shaped);
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}