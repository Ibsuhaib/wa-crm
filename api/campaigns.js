// Create a campaign: picks the audience, queues one message per customer and (for offers) a unique coupon each.
// Sending happens in small batches through /api/send-batch so no request hits Vercel's time limit.
import { db, isAdmin, fail, couponCode } from './_lib.js';

export default async function handler(req, res) {
  if (!isAdmin(req, res)) return;
  try {
    if (req.method === 'GET') {
      const { data, error } = await db.from('campaign_stats').select('*')
        .eq('business_id', req.query.business_id).order('created_at', { ascending: false });
      if (error) throw error;
      return res.json(data);
    }
    if (req.method !== 'POST') return res.status(405).end();

    const { business_id, name, kind = 'message', template_name, template_lang = 'en', params = [], tag,
      offer_percent, offer_valid_days = 30 } = req.body;
    if (!name || !template_name) throw new Error('Name and template are required');
    if (kind === 'offer' && !(offer_percent > 0)) throw new Error('Set the discount %');

    let q = db.from('customers').select('id').eq('business_id', business_id).is('opted_out_at', null).range(0, 49999);
    if (tag) q = q.contains('tags', [tag]);
    const { data: audience, error: audErr } = await q;
    if (audErr) throw audErr;
    if (!audience.length) throw new Error('No customers match this audience');

    const { data: camp, error } = await db.from('campaigns').insert({
      business_id, name, kind, template_name, template_lang, params, tag: tag || null,
      offer_percent: kind === 'offer' ? offer_percent : null,
      offer_valid_days: kind === 'offer' ? offer_valid_days : null,
    }).select().single();
    if (error) throw error;

    const expires = new Date(Date.now() + offer_valid_days * 864e5).toISOString();
    for (let i = 0; i < audience.length; i += 500) {
      const chunk = audience.slice(i, i + 500);
      const { error: mErr } = await db.from('messages').insert(
        chunk.map(c => ({ business_id, campaign_id: camp.id, customer_id: c.id })));
      if (mErr) throw mErr;
      if (kind === 'offer') {
        const { error: cErr } = await db.from('coupons').insert(chunk.map(c => ({
          business_id, campaign_id: camp.id, customer_id: c.id,
          code: couponCode(), percent: offer_percent, expires_at: expires,
        })));
        if (cErr) throw cErr;
      }
    }
    res.json({ id: camp.id, queued: audience.length });
  } catch (e) { fail(res, e); }
}
