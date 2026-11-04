// The Birthdays screen and the automatic wishes. Birthday messages are Marketing (about ₹1 each),
// so a restaurant only gets this when the platform admin gives it access.
import { db, HttpError, bad, scopeBiz, isUuid } from '../core.js';
import { sendable, deliver, roomToday } from './templates.js';

const COLS = 'birthday_access, birthday_auto, birthday_template_id';

export async function birthdays(req, res, ctx) {
  const src = req.method === 'GET' ? req.query : (req.body || {});
  const bizId = scopeBiz(ctx, src.business_id);
  const { data: biz, error } = await db.from('businesses').select(COLS).eq('id', bizId).single();
  if (error) throw error;
  if (!biz.birthday_access && !ctx.admin) throw new HttpError(403, 'Birthdays are not turned on for your restaurant. Contact hungriAR.');

  const { data: list, error: tErr } = await db.from('templates').select('*').eq('business_id', bizId).eq('purpose', 'birthday').order('created_at');
  if (tErr) throw tErr;
  const ready = list.filter(sendable);

  if (req.method === 'GET') {
    const { data: upcoming, error: uErr } = await db.rpc('birthdays_upcoming', { p_business: bizId, p_days: 30 });
    if (uErr) throw uErr;
    return res.json({
      access: biz.birthday_access, auto: biz.birthday_auto, template_id: biz.birthday_template_id,
      templates: ready.map(({ id, title, text }) => ({ id, title, text })), upcoming,
    });
  }

  if (req.method !== 'PATCH') throw new HttpError(405, 'Method not allowed');
  if (!biz.birthday_access) throw bad('Give this restaurant Birthday access in Settings first');
  const b = req.body || {};
  const row = {};
  if (b.template_id !== undefined) {
    if (b.template_id && !isUuid(b.template_id)) throw bad('Pick a birthday message');
    if (b.template_id && !ready.some(t => t.id === b.template_id)) throw bad('Pick an approved birthday message');
    row.birthday_template_id = b.template_id || null;
  }
  if (b.auto !== undefined) row.birthday_auto = b.auto === true;
  const template = row.birthday_template_id !== undefined ? row.birthday_template_id : biz.birthday_template_id;
  if ((row.birthday_auto ?? biz.birthday_auto) && !ready.some(t => t.id === template)) throw bad('Pick an approved birthday message first');
  const { error: sErr } = await db.from('businesses').update(row).eq('id', bizId);
  if (sErr) throw sErr;
  res.json({ ok: true });
}

// Runs inside the daily job. Each restaurant uses its chosen template and stays within its daily limit.
export async function sendBirthdays() {
  const { data: people, error } = await db.rpc('birthdays_due');
  if (error) throw error;
  let sent = 0, failed = 0;
  if (!people.length) return { sent, failed };

  const { data: bizList, error: bErr } = await db.from('businesses').select('*').in('id', [...new Set(people.map(p => p.business_id))]);
  if (bErr) throw bErr;
  for (const biz of bizList) {
    const { data: t } = await db.from('templates').select('*').eq('id', biz.birthday_template_id).maybeSingle();
    if (!t || t.purpose !== 'birthday' || !sendable(t)) continue;  // e.g. Meta paused it; it stays on the Templates screen
    const room = await roomToday(biz);
    const mine = people.filter(p => p.business_id === biz.id).slice(0, Math.max(0, room));
    for (let i = 0; i < mine.length; i += 20) {
      await Promise.all(mine.slice(i, i + 20).map(async p => {
        const { data: id, error: cErr } = await db.rpc('claim_birthday', { p_business: biz.id, p_customer: p.customer_id, p_template: t.name });
        if (cErr) throw cErr;
        if (!id) return;
        const r = await deliver(biz, t, { id: p.customer_id, phone: p.phone, name: p.name }, id);
        if (r.ok) sent++; else failed++;
      }));
    }
  }
  return { sent, failed };
}
