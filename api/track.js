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

function json(res, status, body) {
  res.status(status).setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function cleanText(value, fallback = '') {
  return String(value || fallback).trim().slice(0, 500);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return json(res, 405, { ok: false, error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = cleanText(body.action);

    if (!VALID_ACTIONS.has(action)) {
      return json(res, 400, { ok: false, error: 'Invalid action' });
    }

    const event = {
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

    await kv.lpush(EVENTS_KEY, JSON.stringify(event));
    await kv.ltrim(EVENTS_KEY, 0, MAX_EVENTS - 1);

    return json(res, 200, { ok: true });
  } catch (error) {
    return json(res, 500, {
      ok: false,
      error: 'Analytics storage is not available. Connect Vercel KV to enable remote tracking.'
    });
  }
}