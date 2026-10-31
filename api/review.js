// Public endpoint behind the /r/<token> page the customer opens from WhatsApp. No admin key.
import { db, fail } from './_lib.js';

export default async function handler(req, res) {
  try {
    const t = String((req.method === 'GET' ? req.query.t : req.body?.t) || '');
    const { data: r } = await db.from('reviews').select('id, rating, businesses(name, google_review_url)')
      .eq('token', t).maybeSingle();
    if (!r) return fail(res, 'This link is not valid', 404);
    const google = r.businesses.google_review_url || null;

    if (req.method === 'GET') return res.json({ business: r.businesses.name, rated: !!r.rating, google });
    if (req.method !== 'POST') return res.status(405).end();

    const rating = Math.round(Number(req.body.rating));
    if (!(rating >= 1 && rating <= 5)) throw new Error('Pick 1 to 5 stars');
    const feedback = req.body.feedback ? String(req.body.feedback).slice(0, 2000) : undefined;
    const { error } = await db.from('reviews').update({
      rating, rated_at: new Date().toISOString(), ...(feedback ? { feedback } : {}),
    }).eq('id', r.id);
    if (error) throw error;
    res.json({ ok: true, google });
  } catch (e) { fail(res, e); }
}
