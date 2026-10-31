// Coupons at the counter, review inbox, public review page, stats and the QR join code.
import QRCode from 'qrcode';
import { db, HttpError, bad, scopeBiz, normalizePhone, str } from '../core.js';

export async function coupons(req, res, ctx) {
  const src = req.method === 'GET' ? req.query : (req.body || {});
  const bizId = scopeBiz(ctx, src.business_id);
  const now = new Date().toISOString();

  if (req.method === 'GET') {
    // Look up by phone: every unused, unexpired coupon this customer has.
    if (src.phone) {
      const phone = normalizePhone(src.phone);
      if (!phone) throw bad('Enter a valid mobile number');
      const { data: c } = await db.from('customers').select('id, name, phone').eq('business_id', bizId).eq('phone', phone).maybeSingle();
      if (!c) throw new HttpError(404, 'No customer with this number');
      const { data } = await db.from('coupons').select('code, percent, reason, expires_at').eq('customer_id', c.id)
        .is('redeemed_at', null).gt('expires_at', now).order('expires_at');
      return res.json({ customer: c, coupons: data || [] });
    }
    const code = String(src.code || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{4,12}$/.test(code)) throw bad('Enter the coupon code');
    const { data } = await db.from('coupons').select('code, percent, reason, expires_at, redeemed_at, customers(name, phone)')
      .eq('business_id', bizId).eq('code', code).maybeSingle();
    if (!data) throw new HttpError(404, 'No such coupon');
    return res.json(data);
  }

  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const code = String(src.code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{4,12}$/.test(code)) throw bad('Enter the coupon code');
  // Single conditional update, so the same code can never be redeemed twice.
  const { data, error } = await db.from('coupons').update({ redeemed_at: now })
    .eq('business_id', bizId).eq('code', code).is('redeemed_at', null).gt('expires_at', now)
    .select('code, percent, reason, expires_at, redeemed_at, customers(name, phone)').maybeSingle();
  if (error) throw error;
  if (data) return res.json(data);

  const { data: existing } = await db.from('coupons').select('redeemed_at, expires_at').eq('business_id', bizId).eq('code', code).maybeSingle();
  if (!existing) throw new HttpError(404, 'No such coupon');
  const when = d => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
  if (existing.redeemed_at) throw new HttpError(409, 'Already used on ' + when(existing.redeemed_at));
  throw new HttpError(409, 'Expired on ' + when(existing.expires_at));
}

// Ratings and complaints inbox for the owner.
export async function reviews(req, res, ctx) {
  const bizId = scopeBiz(ctx, req.query.business_id);
  let q = db.from('reviews').select('id, rating, feedback, rated_at, customers(id, name, phone)')
    .eq('business_id', bizId).not('rated_at', 'is', null).order('rated_at', { ascending: false }).limit(200);
  if (req.query.filter === 'low') q = q.lte('rating', 3);
  const { data, error } = await q;
  if (error) throw error;
  res.json(data);
}

export async function stats(req, res, ctx) {
  const bizId = scopeBiz(ctx, req.query.business_id);
  const { data, error } = await db.rpc('business_stats', { p_business: bizId });
  if (error) throw error;
  res.json(data);
}

// QR code customers scan to join: opens WhatsApp with "JOIN" typed, which the webhook turns into a sign-up.
export async function qr(req, res, ctx) {
  const bizId = scopeBiz(ctx, req.query.business_id);
  const { data: b } = await db.from('businesses').select('name, wa_number').eq('id', bizId).single();
  if (!b.wa_number) throw bad('Add the shop\'s WhatsApp number in Settings first');
  const link = `https://wa.me/${b.wa_number}?text=${encodeURIComponent('JOIN')}`;
  const svg = await QRCode.toString(link, { type: 'svg', margin: 1, errorCorrectionLevel: 'M', color: { dark: '#0b1220', light: '#ffffff' } });
  res.json({ link, svg, name: b.name });
}

// ---------- public: the page customers open from the WhatsApp review message ----------

const TOKEN = /^[\w-]{8,32}$/;

export async function review(req, res) {
  const t = String((req.method === 'GET' ? req.query.t : req.body?.t) || '');
  if (!TOKEN.test(t)) throw new HttpError(404, 'This link is not valid');
  const { data: r } = await db.from('reviews').select('id, rating, feedback, rated_at, businesses(name, google_review_url)')
    .eq('token', t).maybeSingle();
  if (!r) throw new HttpError(404, 'This link is not valid');
  const google = r.businesses.google_review_url || null;

  if (req.method === 'GET') return res.json({ business: r.businesses.name, rated: !!r.rating, rating: r.rating, google });
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');

  const feedback = str(req.body.feedback, 2000, 'Feedback');
  if (!r.rating) {
    const rating = Number(req.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw bad('Pick 1 to 5 stars');
    // Conditional update: the first rating wins, a replayed request can't overwrite it.
    const { data, error } = await db.from('reviews').update({ rating, feedback, rated_at: new Date().toISOString() })
      .eq('id', r.id).is('rating', null).select('id');
    if (error) throw error;
    if (!data.length) throw new HttpError(409, 'Thanks, you already rated this visit');
    return res.json({ ok: true, google });
  }
  // Already rated: allow adding written feedback once, within an hour.
  if (feedback && !r.feedback && Date.now() - new Date(r.rated_at) < 36e5) {
    await db.from('reviews').update({ feedback }).eq('id', r.id).is('feedback', null);
    return res.json({ ok: true, google });
  }
  throw new HttpError(409, 'Thanks, you already rated this visit');
}
