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
        rows.push({ business_id, phone, name: c.name ? String(c.name).trim() : null,
          tags: c.tags || [], birthday: c.birthday || null });
      }
      // Every row in a bulk upsert must have the same columns, so merge with what is already saved:
      // a re-import never wipes an existing name/birthday and only adds tags.
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const { data: existing, error: exErr } = await db.from('customers').select('phone, name, tags, birthday')
          .eq('business_id', business_id).in('phone', chunk.map(r => r.phone));
        if (exErr) throw exErr;
        const old = Object.fromEntries(existing.map(e => [e.phone, e]));
        for (const r of chunk) {
          const o = old[r.phone];
          if (!o) continue;
          r.name ||= o.name;
          r.birthday ||= o.birthday;
          r.tags = [...new Set([...o.tags, ...r.tags])];
        }
        const { error } = await db.from('customers').upsert(chunk, { onConflict: 'business_id,phone' });
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
