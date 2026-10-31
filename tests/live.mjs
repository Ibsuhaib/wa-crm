// End-to-end tests against the deployed app. Creates throwaway restaurants and deletes them at the end.
// Run:  node --env-file=.env.local tests/live.mjs
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const BASE = process.env.PUBLIC_URL;
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const run = Date.now().toString(36);
let passed = 0, failed = 0;
const created = [];

function check(label, ok, detail = '') {
  ok ? passed++ : failed++;
  console.log(`${ok ? '  ✓' : '  ✗'} ${label}${ok ? '' : '   →  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail))}`);
}
const section = t => console.log('\n' + t);

// Retry once on a network drop (not on HTTP errors), so a flaky connection doesn't abort the run.
async function fetchRetry(url, opts) {
  try { return await fetch(url, opts); } catch { await new Promise(r => setTimeout(r, 1500)); return fetch(url, opts); }
}

async function call(path, { method = 'GET', body, token, raw, headers = {} } = {}) {
  const r = await fetchRetry(BASE + '/api/' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}), ...headers },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, headers: r.headers };
}
const signed = payload => {
  const raw = JSON.stringify(payload);
  const sig = 'sha256=' + crypto.createHmac('sha256', process.env.WA_APP_SECRET).update(raw).digest('hex');
  return { raw, headers: { 'x-hub-signature-256': sig } };
};
const waEvent = (phoneNumberId, from, text, name = 'Test Guest') => ({
  object: 'whatsapp_business_account',
  entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: phoneNumberId },
    contacts: [{ wa_id: from, profile: { name } }],
    messages: [{ from, id: 'wamid.' + crypto.randomUUID(), type: 'text', text: { body: text } }],
  } }] }],
});

try {
  // ------------------------------------------------------------------
  section('Security basics');
  const home = await fetch(BASE + '/');
  const csp = home.headers.get('content-security-policy') || '';
  check('dashboard loads', home.ok && (await home.text()).includes('hungri'));
  check('CSP blocks inline scripts', /script-src 'self';/.test(csp) && !/script-src[^;]*unsafe/.test(csp), csp);
  check('clickjacking blocked (X-Frame-Options)', home.headers.get('x-frame-options') === 'DENY');
  check('HSTS on', (home.headers.get('strict-transport-security') || '').includes('max-age'));
  check('API needs login', (await call('customers')).status === 401);
  check('forged token rejected', (await call('me', { token: 'eyJyIjoiYWRtaW4ifQ.fake' })).status === 401);
  const forgedAdmin = Buffer.from(JSON.stringify({ r: 'admin', exp: Date.now() + 1e9 })).toString('base64url') + '.' + 'A'.repeat(43);
  check('token with fake signature rejected', (await call('me', { token: forgedAdmin })).status === 401);
  check('unknown route 404', (await call('nope', {})).status === 404);
  check('invalid JSON gives 400 not 500', (await call('login', { method: 'POST', raw: '{bad json' })).status === 400);
  check('wrong admin key rejected', (await call('login', { method: 'POST', body: { admin_key: 'wrong' } })).status === 401);

  const adm = await call('login', { method: 'POST', body: { admin_key: process.env.ADMIN_KEY } });
  check('admin login', adm.status === 200 && adm.body.role === 'admin', adm.body);
  const A = adm.body.token;

  // ------------------------------------------------------------------
  section('Restaurants & owner logins');
  const mk = async (name, slug, extra = {}) => {
    const r = await call('businesses', { method: 'POST', token: A, body: { name, slug, password: 'pass-' + slug, ...extra } });
    if (r.body.id) created.push(r.body.id);
    return r;
  };
  const ra = await mk('TEST Spice Garden', `t-spice-${run}`);
  const rb = await mk('TEST Cafe Bloom', `t-bloom-${run}`);
  const rc = await mk('TEST Lockout', `t-lock-${run}`);
  check('admin creates restaurants', ra.status === 200 && rb.status === 200 && rc.status === 200, [ra.body, rb.body]);
  const bizA = ra.body.id, bizB = rb.body.id, bizC = rc.body.id;
  check('duplicate login ID refused', (await mk('Dup', `t-spice-${run}`)).status === 400);
  check('bad login ID refused', (await mk('Bad', 'NO SPACES!')).status === 400);
  check('short password refused', (await call('businesses', { method: 'POST', token: A, body: { name: 'x', slug: `t-x-${run}`, password: '123' } })).status === 400);

  const la = await call('login', { method: 'POST', body: { slug: `T-Spice-${run} `, password: `pass-t-spice-${run}` } });
  check('owner login (ID is case/space tolerant)', la.status === 200 && la.body.role === 'owner', la.body);
  const OA = la.body.token;
  const OB = (await call('login', { method: 'POST', body: { slug: `t-bloom-${run}`, password: `pass-t-bloom-${run}` } })).body.token;
  check('wrong owner password rejected', (await call('login', { method: 'POST', body: { slug: `t-spice-${run}`, password: 'nope' } })).status === 401);
  check('unknown login ID rejected', (await call('login', { method: 'POST', body: { slug: `t-ghost-${run}`, password: 'nope-nope' } })).status === 401);
  for (let i = 0; i < 5; i++) await call('login', { method: 'POST', body: { slug: `t-lock-${run}`, password: 'wrong' + i } });
  const locked = await call('login', { method: 'POST', body: { slug: `t-lock-${run}`, password: `pass-t-lock-${run}` } });
  check('5 wrong passwords lock the account (even the right one fails)', locked.status === 429, locked);

  section('Tenant isolation (owner A must never touch B)');
  const listA = await call('businesses', { token: OA });
  check('owner sees only their restaurant', listA.body.length === 1 && listA.body[0].id === bizA, listA.body.map?.(b => b.name));
  check('secrets never sent to browser', !JSON.stringify(listA.body).match(/wa_token"|owner_password_hash/));
  check('owner cannot read B customers', (await call(`customers?business_id=${bizB}`, { token: OA })).status === 403);
  check('owner cannot read B stats', (await call(`stats?business_id=${bizB}`, { token: OA })).status === 403);
  check('owner cannot edit B', (await call(`businesses?id=${bizB}`, { method: 'PATCH', token: OA, body: { name: 'hacked' } })).status === 403);
  check('owner cannot create restaurants', (await call('businesses', { method: 'POST', token: OA, body: { name: 'x', slug: `t-y-${run}` } })).status === 403);
  check('owner cannot delete restaurants', (await call(`businesses?id=${bizA}&confirm=DELETE`, { method: 'DELETE', token: OA })).status === 403);
  await call(`businesses?id=${bizA}`, { method: 'PATCH', token: OA, body: { daily_limit: 99999, active: false, slug: 'stolen' } });
  const { data: aRow } = await db.from('businesses').select('daily_limit, active, slug').eq('id', bizA).single();
  check('owner cannot change plan limit, status or login ID', aRow.daily_limit === 250 && aRow.active && aRow.slug === `t-spice-${run}`, aRow);
  const bImp = await call('customers', { method: 'POST', token: OB, body: { consent: true, customers: [{ phone: '9000000001', name: 'B Guest' }] } });
  check('owner B imports without passing business_id', bImp.body.saved === 1, bImp.body);
  const { data: bCust } = await db.from('customers').select('id').eq('business_id', bizB).single();
  check('owner A cannot open B customer', (await call('customers/detail?id=' + bCust.id, { token: OA })).status === 404);
  check('owner A cannot delete B customer', (await call('customers?id=' + bCust.id, { method: 'DELETE', token: OA })).status === 404);
  check('owner A cannot edit B customer', (await call('customers?id=' + bCust.id, { method: 'PATCH', token: OA, body: { name: 'x' } })).status === 404);

  // ------------------------------------------------------------------
  section('Customers');
  const noConsent = await call('customers', { method: 'POST', token: OA, body: { customers: [{ phone: '9876543210' }] } });
  check('import needs consent confirmation', noConsent.status === 400);
  const imp = await call('customers', { method: 'POST', token: OA, body: { consent: true, customers: [
    { phone: '98765 43210', name: 'Rahul', tags: ['vip'], birthday: '1994-08-21' },
    { phone: '+91 91234-56780', name: 'Priya' },
    { phone: '09988776655', name: 'Amit', tags: 'regular;lunch' },
    { phone: '12345' }, { phone: '5555555555' }, { phone: '9876543210', name: 'dup in same file' },
  ] } });
  check('import: 3 saved, 2 invalid, duplicate skipped', imp.body.saved === 3 && imp.body.invalid.length === 2, imp.body);
  const re = await call('customers', { method: 'POST', token: OA, body: { consent: true, customers: [{ phone: '9876543210', tags: ['regular'] }] } });
  const { data: rahul } = await db.from('customers').select('*').eq('business_id', bizA).eq('phone', '919876543210').single();
  check('re-import keeps name/birthday and merges tags', rahul.name === 'Rahul' && rahul.birthday === '1994-08-21' && rahul.tags.join() === 'vip,regular' && re.body.updated === 1, rahul);
  const search = await call('customers?q=priya', { token: OA });
  check('search by name', search.body.rows?.length === 1 && search.body.rows[0].name === 'Priya', search.body);
  check('search by phone digits', (await call('customers?q=56780', { token: OA })).body.rows?.length === 1);
  check('search with filter-injection characters is safe', (await call('customers?q=' + encodeURIComponent('%,name.eq.x),or(id.gt.0'), { token: OA })).status === 200);
  check('filter by tag', (await call('customers?tag=VIP', { token: OA })).body.rows?.length === 1);
  const exp = await call('customers?all=1', { token: OA });
  check('export returns all', exp.body.rows?.length === 3);
  const edit = await call('customers?id=' + rahul.id, { method: 'PATCH', token: OA, body: { name: 'Rahul S', tags: 'vip, big spender', birthday: '1994-08-22' } });
  const { data: rahul2 } = await db.from('customers').select('name, tags, birthday').eq('id', rahul.id).single();
  check('edit customer', edit.status === 200 && rahul2.name === 'Rahul S' && rahul2.tags.includes('big spender'), rahul2);
  check('bad birthday rejected', (await call('customers?id=' + rahul.id, { method: 'PATCH', token: OA, body: { birthday: '2024-13-45' } })).status === 400);
  check('very long name rejected', (await call('customers?id=' + rahul.id, { method: 'PATCH', token: OA, body: { name: 'x'.repeat(500) } })).status === 400);

  // ------------------------------------------------------------------
  section('Check-in, loyalty, review requests');
  await call(`businesses?id=${bizA}`, { method: 'PATCH', token: OA, body: { loyalty_every: 3, loyalty_reward: 'Free dessert' } });
  const v1 = await call('visits', { method: 'POST', token: OA, body: { phone: '9811111111', name: 'Neha', amount: 850 } });
  check('check-in new guest', v1.body.customer?.new && v1.body.customer.visits === 1 && Number(v1.body.customer.total_spent) === 850, v1.body);
  check('shows visits left to reward', v1.body.next_reward_in === 2, v1.body);
  await call('visits', { method: 'POST', token: OA, body: { phone: '9811111111', amount: 150 } });
  const v3 = await call('visits', { method: 'POST', token: OA, body: { phone: '+91 98111 11111' } });
  check('3rd visit earns loyalty reward', v3.body.reward === 'Free dessert' && v3.body.customer.visits === 3, v3.body);
  check('spend adds up', Number(v3.body.customer.total_spent) === 1000, v3.body.customer);
  check('name kept from first visit', v3.body.customer.name === 'Neha');
  const par = await Promise.all(Array.from({ length: 6 }, () => call('visits', { method: 'POST', token: OA, body: { phone: '9822222222', amount: 100 } })));
  const { data: racer } = await db.from('customers').select('visits, total_spent').eq('business_id', bizA).eq('phone', '919822222222').single();
  check('6 simultaneous check-ins = exactly 6 visits (no race)', par.every(r => r.status === 200) && racer.visits === 6 && Number(racer.total_spent) === 600, racer);
  check('invalid phone rejected', (await call('visits', { method: 'POST', token: OA, body: { phone: '123' } })).status === 400);
  check('negative bill rejected', (await call('visits', { method: 'POST', token: OA, body: { phone: '9811111111', amount: -5 } })).status === 400);
  const noTpl = await call('visits', { method: 'POST', token: OA, body: { phone: '9811111111', send_review: true } });
  check('review skipped when no template set', noTpl.body.review?.includes('template'), noTpl.body.review);
  await call(`businesses?id=${bizA}`, { method: 'PATCH', token: OA, body: { review_template: 'visit_review', google_review_url: 'https://g.page/r/test/review' } });
  const rv1 = await call('visits', { method: 'POST', token: OA, body: { phone: '9811111111', send_review: true } });
  check('review send fails cleanly without WhatsApp', rv1.body.review?.startsWith('failed') && rv1.body.review.includes('not connected'), rv1.body.review);
  const rv2 = await call('visits', { method: 'POST', token: OA, body: { phone: '9811111111', send_review: true } });
  check('not asked twice the same day', rv2.body.review === 'skipped: already asked today', rv2.body.review);
  const noCons = await call('visits', { method: 'POST', token: OA, body: { phone: '9833333333', consent: false, send_review: true } });
  check('no review request without consent', noCons.body.review === 'skipped: no WhatsApp consent', noCons.body.review);

  // ------------------------------------------------------------------
  section('Public review page');
  const { data: rvRow } = await db.from('reviews').select('token').eq('business_id', bizA).limit(1).single();
  const tk = rvRow.token;
  check('review page served', (await fetch(BASE + '/r/' + tk)).ok);
  check('bad token 404', (await call('review?t=nope')).status === 404);
  check('injection-looking token 404', (await call('review?t=' + encodeURIComponent("' or 1=1--"))).status === 404);
  const rg = await call('review?t=' + tk);
  check('page shows restaurant name, not rated yet', rg.body.business === 'TEST Spice Garden' && rg.body.rated === false, rg.body);
  check('rating out of range rejected', (await call('review', { method: 'POST', body: { t: tk, rating: 9 } })).status === 400);
  const rp = await call('review', { method: 'POST', body: { t: tk, rating: 2 } });
  check('rating saved, Google link given to everyone', rp.status === 200 && rp.body.google === 'https://g.page/r/test/review', rp.body);
  const xss = '<img src=x onerror=alert(1)> cold food';
  check('feedback added after rating', (await call('review', { method: 'POST', body: { t: tk, feedback: xss } })).status === 200);
  check('rating cannot be changed', (await call('review', { method: 'POST', body: { t: tk, rating: 5 } })).status === 409);
  check('feedback cannot be overwritten', (await call('review', { method: 'POST', body: { t: tk, feedback: 'changed' } })).status === 409);
  const inbox = await call('reviews?filter=low', { token: OA });
  check('complaint shows in owner inbox (stored as plain text)', inbox.body[0]?.rating === 2 && inbox.body[0]?.feedback === xss, inbox.body[0]);
  check('owner B does not see A complaints', (await call('reviews', { token: OB })).body.length === 0);

  // ------------------------------------------------------------------
  section('Campaigns');
  const segs = async (segment, segment_value, tag) => (await call('campaigns/preview', { method: 'POST', token: OA, body: { segment, segment_value, tag } })).body.count;
  const everyone = await segs('all');
  check('audience: everyone excludes no-consent guest', everyone === 5, everyone);
  check('audience: regulars (3+ visits)', (await segs('regulars', 3)) === 2);
  check('audience: by tag', (await segs('tag', null, 'vip')) === 1);
  check('audience: new in last 7 days', (await segs('new', 7)) === 5);
  check('audience: inactive 30 days (none yet)', (await segs('inactive', 30)) === 0);
  check('tag segment without a tag refused', (await call('campaigns/preview', { method: 'POST', token: OA, body: { segment: 'tag' } })).status === 400);
  check('bad template name refused', (await call('campaigns', { method: 'POST', token: OA, body: { name: 'x', template_name: 'Bad Name!', offer_percent: 5 } })).status === 400);
  check('offer without % refused', (await call('campaigns', { method: 'POST', token: OA, body: { name: 'x', template_name: 'offer', kind: 'offer' } })).status === 400);
  const camp = await call('campaigns', { method: 'POST', token: OA, body: {
    name: 'Weekend 10%', kind: 'offer', template_name: 'next_visit_offer', params: ['{name}', '{percent}', '{code}', '{expiry}'], offer_percent: 10, offer_valid_days: 14 } });
  check('offer campaign created for everyone reachable', camp.body.queued === 5, camp.body);
  const { count: coupons } = await db.from('coupons').select('id', { count: 'exact', head: true }).eq('campaign_id', camp.body.id);
  check('one unique coupon per guest', coupons === 5);
  check('owner B cannot send A campaign', (await call('send-batch', { method: 'POST', token: OB, body: { campaign_id: camp.body.id } })).status === 404);
  const sb = await call('send-batch', { method: 'POST', token: OA, body: { campaign_id: camp.body.id } });
  check('sending without WhatsApp fails cleanly with reason', sb.body.failed === 5 && sb.body.remaining === 0 && /not connected/.test(sb.body.last_error), sb.body);
  const cl = await call('campaigns', { token: OA });
  check('campaign stats', cl.body[0]?.failed === 5 && cl.body[0]?.status === 'done', cl.body[0]);
  check('owner B sees no A campaigns', (await call('campaigns', { token: OB })).body.length === 0);

  // ------------------------------------------------------------------
  section('Coupons at the counter');
  const { data: k } = await db.from('coupons').select('code, customer_id').eq('campaign_id', camp.body.id).limit(1).single();
  const look = await call('coupons?code=' + k.code.toLowerCase(), { token: OA });
  check('look up code (any case)', look.body.percent === 10, look.body);
  check('owner B cannot use A coupon', (await call('coupons', { method: 'POST', token: OB, body: { code: k.code } })).status === 404);
  const red = await call('coupons', { method: 'POST', token: OA, body: { code: ' ' + k.code.toLowerCase() + ' ' } });
  check('redeem', red.status === 200 && red.body.redeemed_at, red.body);
  const twice = await call('coupons', { method: 'POST', token: OA, body: { code: k.code } });
  check('second redeem blocked', twice.status === 409 && /Already used/.test(twice.body.error), twice.body);
  const { data: kk } = await db.from('coupons').select('code').eq('campaign_id', camp.body.id).is('redeemed_at', null).limit(2);
  const both = await Promise.all([1, 2, 3].map(() => call('coupons', { method: 'POST', token: OA, body: { code: kk[0].code } })));
  check('3 simultaneous redeems: exactly one wins', both.filter(r => r.status === 200).length === 1, both.map(r => r.status));
  await db.from('coupons').update({ expires_at: new Date(Date.now() - 864e5).toISOString() }).eq('code', kk[1].code).eq('business_id', bizA);
  const ex = await call('coupons', { method: 'POST', token: OA, body: { code: kk[1].code } });
  check('expired coupon blocked', ex.status === 409 && /Expired/.test(ex.body.error), ex.body);
  const { data: cust1 } = await db.from('customers').select('phone').eq('id', k.customer_id).single();
  const byPhone = await call('coupons?phone=' + cust1.phone.slice(2), { token: OA });
  check('find coupons by phone (used ones hidden)', Array.isArray(byPhone.body.coupons) && !byPhone.body.coupons.some(c => c.code === k.code), byPhone.body);
  check('unknown code 404', (await call('coupons?code=ZZZZZZZ', { token: OA })).status === 404);

  // ------------------------------------------------------------------
  section('Stats & QR');
  const st = await call('stats', { token: OA });
  check('stats', st.body.customers === 6 && st.body.visits_30d === 13 && st.body.visits_by_day?.length === 14 && st.body.ratings === 1, st.body);
  check('QR needs WhatsApp number', (await call('qr', { token: OA })).status === 400);
  check('invalid WhatsApp number refused', (await call(`businesses?id=${bizA}`, { method: 'PATCH', token: OA, body: { wa_number: '12' } })).status === 400);
  await call(`businesses?id=${bizA}`, { method: 'PATCH', token: OA, body: { wa_number: '98000 11111', wa_phone_number_id: '1111' + run.replace(/\D/g, '') } });
  const qr = await call('qr', { token: OA });
  check('QR code generated', qr.body.svg?.startsWith('<svg') && qr.body.link === 'https://wa.me/919800011111?text=JOIN', qr.body.link);
  check('non-https review link refused', (await call(`businesses?id=${bizA}`, { method: 'PATCH', token: OA, body: { google_review_url: 'javascript:alert(1)' } })).status === 400);

  // ------------------------------------------------------------------
  section('WhatsApp webhook');
  const pnid = '1111' + run.replace(/\D/g, '');
  const vfy = await fetch(`${BASE}/api/webhook?hub.mode=subscribe&hub.verify_token=${process.env.WA_VERIFY_TOKEN}&hub.challenge=987654`);
  check('Meta verification handshake', (await vfy.text()) === '987654');
  check('wrong verify token refused', (await fetch(`${BASE}/api/webhook?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1`)).status === 403);
  check('unsigned POST refused', (await call('webhook', { method: 'POST', body: waEvent(pnid, '919844444444', 'STOP') })).status === 401);
  const bad = signed(waEvent(pnid, '919844444444', 'JOIN'));
  check('tampered POST refused', (await call('webhook', { method: 'POST', raw: bad.raw.replace('JOIN', 'STOP'), headers: bad.headers })).status === 401);
  const join = signed(waEvent(pnid, '919844444444', 'join', 'Kiran'));
  check('signed JOIN accepted', (await call('webhook', { method: 'POST', ...join })).status === 200);
  const { data: kiran } = await db.from('customers').select('*').eq('business_id', bizA).eq('phone', '919844444444').maybeSingle();
  check('QR JOIN creates customer with consent + WhatsApp name', kiran?.source === 'qr' && kiran.consent_at && kiran.name === 'Kiran', kiran);
  await call('webhook', { method: 'POST', ...signed(waEvent(pnid, '919844444444', 'Stop')) });
  const { data: k2 } = await db.from('customers').select('opted_out_at').eq('id', kiran.id).single();
  check('STOP unsubscribes', !!k2.opted_out_at);
  check('unsubscribed guest excluded from campaigns', (await segs('all')) === 5);
  check('staff cannot re-subscribe them', (await call('customers?id=' + kiran.id, { method: 'PATCH', token: OA, body: { opted_out: false } })).status === 400);
  await call('webhook', { method: 'POST', ...signed(waEvent(pnid, '919844444444', 'START')) });
  const { data: k3 } = await db.from('customers').select('opted_out_at').eq('id', kiran.id).single();
  check('START re-subscribes', k3.opted_out_at === null);
  await call('webhook', { method: 'POST', ...signed(waEvent(pnid, '919855555555', 'hello what time do you open')) });
  const { data: rando } = await db.from('customers').select('id').eq('business_id', bizA).eq('phone', '919855555555').maybeSingle();
  check('random chat message does not add a customer', !rando);
  await call('webhook', { method: 'POST', ...signed(waEvent('000', '919866666666', 'JOIN')) });
  const { count: orphan } = await db.from('customers').select('id', { count: 'exact', head: true }).eq('phone', '919866666666');
  check('JOIN to unknown number ignored', orphan === 0);
  const { data: msg } = await db.from('messages').insert({ business_id: bizA, customer_id: kiran.id, status: 'sent', wa_message_id: 'wamid.test' + run, sent_at: new Date().toISOString() }).select('id').single();
  const status = s => signed({ entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.test' + run, status: s }] } }] }] });
  await call('webhook', { method: 'POST', ...status('read') });
  await call('webhook', { method: 'POST', ...status('delivered') });  // arrives late, must not downgrade
  const { data: m2 } = await db.from('messages').select('status').eq('id', msg.id).single();
  check('delivery receipts never go backwards', m2.status === 'read', m2);

  // ------------------------------------------------------------------
  section('Passwords & sessions');
  check('owner password change needs current password', (await call('businesses/password', { method: 'POST', token: OA, body: { password: 'new-pass-123', current_password: 'wrong' } })).status === 401);
  const pc = await call('businesses/password', { method: 'POST', token: OA, body: { password: 'new-pass-123', current_password: `pass-t-spice-${run}` } });
  check('owner changes password and stays logged in', pc.status === 200 && pc.body.token && (await call('me', { token: pc.body.token })).status === 200);
  check('old sessions logged out after password change', (await call('me', { token: OA })).status === 401);
  check('new password works', (await call('login', { method: 'POST', body: { slug: `t-spice-${run}`, password: 'new-pass-123' } })).status === 200);
  await call(`businesses?id=${bizB}`, { method: 'PATCH', token: A, body: { active: false } });
  check('paused restaurant is logged out', (await call('me', { token: OB })).status === 401);
  check('paused restaurant cannot log in', (await call('login', { method: 'POST', body: { slug: `t-bloom-${run}`, password: `pass-t-bloom-${run}` } })).status === 403);
  const resetC = await call('businesses/password', { method: 'POST', token: A, body: { business_id: bizC, password: 'unlock-123' } });
  check('admin reset unlocks a locked account', resetC.status === 200 && (await call('login', { method: 'POST', body: { slug: `t-lock-${run}`, password: 'unlock-123' } })).status === 200);

  // ------------------------------------------------------------------
  section('Birthday job');
  check('cron refuses callers without the secret', (await call('cron/birthdays')).status === 401);
  const today = new Date(Date.now() + 5.5 * 36e5);
  const bday = `1990-${String(today.getUTCMonth() + 1).padStart(2, '0')}-${String(today.getUTCDate()).padStart(2, '0')}`;
  await call(`businesses?id=${bizA}`, { method: 'PATCH', token: A, body: { birthday_template: 'birthday_offer' } });
  await call('customers?id=' + rahul.id, { method: 'PATCH', token: A, body: { birthday: bday } });
  const cr = await call('cron/birthdays', { headers: { authorization: 'Bearer ' + process.env.CRON_SECRET } });
  check('cron runs and finds today\'s birthday', cr.status === 200 && cr.body.failed >= 1, cr.body);
  const { count: bc } = await db.from('coupons').select('id', { count: 'exact', head: true }).eq('customer_id', rahul.id).eq('reason', 'birthday');
  check('unsent birthday coupon removed so it retries tomorrow', bc === 0);

  // ------------------------------------------------------------------
  section('Admin');
  check('delete needs confirmation', (await call(`businesses?id=${bizC}`, { method: 'DELETE', token: A })).status === 400);
  check('admin deletes restaurant', (await call(`businesses?id=${bizC}&confirm=DELETE`, { method: 'DELETE', token: A })).status === 200);
} catch (e) {
  failed++;
  console.log('  ✗ crashed:', e.stack);
} finally {
  for (const id of created) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try { const { error } = await db.from('businesses').delete().eq('id', id); if (!error) break; } catch {}
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  console.log(`\n${passed} passed, ${failed} failed. Test restaurants cleaned up.`);
  process.exitCode = failed ? 1 : 0;
}
