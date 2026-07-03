import { kv } from '@vercel/kv';

const EVENTS_KEY = 'gomagic:analytics:events';

function json(res, status, body) {
  res.status(status).setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function parseEvent(item) {
  try {
    return typeof item === 'string' ? JSON.parse(item) : item;
  } catch (error) {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const items = await kv.lrange(EVENTS_KEY, 0, 4999);
      const events = items
        .map(parseEvent)
        .filter(Boolean)
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      return json(res, 200, { ok: true, events });
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error: 'Analytics storage is not available. Connect Vercel KV to enable remote tracking.'
      });
    }
  }

  if (req.method === 'DELETE') {
    try {
      await kv.del(EVENTS_KEY);
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 500, {
        ok: false,
        error: 'Analytics storage is not available. Connect Vercel KV to clear remote tracking.'
      });
    }
  }

  res.setHeader('allow', 'GET, DELETE');
  return json(res, 405, { ok: false, error: 'Method not allowed' });
}