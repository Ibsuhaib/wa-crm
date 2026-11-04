// WhatsApp message templates. Only the platform admin creates or edits them; restaurants just pick one to send.
// Visit messages are submitted as Utility, the cheap category. Meta has the final say, and any visit message
// it labels Marketing is blocked from sending. Birthday messages are honestly Marketing (about ₹1).
import crypto from 'node:crypto';
import { db, HttpError, bad, scopeBiz, loadOwned, str, fill, token, metaApi, sendTemplate } from '../core.js';

const SAMPLES = { name: 'Rahul', business: 'Cafe Mocha', link: 'https://crm.hungriar.app/r/sample' };
const varCount = body => new Set(String(body).match(/\{\{\d+\}\}/g) || []).size;

export const sendable = t => t.status === 'APPROVED' && varCount(t.body) === t.params.length && (t.purpose === 'birthday' || t.category === 'UTILITY');
export const renderBody = (body, values) => String(body).replace(/\{\{(\d+)\}\}/g, (m, i) => values[i - 1] ?? m);

// "Hi {name}, thanks" -> Meta's "Hi {{1}}, thanks" plus the variable list. Meta refuses a body that
// starts or ends with a variable, or has two side by side, so say so here in plain words.
function compile(input) {
  const text = str(input, 1000, 'Message');
  if (!text) throw bad('Write the message first');
  const params = [];
  const body = text.replace(/\{(\w+)\}/g, (_, k) => {
    if (!(k in SAMPLES)) throw bad(`{${k}} is not available. Use {name}, {business} or {link}`);
    if (!params.includes(`{${k}}`)) params.push(`{${k}}`);
    return `{{${params.indexOf(`{${k}}`) + 1}}}`;
  });
  if (/^\{\{|\}\}$/.test(body)) throw bad('The message cannot start or end with {name}, {business} or {link}. Add a word before or after it');
  if (/\}\}\s*\{\{/.test(body)) throw bad('Put at least one word between two variables');
  return { text, body, params };
}

const components = ({ body, params }) => [{
  type: 'BODY', text: body,
  ...(params.length ? { example: { body_text: [params.map(p => SAMPLES[p.slice(1, -1)])] } } : {}),
}];

function metaName(title) {
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  return (slug || 'message') + '_' + crypto.randomBytes(2).toString('hex');
}

const loadBiz = async id => {
  const { data, error } = await db.from('businesses').select('id, wa_waba_id, wa_token').eq('id', id).single();
  if (error) throw error;
  return data;
};
const needWaba = b => {
  if (!b.wa_waba_id || !b.wa_token) throw bad('Add the WhatsApp account ID and token in Settings first');
  return b;
};

// Pull the real status and category of every template from Meta. Also brings in templates made in WhatsApp Manager.
export async function syncTemplates(biz) {
  const r = await metaApi(biz, `${biz.wa_waba_id}/message_templates?fields=id,name,language,status,category,rejected_reason,components&limit=200`);
  const { data: saved, error } = await db.from('templates').select('*').eq('business_id', biz.id);
  if (error) throw error;
  const key = t => `${t.name}|${t.lang}`;
  const old = Object.fromEntries(saved.map(t => [key(t), t]));
  const now = new Date().toISOString();
  const rows = (r.data || []).map(m => {
    const lang = m.language, o = old[`${m.name}|${lang}`];
    const body = m.components?.find(c => c.type === 'BODY')?.text || '';
    return {
      id: o?.id || crypto.randomUUID(), business_id: biz.id, name: m.name, lang,
      title: o?.title || m.name.replace(/_/g, ' '), text: o?.text || body, params: o?.params || [], body, purpose: o?.purpose || 'visit',
      category: m.category, status: m.status, meta_id: m.id, updated_at: now,
      reason: m.rejected_reason && m.rejected_reason !== 'NONE' ? m.rejected_reason : null,
    };
  });
  if (rows.length) {
    const { error: uErr } = await db.from('templates').upsert(rows, { onConflict: 'business_id,name,lang' });
    if (uErr) throw uErr;
  }
  const live = new Set(rows.map(key));
  const gone = saved.filter(t => !live.has(key(t))).map(t => t.id);
  if (gone.length) await db.from('templates').update({ status: 'DELETED', updated_at: now }).in('id', gone);
}

export async function templates(req, res, ctx) {
  if (req.method === 'GET') {
    const bizId = scopeBiz(ctx, req.query.business_id);
    let sync_error = null;
    if (ctx.admin && req.query.sync === '1') {
      const b = await loadBiz(bizId);
      if (b.wa_waba_id && b.wa_token) await syncTemplates(b).catch(e => { sync_error = e.message; });
    }
    const { data, error } = await db.from('templates').select('*').eq('business_id', bizId).order('created_at');
    if (error) throw error;
    const rows = data.map(t => ({ ...t, sendable: sendable(t) }));
    if (ctx.admin) return res.json({ rows, sync_error });
    // Restaurants only see what they can send, as read-only text.
    const { data: b } = await db.from('businesses').select('birthday_access').eq('id', bizId).single();
    return res.json({ rows: rows.filter(t => t.sendable && (t.purpose !== 'birthday' || b.birthday_access))
      .map(({ id, title, text, purpose }) => ({ id, title, text, purpose })) });
  }

  if (!ctx.admin) throw new HttpError(403, 'Only the platform admin can change messages');

  if (req.method === 'POST') {
    const b = req.body || {};
    const biz = needWaba(await loadBiz(scopeBiz(ctx, b.business_id)));
    const title = str(b.title, 60, 'Title');
    if (!title) throw bad('Give the message a title');
    const c = compile(b.text);
    const name = metaName(title);
    const purpose = b.purpose === 'birthday' ? 'birthday' : 'visit';
    const category = purpose === 'birthday' ? 'MARKETING' : 'UTILITY';
    const r = await metaApi(biz, `${biz.wa_waba_id}/message_templates`, { method: 'POST', body: {
      name, language: 'en', category, components: components(c),
    } });
    const { data, error } = await db.from('templates').insert({
      business_id: biz.id, title, name, purpose, ...c, category: r.category || category, status: r.status || 'PENDING', meta_id: r.id,
    }).select().single();
    if (error) throw error;
    return res.json(data);
  }

  const t = await loadOwned('templates', req.query.id, ctx);

  if (req.method === 'PATCH') {
    const b = req.body || {};
    const row = { updated_at: new Date().toISOString() };
    if (b.title !== undefined) {
      row.title = str(b.title, 60, 'Title');
      if (!row.title) throw bad('Give the message a title');
    }
    if (b.text !== undefined) {
      const c = compile(b.text);
      if (c.text !== t.text || c.params.length !== t.params.length) {
        const biz = needWaba(await loadBiz(t.business_id));
        await metaApi(biz, t.meta_id, { method: 'POST', body: { components: components(c) } });
        Object.assign(row, c, { status: 'PENDING', reason: null });
      }
    }
    const { error } = await db.from('templates').update(row).eq('id', t.id);
    if (error) throw error;
    return res.json({ ok: true });
  }

  if (req.method === 'DELETE') {
    const biz = await loadBiz(t.business_id);
    if (t.meta_id && t.status !== 'DELETED') {
      needWaba(biz);
      await metaApi(biz, `${biz.wa_waba_id}/message_templates?name=${encodeURIComponent(t.name)}&hsm_id=${encodeURIComponent(t.meta_id)}`, { method: 'DELETE' });
    }
    const { error } = await db.from('templates').delete().eq('id', t.id);
    if (error) throw error;
    return res.json({ ok: true });
  }
  throw new HttpError(405, 'Method not allowed');
}

// How many more different customers this restaurant can message in the current 24 hours.
export async function roomToday(biz) {
  const since = new Date(Date.now() - 864e5).toISOString();
  const { data, error } = await db.from('messages').select('customer_id')
    .eq('business_id', biz.id).gte('sent_at', since).range(0, 99999);
  if (error) throw error;
  return biz.daily_limit - new Set(data.map(r => r.customer_id)).size;
}

// Send one claimed message row. A {link} variable gets its own review page for this customer.
export async function deliver(biz, t, customer, messageId) {
  let reviewId = null;
  try {
    const vars = { name: customer.name || 'there', business: biz.name };
    if (t.params.some(p => p.includes('{link}'))) {
      const tk = token();
      const { data, error } = await db.from('reviews').insert({ business_id: biz.id, customer_id: customer.id, token: tk }).select('id').single();
      if (error) throw error;
      reviewId = data.id;
      vars.link = `${process.env.PUBLIC_URL}/r/${tk}`;
    }
    const values = fill(t.params, vars);
    const waId = await sendTemplate(biz, customer.phone, t.name, t.lang, values);
    await db.from('messages').update({
      status: 'sent', wa_message_id: waId, sent_at: new Date().toISOString(), preview: renderBody(t.body, values),
    }).eq('id', messageId);
    return { ok: true };
  } catch (e) {
    if (reviewId) await db.from('reviews').delete().eq('id', reviewId);
    await db.from('messages').update({ status: 'failed', error: e.message.slice(0, 500) }).eq('id', messageId);
    return { ok: false, error: e.message };
  }
}
