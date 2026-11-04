// Sending a message to selected customers, the sent-messages list, and the daily job.
import { db, HttpError, bad, scopeBiz, loadOwned, safeEqual, isUuid } from '../core.js';
import { filterCustomers } from './customers.js';
import { sendable, syncTemplates, deliver, roomToday } from './templates.js';
import { sendBirthdays } from './birthdays.js';

const BATCH = 20;
const PAGE = 50;

// Every customer id matching the list filters, 1000 at a time (the database caps each read).
async function matchingIds(bizId, filters) {
  const ids = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await filterCustomers(db.from('customers').select('id').eq('business_id', bizId), filters)
      .order('id').range(from, from + 999);
    if (error) throw error;
    ids.push(...data.map(c => c.id));
    if (data.length < 1000) return ids;
  }
}

// Queue a template for selected customers: { template_id, ids: [...] } or { template_id, all: true, filters }.
export async function send(req, res, ctx) {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const b = req.body || {};
  const bizId = scopeBiz(ctx, b.business_id);
  const { data: biz, error: bizErr } = await db.from('businesses').select('*').eq('id', bizId).single();
  if (bizErr) throw bizErr;

  // Ask Meta first, so a template it has just re-labelled Marketing can't go out in bulk.
  if (biz.wa_waba_id && biz.wa_token) await syncTemplates(biz).catch(e => console.error('template sync', e.message));
  const t = await loadOwned('templates', b.template_id, ctx);
  if (t.business_id !== bizId) throw new HttpError(404, 'Not found');
  if (t.purpose !== 'visit' || !sendable(t)) throw bad('This message is not approved as a low-cost message');

  const ids = b.all ? await matchingIds(bizId, b.filters || {}) : (Array.isArray(b.ids) ? b.ids : []).filter(isUuid);
  if (!ids.length) throw bad('Select at least one customer');
  if (ids.length > 50000) throw bad('Select at most 50,000 customers at a time');

  const { data: camp, error } = await db.from('campaigns').insert({
    business_id: bizId, name: t.title, kind: 'message', template_name: t.name, template_lang: t.lang,
    params: t.params, segment: 'selected',
  }).select('id').single();
  if (error) throw error;
  const { data: queued, error: qErr } = await db.rpc('queue_messages', {
    p_business: bizId, p_campaign: camp.id, p_customers: ids, p_template: t.name, p_days: biz.repeat_days,
  });
  if (qErr) throw qErr;
  if (!queued) await db.from('campaigns').delete().eq('id', camp.id);
  res.json({ id: queued ? camp.id : null, queued, skipped: ids.length - queued });
}

// Send the next batch (max 20). The dashboard calls this in a loop until remaining = 0.
// Respects the business's 24-hour unique-customer limit (250 for unverified Meta accounts).
export async function sendBatch(req, res, ctx) {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const camp = await loadOwned('campaigns', req.body?.campaign_id, ctx, '*, businesses(*)');
  const biz = camp.businesses;

  const { data: t } = await db.from('templates').select('*')
    .eq('business_id', biz.id).eq('name', camp.template_name).eq('lang', camp.template_lang).maybeSingle();
  if (!t || !sendable(t)) {
    await db.from('messages').update({ status: 'failed', error: 'Message is no longer approved' }).eq('campaign_id', camp.id).eq('status', 'queued');
    await db.from('campaigns').update({ status: 'done' }).eq('id', camp.id);
    throw bad('This message is no longer approved, so sending stopped');
  }

  const room = await roomToday(biz);

  let sent = 0, failed = 0, lastError = null;
  if (room > 0) {
    const { data: next } = await db.from('messages').select('id')
      .eq('campaign_id', camp.id).eq('status', 'queued').limit(Math.min(BATCH, room));
    // Claim the rows so two open tabs can't send the same message twice.
    const { data: claimed, error: cErr } = next.length
      ? await db.from('messages').update({ status: 'sending' })
        .in('id', next.map(m => m.id)).eq('status', 'queued')
        .select('id, customer_id, customers(id, phone, name, opted_out_at)')
      : { data: [] };
    if (cErr) throw cErr;

    await Promise.all(claimed.map(async m => {
      if (m.customers.opted_out_at) {
        await db.from('messages').update({ status: 'failed', error: 'Customer unsubscribed' }).eq('id', m.id);
        failed++;
        return;
      }
      const r = await deliver(biz, t, m.customers, m.id);
      if (r.ok) sent++; else { failed++; lastError = r.error; }
    }));
  }

  const { count: remaining } = await db.from('messages').select('id', { count: 'exact', head: true })
    .eq('campaign_id', camp.id).eq('status', 'queued');
  if (remaining === 0) await db.from('campaigns').update({ status: 'done' }).eq('id', camp.id);

  res.json({ sent, failed, remaining, last_error: lastError, limited: remaining > 0 && room - sent - failed <= 0 });
}

// What was sent, newest first. Read-only for everyone.
export async function messages(req, res, ctx) {
  if (req.method !== 'GET') throw new HttpError(405, 'Method not allowed');
  const bizId = scopeBiz(ctx, req.query.business_id);
  const page = Math.max(0, parseInt(req.query.page) || 0);
  const { data, count, error } = await db.from('messages')
    .select('id, status, error, preview, template_name, sent_at, created_at, customers(name, phone)', { count: 'exact' })
    .eq('business_id', bizId).neq('status', 'queued')
    .order('created_at', { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1);
  if (error) throw error;
  const { data: pending, error: pErr } = await db.from('campaign_stats').select('id, name, queued')
    .eq('business_id', bizId).gt('queued', 0).order('created_at', { ascending: false });
  if (pErr) throw pErr;
  res.json({ rows: data, total: count, page, limit: PAGE, pending });
}

// Vercel Cron calls this at 9 AM IST (see vercel.json). Templates first, so a template Meta has
// re-labelled or paused stops sending, then today's birthday wishes.
export async function cronDaily(req, res) {
  const want = process.env.CRON_SECRET;
  if (!want || !safeEqual(req.headers.authorization || '', `Bearer ${want}`)) throw new HttpError(401, 'Unauthorized');
  const { data: list, error } = await db.from('businesses').select('id, wa_waba_id, wa_token')
    .eq('active', true).not('wa_waba_id', 'is', null).not('wa_token', 'is', null);
  if (error) throw error;
  let synced = 0, failed = 0;
  for (const b of list) {
    try { await syncTemplates(b); synced++; } catch (e) { console.error('template sync', b.id, e.message); failed++; }
  }
  res.json({ synced, failed, birthdays: await sendBirthdays() });
}
