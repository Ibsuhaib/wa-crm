// Look up (GET) or redeem (POST) a coupon at the counter.
import { db, isAdmin, fail } from './_lib.js';

export default async function handler(req, res) {
  if (!isAdmin(req, res)) return;
  try {
    const { business_id, code } = req.method === 'GET' ? req.query : req.body;
    const clean = String(code || '').trim().toUpperCase();
    const find = () => db.from('coupons').select('*, customers(name, phone)')
      .eq('business_id', business_id).eq('code', clean).maybeSingle();

    if (req.method === 'GET') {
      const { data, error } = await find();
      if (error) throw error;
      if (!data) throw new Error('No such coupon');
      return res.json(data);
    }
    if (req.method !== 'POST') return res.status(405).end();

    const now = new Date().toISOString();
    // Single conditional update, so the same code can never be redeemed twice.
    const { data, error } = await db.from('coupons').update({ redeemed_at: now })
      .eq('business_id', business_id).eq('code', clean).is('redeemed_at', null).gt('expires_at', now)
      .select('*, customers(name, phone)').maybeSingle();
    if (error) throw error;
    if (data) return res.json(data);

    const { data: existing } = await find();
    if (!existing) throw new Error('No such coupon');
    if (existing.redeemed_at) throw new Error('Already used on ' + new Date(existing.redeemed_at).toLocaleString('en-IN'));
    throw new Error('Expired on ' + new Date(existing.expires_at).toLocaleDateString('en-IN'));
  } catch (e) { fail(res, e); }
}
