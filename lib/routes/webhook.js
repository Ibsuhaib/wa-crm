// Meta calls this URL with delivery receipts (sent/delivered/read/failed) and incoming customer messages.
// Configure in Meta: WhatsApp > Configuration > Webhook URL = https://crm.hungriar.app/api/webhook
import crypto from 'node:crypto';
import { db, HttpError, safeEqual, fill, sendText, normalizePhone } from '../core.js';

const ADVANCE_FROM = {  // only move status forward, since receipts can arrive out of order
  delivered: ['sending', 'sent'],
  read: ['sending', 'sent', 'delivered'],
  failed: ['sending', 'sent'],
};
const STOP_WORDS = ['STOP', 'UNSUBSCRIBE', 'STOP ALL', 'CANCEL'];
const START_WORDS = ['START', 'SUBSCRIBE', 'UNSTOP'];

async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

export async function webhook(req, res) {
  if (req.method === 'GET') {
    const q = req.query;
    const want = process.env.WA_VERIFY_TOKEN;
    if (want && q['hub.mode'] === 'subscribe' && safeEqual(q['hub.verify_token'] || '', want)) {
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send(String(q['hub.challenge'] || '').replace(/\D/g, ''));
    }
    throw new HttpError(403, 'Forbidden');
  }
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');

  // Every POST must be signed by Meta with the app secret, otherwise anyone could fake STOP replies.
  const secret = process.env.WA_APP_SECRET;
  if (!secret) throw new HttpError(503, 'Webhook not configured: set WA_APP_SECRET');
  const raw = await rawBody(req);
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  if (!safeEqual(req.headers['x-hub-signature-256'] || '', expected)) throw new HttpError(401, 'Bad signature');

  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { throw new HttpError(400, 'Bad JSON'); }

  try {
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        await handleChange(change.value ?? {});
      }
    }
  } catch (e) {
    console.error('webhook error', e);  // still answer 200, otherwise Meta keeps retrying
  }
  res.status(200).end();
}

async function handleChange(v) {
  for (const s of v.statuses ?? []) {
    if (!ADVANCE_FROM[s.status]) continue;
    await db.from('messages').update({
      status: s.status,
      ...(s.status === 'failed' ? { error: String(s.errors?.[0]?.title || 'Failed').slice(0, 500) } : {}),
    }).eq('wa_message_id', String(s.id)).in('status', ADVANCE_FROM[s.status]);
  }
  if (!v.messages?.length) return;

  const { data: biz } = await db.from('businesses').select('*')
    .eq('wa_phone_number_id', String(v.metadata?.phone_number_id || '')).maybeSingle();
  if (!biz) return;
  const names = Object.fromEntries((v.contacts ?? []).map(c => [c.wa_id, c.profile?.name]));

  for (const m of v.messages) {
    const phone = normalizePhone(m.from);
    if (!phone) continue;
    const text = (m.text?.body || m.button?.text || m.interactive?.button_reply?.title || '').trim().toUpperCase();
    const now = new Date().toISOString();

    if (STOP_WORDS.includes(text)) {
      await db.from('customers').update({ opted_out_at: now }).eq('business_id', biz.id).eq('phone', phone);
      await reply(biz, phone, `You're unsubscribed from ${biz.name}. Reply START to join again.`);
    } else if (START_WORDS.includes(text) || text.startsWith('JOIN')) {
      // Scanning the counter QR sends "JOIN": that's the customer opting in themselves.
      const { data: existing } = await db.from('customers').select('id').eq('business_id', biz.id).eq('phone', phone).maybeSingle();
      if (existing) {
        await db.from('customers').update({ opted_out_at: null, consent_at: now }).eq('id', existing.id);
      } else {
        await db.from('customers').insert({
          business_id: biz.id, phone, name: String(names[m.from] || '').slice(0, 80) || null, source: 'qr', consent_at: now,
        });
      }
      if (biz.welcome_message) await reply(biz, phone, fill([biz.welcome_message], { business: biz.name, name: names[m.from] || 'there' })[0]);
    }
  }
}

async function reply(biz, phone, text) {
  try { await sendText(biz, phone, text); } catch (e) { console.error('reply failed', e.message); }
}
