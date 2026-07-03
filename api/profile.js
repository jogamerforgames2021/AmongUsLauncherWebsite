export default async function handler(req, res) {
  const token = req.headers.authorization;

  if (!token) {
    return res.status(400).json({ error: 'Missing token' });
  }

  try {
    const response = await fetch('https://itch.io/api/1/key/me', {
      headers: { 'Authorization': token }
    });

    if (!response.ok) {
      return res.status(response.status).json({ error: `Itch.io returned ${response.statusText}` });
    }

    const data = await response.json();
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}