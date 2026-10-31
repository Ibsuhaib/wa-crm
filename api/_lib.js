// Shared helpers. Files starting with "_" are not exposed as Vercel functions.
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

export const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

export function isAdmin(req, res) {
  const key = process.env.ADMIN_KEY;
  const given = String(req.headers['x-admin-key'] || '');
  if (key && given.length === key.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key))) return true;
  res.status(401).json({ error: 'Wrong admin key' });
  return false;
}

export function fail(res, err, code = 400) {
  res.status(code).json({ error: err?.message || String(err) });
}

// "98765 43210", "+91 98765-43210", "098765..." -> "919876543210"
export function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '').replace(/^0+/, '');
  if (d.length === 10) return '91' + d;
  if (d.length >= 11 && d.length <= 15) return d;
  return null;
}

// Replace {name}, {code}, ... in each template parameter. Meta rejects empty params, so fall back to "-".
export function fill(params, vars) {
  return (params || []).map(p => String(p).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '') || '-');
}

export function token(bytes = 6) {
  return crypto.randomBytes(bytes).toString('base64url');
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I to avoid misreading at the counter
export function couponCode() {
  return Array.from(crypto.randomBytes(6), b => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

export async function sendTemplate(biz, to, templateName, lang, params) {
  if (!biz.wa_phone_number_id || !biz.wa_token) throw new Error('WhatsApp is not connected for this business');
  const version = process.env.GRAPH_VERSION || 'v23.0';
  const r = await fetch(`https://graph.facebook.com/${version}/${biz.wa_phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${biz.wa_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: lang || 'en' },
        components: params.length
          ? [{ type: 'body', parameters: params.map(text => ({ type: 'text', text })) }]
          : [],
      },
    }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error?.error_data?.details || body.error?.message || `WhatsApp error ${r.status}`);
  return body.messages[0].id;
}
