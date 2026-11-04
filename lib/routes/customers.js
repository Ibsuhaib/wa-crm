// Customer list, import, edit, detail and counter check-in.
import { db, HttpError, bad, scopeBiz, loadOwned, normalizePhone, str, num, tags, isoDate } from '../core.js';
import { sendable, deliver } from './templates.js';

const MAX_IMPORT = 5000;
const clean = s => String(s || '').replace(/[^\p{L}\p{N} ]/gu, '').slice(0, 50);

const when = (v, label) => {
  const d = new Date(v);
  if (isNaN(d)) throw bad(label + ' is not a valid date and time');
  return d.toISOString();
};

// The list filters, shared by the customer list and "send to all matching".
export function filterCustomers(q, f) {
  const term = clean(f.q);
  if (term) q = q.or(`phone.ilike.%${term.replace(/\D/g, '') || '_none_'}%,name.ilike.%${term}%`);
  if (f.group === 'vip') q = q.contains('tags', ['vip']);
  if (f.group === 'common') q = q.not('tags', 'cs', '{vip}');
  if (f.group === 'opted_out') q = q.not('opted_out_at', 'is', null);
  if (f.from) q = q.gte('last_visit_at', when(f.from, 'From'));
  if (f.to) q = q.lte('last_visit_at', when(f.to, 'To'));
  return q;
}

export async function customers(req, res, ctx) {
  if (req.method === 'GET') {
    const biz = scopeBiz(ctx, req.query.business_id);
    const all = req.query.all === '1';  // CSV export
    const limit = all ? 10000 : 50, page = Math.max(0, parseInt(req.query.page) || 0);
    const { data, count, error } = await filterCustomers(db.from('customers').select('*', { count: 'exact' }).eq('business_id', biz), req.query)
      .order('last_visit_at', { ascending: false, nullsFirst: false }).order('created_at', { ascending: false })
      .range(page * limit, page * limit + limit - 1);
    if (error) throw error;
    return res.json({ rows: data, total: count, page, limit });
  }

  // Add one customer or a whole CSV import: { business_id, consent: true, customers: [{ phone, name, tags, birthday }] }
  if (req.method === 'POST') {
    const { customers: list = [], consent, source } = req.body || {};
    const biz = scopeBiz(ctx, req.body?.business_id);
    if (!Array.isArray(list) || !list.length) throw bad('Nothing to import');
    if (list.length > MAX_IMPORT) throw bad(`Import at most ${MAX_IMPORT} customers at a time`);
    if (consent !== true) throw bad('Please confirm these customers agreed to get WhatsApp messages');

    const rows = [], invalid = [], seen = new Set();
    for (const c of list) {
      const phone = normalizePhone(c?.phone);
      if (!phone) { invalid.push(String(c?.phone ?? '').slice(0, 20)); continue; }
      if (seen.has(phone)) continue;
      seen.add(phone);
      let birthday = null;
      try { birthday = isoDate(c.birthday); } catch { /* ignore a bad birthday in a CSV row */ }
      rows.push({ business_id: biz, phone, name: str(c.name, 80, 'Name'), tags: tags(c.tags), birthday,
        source: source === 'manual' ? 'manual' : 'import', consent_at: new Date().toISOString() });
    }
    // Every row in a bulk upsert must have the same columns, so merge with what is already saved:
    // a re-import never wipes an existing name/birthday, only adds tags, and never re-subscribes an opted-out customer.
    let added = 0;
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const { data: existing, error: exErr } = await db.from('customers')
        .select('phone, name, tags, birthday, source, consent_at').eq('business_id', biz).in('phone', chunk.map(r => r.phone));
      if (exErr) throw exErr;
      const old = Object.fromEntries(existing.map(e => [e.phone, e]));
      for (const r of chunk) {
        const o = old[r.phone];
        if (!o) { added++; continue; }
        r.name ||= o.name;
        r.birthday ||= o.birthday;
        r.tags = [...new Set([...o.tags, ...r.tags])].slice(0, 10);
        r.source = o.source;
        r.consent_at = o.consent_at || r.consent_at;
      }
      const { error } = await db.from('customers').upsert(chunk, { onConflict: 'business_id,phone' });
      if (error) throw error;
    }
    return res.json({ saved: rows.length, added, updated: rows.length - added, invalid });
  }

  if (req.method === 'PATCH') {
    const c = await loadOwned('customers', req.query.id, ctx, 'id, business_id, consent_at, opted_out_at');
    const b = req.body || {}, row = {};
    if (b.name !== undefined) row.name = str(b.name, 80, 'Name');
    if (b.tags !== undefined) row.tags = tags(b.tags);
    if (b.birthday !== undefined) row.birthday = isoDate(b.birthday);
    // Staff can unsubscribe someone, but only the customer can re-subscribe (by replying START).
    if (b.opted_out === true && !c.opted_out_at) row.opted_out_at = new Date().toISOString();
    if (b.opted_out === false && c.opted_out_at) throw bad('Only the customer can re-subscribe, by sending START on WhatsApp');
    if (b.consent === true && !c.consent_at) row.consent_at = new Date().toISOString();
    const { error } = await db.from('customers').update(row).eq('id', c.id);
    if (error) throw error;
    return res.json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const c = await loadOwned('customers', req.query.id, ctx, 'id, business_id');
    const { error } = await db.from('customers').delete().eq('id', c.id);
    if (error) throw error;
    return res.json({ ok: true });
  }
  throw new HttpError(405, 'Method not allowed');
}

export async function customerDetail(req, res, ctx) {
  const c = await loadOwned('customers', req.query.id, ctx);
  const [visits, reviews] = await Promise.all([
    db.from('visits').select('amount, created_at').eq('customer_id', c.id).order('created_at', { ascending: false }).limit(50),
    db.from('reviews').select('rating, feedback, rated_at, created_at').eq('customer_id', c.id).order('created_at', { ascending: false }).limit(20),
  ]);
  res.json({ ...c, visit_list: visits.data || [], reviews: reviews.data || [] });
}

// The thank-you message at check-in. Returns what happened, in words for the cashier.
async function checkinMessage(biz, cust) {
  if (cust.opted_out_at) return 'skipped: customer unsubscribed';
  if (!cust.consent_at) return 'skipped: no WhatsApp consent';
  const { data: t } = biz.checkin_template_id
    ? await db.from('templates').select('*').eq('id', biz.checkin_template_id).maybeSingle()
    : { data: null };
  if (!t || t.purpose !== 'visit') return 'skipped: no check-in message set up yet';
  if (!sendable(t)) return 'skipped: message is waiting for approval';

  const { data: id, error } = await db.rpc('claim_message', {
    p_business: biz.id, p_customer: cust.id, p_template: t.name, p_days: biz.repeat_days,
  });
  if (error) throw error;
  if (!id) {
    const { data: last } = await db.from('messages').select('sent_at').eq('customer_id', cust.id).eq('template_name', t.name)
      .neq('status', 'failed').order('sent_at', { ascending: false, nullsFirst: false }).limit(1).maybeSingle();
    const day = new Date(last?.sent_at || Date.now()).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });
    return `skipped: already sent on ${day}`;
  }
  const r = await deliver(biz, t, cust, id);
  return r.ok ? 'sent' : 'failed: ' + r.error;
}

// Check a customer in at the counter. Creates them if new, handles loyalty and the thank-you message.
export async function visits(req, res, ctx) {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const b = req.body || {};
  const bizId = scopeBiz(ctx, b.business_id);
  const phone = normalizePhone(b.phone);
  if (!phone) throw bad('Enter a valid 10-digit mobile number');
  const name = str(b.name, 80, 'Name');
  const amount = num(b.amount, 0, 10000000, 'Bill amount');
  const birthday = isoDate(b.birthday);

  const { data: biz, error: bizErr } = await db.from('businesses').select('*').eq('id', bizId).single();
  if (bizErr) throw bizErr;
  const { data: rows, error } = await db.rpc('record_visit', {
    p_business: bizId, p_phone: phone, p_name: name, p_amount: amount, p_consent: b.consent !== false, p_birthday: birthday,
  });
  if (error) throw error;
  const cust = rows[0];

  let reward = null;
  if (biz.loyalty_every > 0 && cust.visits % biz.loyalty_every === 0) reward = biz.loyalty_reward || 'Loyalty reward';
  const nextReward = biz.loyalty_every > 0 ? biz.loyalty_every - (cust.visits % biz.loyalty_every) : null;

  const review = b.send_review ? await checkinMessage(biz, cust) : 'not requested';

  res.json({
    customer: { id: cust.id, name: cust.name, phone: cust.phone, visits: cust.visits, total_spent: cust.total_spent, new: cust.visits === 1 },
    reward, next_reward_in: reward ? null : nextReward, review,
  });
}
