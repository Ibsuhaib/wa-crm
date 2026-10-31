// Check a customer in at the counter. Creates them if new, and optionally sends the review request.
import { db, isAdmin, fail, normalizePhone, fill, token, sendTemplate } from './_lib.js';

export default async function handler(req, res) {
  if (!isAdmin(req, res)) return;
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const { business_id, name, amount, send_review } = req.body;
    const phone = normalizePhone(req.body.phone);
    if (!phone) throw new Error('Enter a valid phone number');

    const { data: biz, error: bizErr } = await db.from('businesses').select('*').eq('id', business_id).single();
    if (bizErr) throw bizErr;

    let { data: cust } = await db.from('customers').select('*')
      .eq('business_id', business_id).eq('phone', phone).maybeSingle();
    if (!cust) {
      const { data, error } = await db.from('customers').insert({ business_id, phone, name: name || null }).select().single();
      if (error) throw error;
      cust = data;
    }
    const { error: updErr } = await db.from('customers').update({
      visits: cust.visits + 1,
      last_visit_at: new Date().toISOString(),
      ...(name && !cust.name ? { name } : {}),
    }).eq('id', cust.id);
    if (updErr) throw updErr;
    await db.from('visits').insert({ business_id, customer_id: cust.id, amount: amount || null });

    let review = 'skipped';
    if (send_review && cust.opted_out_at) review = 'customer opted out';
    else if (send_review && !biz.review_template) review = 'no review template set in Settings';
    else if (send_review) {
      const t = token();
      await db.from('reviews').insert({ business_id, customer_id: cust.id, token: t });
      const params = fill(biz.review_params, {
        name: name || cust.name || 'there',
        business: biz.name,
        link: `${process.env.PUBLIC_URL}/r/${t}`,
      });
      try {
        const waId = await sendTemplate(biz, phone, biz.review_template, biz.review_lang, params);
        await db.from('messages').insert({ business_id, customer_id: cust.id, status: 'sent', wa_message_id: waId, sent_at: new Date().toISOString() });
        review = 'sent';
      } catch (e) {
        await db.from('messages').insert({ business_id, customer_id: cust.id, status: 'failed', error: e.message });
        review = 'failed: ' + e.message;
      }
    }
    res.json({ customer_id: cust.id, visits: cust.visits + 1, review });
  } catch (e) { fail(res, e); }
}
