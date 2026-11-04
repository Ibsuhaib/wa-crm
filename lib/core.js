// Shared server code: database client, auth, tenant scoping, validation, WhatsApp sending.
import { createClient } from '@supabase/supabase-js';
import crypto from 'node:crypto';

export const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const bad = msg => new HttpError(400, msg);

export function fail(res, err) {
  if (err instanceof SyntaxError) err = new HttpError(400, 'Invalid request body');
  const status = err?.status || 500;
  if (status >= 500) console.error(err);
  // Never leak database internals to the browser on unexpected errors.
  res.status(status).json({ error: status >= 500 ? 'Something went wrong. Please try again.' : err.message });
}

export function safeEqual(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// ---------- sessions: "<payload>.<hmac>" signed with SESSION_SECRET ----------

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new HttpError(500, 'SESSION_SECRET is not configured');
  return s;
}
const sign = data => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

export function makeToken(payload, hours) {
  const data = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + hours * 36e5 })).toString('base64url');
  return data + '.' + sign(data);
}

function readToken(token) {
  const [data, mac] = String(token || '').split('.');
  if (!data || !mac || !safeEqual(mac, sign(data))) return null;
  try {
    const p = JSON.parse(Buffer.from(data, 'base64url').toString());
    return p.exp > Date.now() ? p : null;
  } catch { return null; }
}

// Returns { admin: true } or { admin: false, businessId }. Throws 401 when not logged in.
export async function authenticate(req) {
  const h = String(req.headers.authorization || '');
  const p = readToken(h.startsWith('Bearer ') ? h.slice(7) : '');
  if (!p) throw new HttpError(401, 'Please log in again');
  if (p.r === 'admin') return { admin: true };
  const { data: b } = await db.from('businesses').select('id, active, session_version').eq('id', p.b).maybeSingle();
  if (!b || !b.active || b.session_version !== p.v) throw new HttpError(401, 'Please log in again');
  return { admin: false, businessId: b.id };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = v => UUID.test(String(v || ''));

// Which business this request may act on. Owners are always pinned to their own business.
export function scopeBiz(ctx, requested) {
  if (!ctx.admin) {
    if (requested && requested !== ctx.businessId) throw new HttpError(403, 'Not your business');
    return ctx.businessId;
  }
  if (!isUuid(requested)) throw bad('Pick a business first');
  return requested;
}

// Load a row by id and make sure it belongs to a business this user can access.
export async function loadOwned(table, id, ctx, select = '*') {
  if (!isUuid(id)) throw new HttpError(404, 'Not found');
  const { data, error } = await db.from(table).select(select).eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data || (!ctx.admin && data.business_id !== ctx.businessId)) throw new HttpError(404, 'Not found');
  return data;
}

// ---------- passwords (scrypt) ----------

export function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString('base64url')}$${crypto.scryptSync(pw, salt, 32).toString('base64url')}`;
}
export function verifyPassword(pw, stored) {
  const [, salt, hash] = String(stored || 'scrypt$AAAAAAAAAAAAAAAAAAAAAA$x').split('$');
  const got = crypto.scryptSync(String(pw), Buffer.from(salt, 'base64url'), 32).toString('base64url');
  return safeEqual(got, hash) && !!stored;
}

// ---------- validation ----------

export function str(v, max, label = 'Text') {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (s.length > max) throw bad(`${label} is too long (max ${max} characters)`);
  return s || null;
}
export function int(v, min, max, label = 'Number') {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw bad(`${label} must be a whole number from ${min} to ${max}`);
  return n;
}
export function num(v, min, max, label = 'Amount') {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw bad(`${label} must be between ${min} and ${max}`);
  return Math.round(n * 100) / 100;
}
export function tags(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(/[;,|]/);
  return [...new Set(list.map(t => String(t).trim().toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').slice(0, 30)).filter(Boolean))].slice(0, 10);
}
export function httpsUrl(v, label) {
  const s = str(v, 500, label);
  if (!s) return null;
  let u;
  try { u = new URL(s); } catch { throw bad(`${label} must be a full link starting with https://`); }
  if (u.protocol !== 'https:') throw bad(`${label} must start with https://`);
  return u.toString();
}
export function isoDate(v) {
  if (!v) return null;
  const s = String(v);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(Date.parse(s))) throw bad('Birthday must be a valid date');
  return s;
}

// "98765 43210", "+91 98765-43210", "098765..." -> "919876543210"
export function normalizePhone(raw) {
  const d = String(raw || '').replace(/\D/g, '').replace(/^0+/, '');
  if (d.length === 10 && /^[6-9]/.test(d)) return '91' + d;
  if (d.length >= 11 && d.length <= 15) return d;
  return null;
}

// Replace {name}, {code}, ... in each template parameter. Meta rejects empty params, so fall back to "-".
export function fill(list, vars) {
  return (list || []).map(p => String(p).replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '').trim() || '-');
}

export const token = (bytes = 9) => crypto.randomBytes(bytes).toString('base64url');

// ---------- WhatsApp Cloud API ----------

// Any other Graph call (templates). Throws a 400 carrying Meta's own explanation.
export async function metaApi(biz, path, { method = 'GET', body } = {}) {
  const version = process.env.GRAPH_VERSION || 'v23.0';
  const r = await fetch(`https://graph.facebook.com/${version}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${biz.wa_token}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const json = await r.json().catch(() => ({}));
  if (!r.ok) throw bad(json.error?.error_user_msg || json.error?.message || `WhatsApp error ${r.status}`);
  return json;
}

async function graph(biz, payload) {
  if (!biz.wa_phone_number_id || !biz.wa_token) throw new Error('WhatsApp is not connected for this business');
  const version = process.env.GRAPH_VERSION || 'v23.0';
  const r = await fetch(`https://graph.facebook.com/${version}/${biz.wa_phone_number_id}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${biz.wa_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', ...payload }),
    signal: AbortSignal.timeout(8000),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error?.error_data?.details || body.error?.message || `WhatsApp error ${r.status}`);
  return body.messages[0].id;
}

export function sendTemplate(biz, to, name, lang, values) {
  return graph(biz, {
    to, type: 'template',
    template: {
      name, language: { code: lang || 'en' },
      components: values.length ? [{ type: 'body', parameters: values.map(text => ({ type: 'text', text })) }] : [],
    },
  });
}

// Free-form text: only allowed within 24 hours of the customer messaging the business.
export function sendText(biz, to, body) {
  return graph(biz, { to, type: 'text', text: { body } });
}
