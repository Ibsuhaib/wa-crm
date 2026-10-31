import { db, isAdmin, fail, normalizePhone } from './_lib.js';

export default async function handler(req, res) {
  if (!isAdmin(req, res)) return;
  try {
    if (req.method === 'GET') {
      const { business_id, q, tag } = req.query;
      let query = db.from('customers').select('*').eq('business_id', business_id)
        .order('last_visit_at', { ascending: false, nullsFirst: false }).limit(500);
      if (tag) query = query.contains('tags', [tag]);
      if (q) query = query.or(`phone.ilike.%${q.replace(/[^\w ]/g, '')}%,name.ilike.%${q.replace(/[^\w ]/g, '')}%`);
      const { data, error } = await query;
      if (error) throw error;
      return res.json(data);
    }

    // Add one customer or a whole CSV import: { business_id, customers: [{ phone, name, tags, birthday }] }
    if (req.method === 'POST') {
      const { business_id, customers = [] } = req.body;
      const rows = [], invalid = [];
      const seen = new Set();
      for (const c of customers) {
        const phone = normalizePhone(c.phone);
        if (!phone) { invalid.push(c.phone); continue; }
        if (seen.has(phone)) continue;
        seen.add(phone);
        const row = { business_id, phone };
        if (c.name) row.name = String(c.name).trim();
        if (c.tags?.length) row.tags = c.tags;
        if (c.birthday) row.birthday = c.birthday;
        rows.push(row);
      }
      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await db.from('customers').upsert(rows.slice(i, i + 500), { onConflict: 'business_id,phone' });
        if (error) throw error;
      }
      return res.json({ saved: rows.length, invalid });
    }

    if (req.method === 'DELETE') {
      const { error } = await db.from('customers').delete().eq('id', req.query.id);
      if (error) throw error;
      return res.json({ ok: true });
    }
    res.status(405).end();
  } catch (e) { fail(res, e); }
}
