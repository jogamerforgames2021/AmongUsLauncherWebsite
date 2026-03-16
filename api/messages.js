const CHANNELS = {
  general:     process.env.DISCORD_CHANNEL_ID,
  news:        '1166442814708650084',
  releases:    '1166442919029387335',
  giveaways:   '1429437676083351725',
  trustwall:   '1413093253229838406',
};

export default async function handler(req, res) {
  // CORS so the launcher can call this
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const channel = req.query.channel || 'general';
  const channelId = CHANNELS[channel];

  if (!channelId) {
    return res.status(400).json({ error: `Unknown channel: ${channel}` });
  }

  const limit = Math.min(parseInt(req.query.limit) || 50, 100);
  const before = req.query.before || '';

  try {
    const url = `https://discord.com/api/v10/channels/${channelId}/messages?limit=${limit}${before ? `&before=${before}` : ''}`;
    const response = await fetch(url, {
      headers: {
        Authorization: `Bot ${process.env.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      const err = await response.text();
      return res.status(response.status).json({ error: err });
    }

    const messages = await response.json();

    // Shape the data — only send what the launcher needs
    const shaped = messages.map(m => ({
      id:        m.id,
      content:   m.content,
      timestamp: m.timestamp,
      author: {
        id:            m.author.id,
        username:      m.author.username,
        display_name:  m.author.global_name || m.author.username,
        avatar:        m.author.avatar
          ? `https://cdn.discordapp.com/avatars/${m.author.id}/${m.author.avatar}.png?size=64`
          : `https://cdn.discordapp.com/embed/avatars/${parseInt(m.author.id) % 5}.png`,
        bot:           m.author.bot || false,
      },
      attachments: m.attachments?.map(a => ({ url: a.url, filename: a.filename, content_type: a.content_type })) || [],
      embeds:      m.embeds?.length > 0,
      reactions:   m.reactions?.map(r => ({ emoji: r.emoji.name, count: r.count })) || [],
      referenced_message: m.referenced_message ? {
        id:       m.referenced_message.id,
        content:  m.referenced_message.content,
        author:   m.referenced_message.author?.username || 'Unknown',
      } : null,
    }));

    return res.status(200).json(shaped);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}