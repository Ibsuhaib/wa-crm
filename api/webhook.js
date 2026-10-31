// Meta calls this URL with delivery receipts (sent/delivered/read/failed) and incoming customer replies.
// Configure in Meta: WhatsApp > Configuration > Webhook URL = https://your-app.vercel.app/api/webhook
import crypto from 'node:crypto';
import { db } from './_lib.js';

const ADVANCE_FROM = {  // only move status forward, since receipts can arrive out of order
  delivered: ['sending', 'sent'],
  read: ['sending', 'sent', 'delivered'],
  failed: ['sending', 'sent'],
};
const STOP_WORDS = ['STOP', 'UNSUBSCRIBE', 'STOP ALL'];
const START_WORDS = ['START', 'SUBSCRIBE'];

async function rawBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(typeof c === 'string' ? Buffer.from(c) : c);
  return Buffer.concat(chunks);
}

function validSignature(req, raw) {
  const secret = process.env.WA_APP_SECRET;
  if (!secret) return true;
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const got = String(req.headers['x-hub-signature-256'] || '');
  return got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected));
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    const q = req.query;
    if (q['hub.mode'] === 'subscribe' && q['hub.verify_token'] === process.env.WA_VERIFY_TOKEN) {
      return res.status(200).send(q['hub.challenge']);
    }
    return res.status(403).end();
  }
  if (req.method !== 'POST') return res.status(405).end();

  const raw = await rawBody(req);
  if (!validSignature(req, raw)) return res.status(401).end();
  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).end(); }

  try {
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const v = change.value ?? {};

        for (const s of v.statuses ?? []) {
          if (!ADVANCE_FROM[s.status]) continue;
          await db.from('messages').update({
            status: s.status,
            ...(s.status === 'failed' ? { error: s.errors?.[0]?.title || 'Failed' } : {}),
          }).eq('wa_message_id', s.id).in('status', ADVANCE_FROM[s.status]);
        }

        if (v.messages?.length) {
          const { data: biz } = await db.from('businesses').select('id')
            .eq('wa_phone_number_id', v.metadata?.phone_number_id).maybeSingle();
          if (!biz) continue;
          for (const m of v.messages) {
            const text = (m.text?.body || m.button?.text || '').trim().toUpperCase();
            if (STOP_WORDS.includes(text)) {
              await db.from('customers').update({ opted_out_at: new Date().toISOString() })
                .eq('business_id', biz.id).eq('phone', m.from);
            } else if (START_WORDS.includes(text)) {
              await db.from('customers').update({ opted_out_at: null })
                .eq('business_id', biz.id).eq('phone', m.from);
            }
          }
        }
      }
    }
  } catch (e) {
    console.error('webhook error', e);  // still answer 200, otherwise Meta keeps retrying
  }
  res.status(200).end();
}
