// Vercel serverless function: forwards a prompt (and optional photos) to the Anthropic API.
// The API key stays on the server. Callers must send the shared access password.
const crypto = require('crypto');

const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

function passwordOk(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST.' });

  const key = process.env.ANTHROPIC_API_KEY;
  const pw = process.env.APP_PASSWORD;
  if (!key || !pw) {
    return res.status(500).json({ error: 'Server is missing ANTHROPIC_API_KEY or APP_PASSWORD.' });
  }
  if (!passwordOk(req.headers['x-app-password'], pw)) {
    return res.status(401).json({ error: 'Wrong password.' });
  }

  let body = req.body;
  try {
    if (typeof body === 'string') body = JSON.parse(body);
  } catch (e) {
    return res.status(400).json({ error: 'Body must be JSON.' });
  }
  body = body || {};
  const { prompt, images = [] } = body;
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 250000) {
    return res.status(400).json({ error: 'A prompt is required.' });
  }
  if (!Array.isArray(images) || images.length > 8) {
    return res.status(400).json({ error: 'Up to 8 images per request.' });
  }
  const content = [];
  for (const img of images) {
    if (!img || !ALLOWED_TYPES.includes(img.media_type) || typeof img.data !== 'string') {
      return res.status(400).json({ error: 'Images must be JPEG, PNG, WebP or GIF.' });
    }
    content.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
  }
  content.push({ type: 'text', text: prompt });

  const maxTokens = Math.min(Math.max(parseInt(body.max_tokens, 10) || 4000, 256), 8000);

  let upstream;
  try {
    upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content }]
      })
    });
  } catch (e) {
    return res.status(502).json({ error: 'Could not reach the Anthropic API.' });
  }

  let data;
  try {
    data = await upstream.json();
  } catch (e) {
    return res.status(502).json({ error: 'Unreadable reply from the Anthropic API.' });
  }
  if (!upstream.ok) {
    const status = upstream.status === 429 ? 429 : 502;
    const msg = (data && data.error && data.error.message) || 'The Anthropic API returned an error.';
    return res.status(status).json({ error: msg });
  }

  const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return res.status(200).json({ text, truncated: data.stop_reason === 'max_tokens' });
};
