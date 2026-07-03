import { kv } from '@vercel/kv';

const EVENTS_KEY = 'gomagic:analytics:events';
const MAX_EVENTS = 5000;
const VALID_ACTIONS = new Set([
  'image_download',
  'video_download',
  'referral_copy',
  'share_click',
  'asset_view',
  'qr_scan'
]);

globalThis.__gomagicMemoryEvents = globalThis.__gomagicMemoryEvents || [];

function json(res, status, body) {
  res.status(status).setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function hasKvConfig() {
  return Boolean(process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN);
}

function cleanText(value, fallback = '') {
  return String(value || fallback).trim().slice(0, 500);
}

function normalizeEvent(body) {
  const action = cleanText(body.action);
  if (!VALID_ACTIONS.has(action)) return null;

  return {
    id: cleanText(body.id, `e_${Date.now()}`),
    userId: cleanText(body.userId, 'unknown'),
    referrerId: cleanText(body.referrerId, 'unknown'),
    action,
    assetName: body.assetName ? cleanText(body.assetName) : null,
    timestamp: body.timestamp && !Number.isNaN(Date.parse(body.timestamp))
      ? new Date(body.timestamp).toISOString()
      : new Date().toISOString(),
    meta: body.meta && typeof body.meta === 'object' ? body.meta : {}
  };
}

async function readEvents() {
  if (hasKvConfig()) {
    const items = await kv.lrange(EVENTS_KEY, 0, MAX_EVENTS - 1);
    return items.map((item) => {
      try { return typeof item === 'string' ? JSON.parse(item) : item; }
      catch { return null; }
    }).filter(Boolean);
  }

  return globalThis.__gomagicMemoryEvents;
}

async function writeEvent(event) {
  if (hasKvConfig()) {
    await kv.lpush(EVENTS_KEY, JSON.stringify(event));
    await kv.ltrim(EVENTS_KEY, 0, MAX_EVENTS - 1);
    return 'vercel-kv';
  }

  globalThis.__gomagicMemoryEvents.unshift(event);
  globalThis.__gomagicMemoryEvents = globalThis.__gomagicMemoryEvents.slice(0, MAX_EVENTS);
  return 'memory-fallback';
}

async function clearEvents() {
  if (hasKvConfig()) {
    await kv.del(EVENTS_KEY);
    return 'vercel-kv';
  }

  globalThis.__gomagicMemoryEvents = [];
  return 'memory-fallback';
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET') {
      const events = (await readEvents())
        .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

      return json(res, 200, {
        ok: true,
        storage: hasKvConfig() ? 'vercel-kv' : 'memory-fallback',
        events
      });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
      const event = normalizeEvent(body);

      if (!event) {
        return json(res, 400, { ok: false, error: 'Invalid action' });
      }

      const storage = await writeEvent(event);
      return json(res, 200, { ok: true, storage });
    }

    if (req.method === 'DELETE') {
      const storage = await clearEvents();
      return json(res, 200, { ok: true, storage });
    }

    res.setHeader('allow', 'GET, POST, DELETE');
    return json(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (error) {
    return json(res, 500, {
      ok: false,
      error: error.message || 'Analytics API failed'
    });
  }
}