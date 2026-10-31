// Campaigns (bulk offers/messages), batch sending, and the daily birthday job.
import {
  db, HttpError, bad, scopeBiz, loadOwned, safeEqual, str, int, tags, params, templateName, langCode,
  fill, couponCode, fmtExpiry, sendTemplate,
} from '../core.js';

const BATCH = 20;
const SEGMENTS = ['all', 'tag', 'inactive', 'regulars', 'new'];

// Build the audience query for a segment. Only opted-in, not-unsubscribed customers are ever messaged.
function audience(bizId, segment, value, tag) {
  let q = db.from('customers').select('id', { count: 'exact' }).eq('business_id', bizId)
    .is('opted_out_at', null).not('consent_at', 'is', null);
  const daysAgo = n => new Date(Date.now() - n * 864e5).toISOString();
  if (segment === 'tag') q = q.contains('tags', [tag]);
  if (segment === 'inactive') q = q.lt('last_visit_at', daysAgo(value));   // visited before, but not in N days
  if (segment === 'regulars') q = q.gte('visits', value);
  if (segment === 'new') q = q.gte('created_at', daysAgo(value));
  return q;
}

function readSegment(b) {
  const segment = SEGMENTS.includes(b.segment) ? b.segment : 'all';
  const tag = segment === 'tag' ? tags(b.tag)[0] : null;
  if (segment === 'tag' && !tag) throw bad('Enter the tag to send to');
  const value = segment === 'inactive' ? int(b.segment_value, 1, 3650, 'Days') ?? 30
    : segment === 'regulars' ? int(b.segment_value, 1, 1000, 'Visits') ?? 3
    : segment === 'new' ? int(b.segment_value, 1, 3650, 'Days') ?? 30 : null;
  return { segment, tag, value };
}

export async function preview(req, res, ctx) {
  const b = req.body || {};
  const bizId = scopeBiz(ctx, b.business_id);
  const { segment, tag, value } = readSegment(b);
  const { count, error } = await audience(bizId, segment, value, tag).limit(1);
  if (error) throw error;
  res.json({ count });
}

export async function campaigns(req, res, ctx) {
  if (req.method === 'GET') {
    const bizId = scopeBiz(ctx, req.query.business_id);
    const { data, error } = await db.from('campaign_stats').select('*')
      .eq('business_id', bizId).order('created_at', { ascending: false }).limit(100);
    if (error) throw error;
    return res.json(data);
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');

  const b = req.body || {};
  const bizId = scopeBiz(ctx, b.business_id);
  const name = str(b.name, 80, 'Campaign name');
  const kind = b.kind === 'message' ? 'message' : 'offer';
  const template_name = templateName(b.template_name);
  if (!name || !template_name) throw bad('Campaign name and template are required');
  const offer_percent = kind === 'offer' ? int(b.offer_percent, 1, 100, 'Discount %') : null;
  const offer_valid_days = kind === 'offer' ? int(b.offer_valid_days, 1, 365, 'Valid days') ?? 30 : null;
  if (kind === 'offer' && !offer_percent) throw bad('Set the discount %');
  const { segment, tag, value } = readSegment(b);

  const { data: people, error: audErr } = await audience(bizId, segment, value, tag).range(0, 49999);
  if (audErr) throw audErr;
  if (!people.length) throw bad('No customers match this audience');

  const { data: camp, error } = await db.from('campaigns').insert({
    business_id: bizId, name, kind, template_name, template_lang: langCode(b.template_lang),
    params: params(b.params, 'Template variables'), tag, segment, segment_value: value, offer_percent, offer_valid_days,
  }).select().single();
  if (error) throw error;

  const expires = offer_valid_days && new Date(Date.now() + offer_valid_days * 864e5).toISOString();
  for (let i = 0; i < people.length; i += 500) {
    const chunk = people.slice(i, i + 500);
    const { error: mErr } = await db.from('messages').insert(chunk.map(c => ({ business_id: bizId, campaign_id: camp.id, customer_id: c.id })));
    if (mErr) throw mErr;
    if (kind === 'offer') {
      const { error: cErr } = await db.from('coupons').insert(chunk.map(c => ({
        business_id: bizId, campaign_id: camp.id, customer_id: c.id, code: couponCode(), percent: offer_percent, expires_at: expires,
      })));
      if (cErr) throw cErr;
    }
  }
  res.json({ id: camp.id, queued: people.length });
}

// Send the next batch (max 20) of a campaign. The dashboard calls this in a loop until remaining = 0.
// Respects the business's 24-hour unique-customer limit (250 for unverified Meta accounts).
export async function sendBatch(req, res, ctx) {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const camp = await loadOwned('campaigns', req.body?.campaign_id, ctx, '*, businesses(*)');
  const biz = camp.businesses;

  const since = new Date(Date.now() - 864e5).toISOString();
  const { data: recent, error: rErr } = await db.from('messages').select('customer_id')
    .eq('business_id', biz.id).gte('sent_at', since).range(0, 99999);
  if (rErr) throw rErr;
  const room = biz.daily_limit - new Set(recent.map(r => r.customer_id)).size;

  let sent = 0, failed = 0, lastError = null;
  if (room > 0) {
    const { data: next } = await db.from('messages').select('id')
      .eq('campaign_id', camp.id).eq('status', 'queued').limit(Math.min(BATCH, room));
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
        .eq('campaign_id', camp.id).in('customer_id', claimed.map(m => m.customer_id));
      for (const c of data) coupons[c.customer_id] = c;
    }

    await Promise.all(claimed.map(async m => {
      const c = m.customers;
      try {
        if (c.opted_out_at) throw new Error('Customer unsubscribed');
        const coupon = coupons[m.customer_id];
        const values = fill(camp.params, {
          name: c.name || 'there', business: biz.name, percent: camp.offer_percent ?? '',
          code: coupon?.code ?? '', expiry: coupon ? fmtExpiry(coupon.expires_at) : '',
        });
        const waId = await sendTemplate(biz, c.phone, camp.template_name, camp.template_lang, values);
        await db.from('messages').update({ status: 'sent', wa_message_id: waId, sent_at: new Date().toISOString() }).eq('id', m.id);
        sent++;
      } catch (e) {
        lastError = e.message;
        await db.from('messages').update({ status: 'failed', error: e.message.slice(0, 500) }).eq('id', m.id);
        failed++;
      }
    }));
  }

  const { count: remaining } = await db.from('messages').select('id', { count: 'exact', head: true })
    .eq('campaign_id', camp.id).eq('status', 'queued');
  if (remaining === 0) await db.from('campaigns').update({ status: 'done' }).eq('id', camp.id);

  res.json({ sent, failed, remaining, last_error: lastError, limited: remaining > 0 && room - sent - failed <= 0 });
}

// Vercel Cron calls this every morning (see vercel.json). Sends a birthday coupon to today's birthdays.
export async function cronBirthdays(req, res) {
  const want = process.env.CRON_SECRET;
  if (!want || !safeEqual(req.headers.authorization || '', `Bearer ${want}`)) throw new HttpError(401, 'Unauthorized');

  const today = new Date(Date.now() + 5.5 * 36e5);  // India date
  const { data: people, error } = await db.rpc('birthdays_today', { p_month: today.getUTCMonth() + 1, p_day: today.getUTCDate() });
  if (error) throw error;
  if (!people.length) return res.json({ sent: 0, failed: 0 });

  const { data: bizList } = await db.from('businesses').select('*').in('id', [...new Set(people.map(p => p.business_id))]);
  const bizById = Object.fromEntries(bizList.map(b => [b.id, b]));
  const expires = new Date(Date.now() + 7 * 864e5).toISOString();
  let sent = 0, failed = 0;

  for (const p of people) {
    const biz = bizById[p.business_id];
    const code = couponCode();
    const { error: cErr } = await db.from('coupons').insert({
      business_id: biz.id, customer_id: p.customer_id, code, percent: biz.birthday_percent, expires_at: expires, reason: 'birthday',
    });
    if (cErr) { failed++; continue; }
    try {
      const values = fill(biz.birthday_params, {
        name: p.name || 'there', business: biz.name, percent: biz.birthday_percent, code, expiry: fmtExpiry(expires),
      });
      const waId = await sendTemplate(biz, p.phone, biz.birthday_template, biz.birthday_lang, values);
      await db.from('messages').insert({ business_id: biz.id, customer_id: p.customer_id, status: 'sent', wa_message_id: waId, sent_at: new Date().toISOString() });
      sent++;
    } catch (e) {
      // Drop the unsent coupon so tomorrow's run doesn't think this customer was already wished.
      await db.from('coupons').delete().eq('business_id', biz.id).eq('code', code);
      await db.from('messages').insert({ business_id: biz.id, customer_id: p.customer_id, status: 'failed', error: e.message.slice(0, 500) });
      failed++;
    }
  }
  res.json({ sent, failed });
}
