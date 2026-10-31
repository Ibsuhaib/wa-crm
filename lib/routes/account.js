// Login, current user, business settings and passwords.
import {
  db, HttpError, bad, safeEqual, makeToken, scopeBiz, isUuid, hashPassword, verifyPassword,
  str, int, params, templateName, langCode, httpsUrl, normalizePhone,
} from '../core.js';

const MAX_FAILS = 5, LOCK_MINUTES = 15;
const wait = ms => new Promise(r => setTimeout(r, ms));
const SLUG = /^[a-z0-9][a-z0-9-]{2,39}$/;

export async function login(req, res) {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const { admin_key, slug, password } = req.body || {};
  if (admin_key !== undefined) {
    if (process.env.ADMIN_KEY && safeEqual(admin_key, process.env.ADMIN_KEY)) {
      return res.json({ token: makeToken({ r: 'admin' }, 12), role: 'admin' });
    }
    await wait(800);
    throw new HttpError(401, 'Wrong admin key');
  }

  const id = String(slug || '').trim().toLowerCase();
  const { data: b } = SLUG.test(id)
    ? await db.from('businesses').select('id, active, owner_password_hash, failed_logins, locked_until, session_version').eq('slug', id).maybeSingle()
    : { data: null };
  if (b?.locked_until && new Date(b.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(b.locked_until) - Date.now()) / 60000);
    throw new HttpError(429, `Too many wrong attempts. Try again in ${mins} minute${mins > 1 ? 's' : ''}.`);
  }
  const ok = verifyPassword(password, b?.owner_password_hash);  // runs scrypt even for unknown IDs (same timing)
  if (!b || !ok) {
    if (b) {
      const fails = b.failed_logins + 1;
      await db.from('businesses').update(fails >= MAX_FAILS
        ? { failed_logins: 0, locked_until: new Date(Date.now() + LOCK_MINUTES * 6e4).toISOString() }
        : { failed_logins: fails }).eq('id', b.id);
    }
    throw new HttpError(401, 'Wrong login ID or password');
  }
  if (!b.active) throw new HttpError(403, 'This account is paused. Contact support.');
  if (b.failed_logins) await db.from('businesses').update({ failed_logins: 0 }).eq('id', b.id);
  res.json({ token: makeToken({ r: 'owner', b: b.id, v: b.session_version }, 24 * 30), role: 'owner' });
}

export async function me(req, res, ctx) {
  res.json({ role: ctx.admin ? 'admin' : 'owner', business_id: ctx.businessId || null });
}

const PUBLIC_COLS = 'id, name, slug, active, wa_phone_number_id, wa_number, google_review_url, review_template, review_lang, review_params, ' +
  'daily_limit, welcome_message, loyalty_every, loyalty_reward, birthday_template, birthday_lang, birthday_params, birthday_percent, created_at';

// Turn a request body into validated column values. Only fields that were sent are touched.
function settingsFrom(body, admin) {
  const out = {};
  const has = k => body[k] !== undefined;
  if (has('name')) { out.name = str(body.name, 80, 'Business name'); if (!out.name) throw bad('Business name is required'); }
  if (has('google_review_url')) out.google_review_url = httpsUrl(body.google_review_url, 'Google review link');
  if (has('wa_phone_number_id')) {
    out.wa_phone_number_id = str(body.wa_phone_number_id, 30, 'Phone number ID');
    if (out.wa_phone_number_id && !/^\d+$/.test(out.wa_phone_number_id)) throw bad('Phone number ID is only digits (copy it from Meta API Setup)');
  }
  if (has('wa_token') && String(body.wa_token).trim()) out.wa_token = str(body.wa_token, 1000, 'Access token');
  if (has('wa_number')) {
    out.wa_number = body.wa_number ? normalizePhone(body.wa_number) : null;
    if (body.wa_number && !out.wa_number) throw bad('WhatsApp number is not valid');
  }
  if (has('review_template')) out.review_template = templateName(body.review_template);
  if (has('review_lang')) out.review_lang = langCode(body.review_lang);
  if (has('review_params')) out.review_params = params(body.review_params, 'Review variables');
  if (has('welcome_message')) out.welcome_message = str(body.welcome_message, 500, 'Welcome message');
  if (has('loyalty_every')) out.loyalty_every = int(body.loyalty_every, 0, 100, 'Reward every N visits') || null;
  if (has('loyalty_reward')) out.loyalty_reward = str(body.loyalty_reward, 100, 'Reward');
  if (has('birthday_template')) out.birthday_template = templateName(body.birthday_template);
  if (has('birthday_lang')) out.birthday_lang = langCode(body.birthday_lang);
  if (has('birthday_params')) out.birthday_params = params(body.birthday_params, 'Birthday variables');
  if (has('birthday_percent')) out.birthday_percent = int(body.birthday_percent, 1, 100, 'Birthday discount') ?? 10;
  if (admin) {  // plan-level settings only the platform admin can change
    if (has('daily_limit')) out.daily_limit = int(body.daily_limit, 1, 100000, 'Daily limit') ?? 250;
    if (has('active')) out.active = !!body.active;
    if (has('slug')) {
      out.slug = String(body.slug || '').trim().toLowerCase();
      if (!SLUG.test(out.slug)) throw bad('Login ID: 3-40 lowercase letters, numbers or -');
    }
  }
  return out;
}

export async function businesses(req, res, ctx) {
  if (req.method === 'GET') {
    let q = db.from('businesses').select(PUBLIC_COLS + ', wa_token, owner_password_hash').order('created_at');
    if (!ctx.admin) q = q.eq('id', ctx.businessId);
    const { data, error } = await q;
    if (error) throw error;
    // Secrets never leave the server; the dashboard only needs to know whether they're set.
    return res.json(data.map(({ wa_token, owner_password_hash, ...b }) => ({ ...b, has_token: !!wa_token, has_password: !!owner_password_hash })));
  }

  if (req.method === 'POST') {
    if (!ctx.admin) throw new HttpError(403, 'Only the platform admin can add businesses');
    const row = settingsFrom(req.body || {}, true);
    if (!row.name) throw bad('Business name is required');
    if (!row.slug) throw bad('Login ID is required');
    const pw = req.body.password;
    if (pw) {
      if (String(pw).length < 8) throw bad('Password must be at least 8 characters');
      row.owner_password_hash = hashPassword(String(pw));
    }
    const { data, error } = await db.from('businesses').insert(row).select('id').single();
    if (error?.code === '23505') throw bad('That login ID is taken, pick another');
    if (error) throw error;
    return res.json(data);
  }

  if (req.method === 'PATCH') {
    const id = scopeBiz(ctx, req.query.id);
    const row = settingsFrom(req.body || {}, ctx.admin);
    if (!Object.keys(row).length) return res.json({ ok: true });
    const { error } = await db.from('businesses').update(row).eq('id', id);
    if (error?.code === '23505') throw bad('That login ID is taken, pick another');
    if (error) throw error;
    return res.json({ ok: true });
  }

  if (req.method === 'DELETE') {
    if (!ctx.admin) throw new HttpError(403, 'Only the platform admin can delete businesses');
    if (!isUuid(req.query.id)) throw bad('Missing business');
    if (req.query.confirm !== 'DELETE') throw bad('Type DELETE to confirm');
    const { error } = await db.from('businesses').delete().eq('id', req.query.id);
    if (error) throw error;
    return res.json({ ok: true });
  }
  throw new HttpError(405, 'Method not allowed');
}

// Set or change the owner's password. Logs out every other device (session_version bump).
export async function password(req, res, ctx) {
  if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
  const { business_id, password: pw, current_password } = req.body || {};
  const id = scopeBiz(ctx, business_id);
  if (String(pw || '').length < 8) throw bad('New password must be at least 8 characters');
  if (String(pw).length > 200) throw bad('Password is too long');
  const { data: b, error } = await db.from('businesses').select('owner_password_hash, session_version').eq('id', id).single();
  if (error) throw error;
  if (!ctx.admin && !verifyPassword(current_password, b.owner_password_hash)) throw new HttpError(401, 'Current password is wrong');
  const v = b.session_version + 1;
  const { error: uErr } = await db.from('businesses')
    .update({ owner_password_hash: hashPassword(String(pw)), session_version: v, failed_logins: 0, locked_until: null }).eq('id', id);
  if (uErr) throw uErr;
  // An owner changing their own password stays logged in on this device.
  res.json({ ok: true, token: ctx.admin ? undefined : makeToken({ r: 'owner', b: id, v }, 24 * 30) });
}
