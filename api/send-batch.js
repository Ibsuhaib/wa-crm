// Send the next batch (max 20) of a campaign. The dashboard calls this in a loop until remaining = 0.
// Respects the business's 24-hour unique-customer limit (250 for unverified Meta accounts).
import { db, isAdmin, fail, fill, sendTemplate } from './_lib.js';

const BATCH = 20;

export default async function handler(req, res) {
  if (!isAdmin(req, res)) return;
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const { campaign_id } = req.body;
    const { data: camp, error } = await db.from('campaigns').select('*, businesses(*)').eq('id', campaign_id).single();
    if (error) throw error;
    const biz = camp.businesses;

    const since = new Date(Date.now() - 864e5).toISOString();
    const { data: recent, error: rErr } = await db.from('messages').select('customer_id')
      .eq('business_id', biz.id).gte('sent_at', since).range(0, 49999);
    if (rErr) throw rErr;
    const room = biz.daily_limit - new Set(recent.map(r => r.customer_id)).size;

    let sent = 0, failed = 0;
    if (room > 0) {
      const { data: next } = await db.from('messages').select('id')
        .eq('campaign_id', campaign_id).eq('status', 'queued').limit(Math.min(BATCH, room));
      // Claim the rows so two open tabs can't send the same message twice.
      const { data: claimed, error: cErr } = next.length
        ? await db.from('messages').update({ status: 'sending' })
          .in('id', next.map(m => m.id)).eq('status', 'queued')
          .select('id, customer_id, customers(phone, name, opted_out_at)')
        : { data: [] };
      if (cErr) throw cErr;

      const coupons = {};
      if (camp.kind === 'offer' && claimed.length) {
        const { data } = await db.from('coupons').select('customer_id, code, expires_at')
          .eq('campaign_id', campaign_id).in('customer_id', claimed.map(m => m.customer_id));
        for (const c of data) coupons[c.customer_id] = c;
      }

      await Promise.all(claimed.map(async m => {
        const c = m.customers;
        try {
          if (c.opted_out_at) throw new Error('Customer opted out');
          const coupon = coupons[m.customer_id];
          const params = fill(camp.params, {
            name: c.name || 'there',
            business: biz.name,
            percent: camp.offer_percent ?? '',
            code: coupon?.code ?? '',
            expiry: coupon ? new Date(coupon.expires_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '',
          });
          const waId = await sendTemplate(biz, c.phone, camp.template_name, camp.template_lang, params);
          await db.from('messages').update({ status: 'sent', wa_message_id: waId, sent_at: new Date().toISOString() }).eq('id', m.id);
          sent++;
        } catch (e) {
          await db.from('messages').update({ status: 'failed', error: e.message }).eq('id', m.id);
          failed++;
        }
      }));
    }

    const { count: remaining } = await db.from('messages').select('id', { count: 'exact', head: true })
      .eq('campaign_id', campaign_id).eq('status', 'queued');
    if (remaining === 0) await db.from('campaigns').update({ status: 'done' }).eq('id', campaign_id);

    res.json({ sent, failed, remaining, limited: remaining > 0 && room - sent - failed <= 0 });
  } catch (e) { fail(res, e); }
}
