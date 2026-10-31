import { db, isAdmin, fail } from './_lib.js';

const FIELDS = ['name', 'wa_phone_number_id', 'wa_token', 'google_review_url',
  'review_template', 'review_lang', 'review_params', 'daily_limit'];

function pick(body) {
  const out = {};
  for (const f of FIELDS) if (body[f] !== undefined && body[f] !== '') out[f] = body[f];
  return out;
}

export default async function handler(req, res) {
  if (!isAdmin(req, res)) return;
  try {
    if (req.method === 'GET') {
      const { data, error } = await db.from('businesses').select('*').order('created_at');
      if (error) throw error;
      // The token stays on the server; the dashboard only needs to know whether it is set.
      return res.json(data.map(({ wa_token, ...b }) => ({ ...b, has_token: !!wa_token })));
    }
    if (req.method === 'POST') {
      if (!req.body?.name) throw new Error('Business name is required');
      const { data, error } = await db.from('businesses').insert(pick(req.body)).select('id').single();
      if (error) throw error;
      return res.json(data);
    }
    if (req.method === 'PATCH') {
      const { error } = await db.from('businesses').update(pick(req.body)).eq('id', req.query.id);
      if (error) throw error;
      return res.json({ ok: true });
    }
    res.status(405).end();
  } catch (e) { fail(res, e); }
}
