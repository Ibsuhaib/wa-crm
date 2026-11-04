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
  const selfEdit = await call(`businesses?id=${bizA}`, { method: 'PATCH', token: OA, body: { name: 'mine', daily_limit: 99999, active: false, slug: 'stolen' } });
  const { data: aRow } = await db.from('businesses').select('name, daily_limit, active, slug').eq('id', bizA).single();
  check('owner cannot change any setting, even on their own restaurant', selfEdit.status === 403 && aRow.name === 'TEST Spice Garden' && aRow.daily_limit === 250 && aRow.active && aRow.slug === `t-spice-${run}`, aRow);
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
  check('filter VIP', (await call('customers?group=vip', { token: OA })).body.rows?.map(c => c.name).join() === 'Rahul');
  check('filter Common', (await call('customers?group=common', { token: OA })).body.rows?.length === 2);
  await db.from('customers').update({ last_visit_at: '2026-01-15T10:00:00Z' }).eq('id', rahul.id);
  const span = q => call('customers?' + new URLSearchParams(q), { token: OA });
  check('filter by last visit from + to', (await span({ from: '2026-01-15T09:00:00Z', to: '2026-01-15T11:00:00Z' })).body.rows?.map(c => c.name).join() === 'Rahul');
  check('date filter excludes outside the time window', (await span({ from: '2026-01-15T10:30:00Z' })).body.rows?.length === 0);
  check('bad date refused', (await span({ from: 'not-a-date' })).status === 400);
  const exp = await call('customers?all=1', { token: OA });
  check('export returns all', exp.body.rows?.length === 3);
  const edit = await call('customers?id=' + rahul.id, { method: 'PATCH', token: OA, body: { name: 'Rahul S', tags: 'vip, big spender', birthday: '1994-08-22' } });
  const { data: rahul2 } = await db.from('customers').select('name, tags, birthday').eq('id', rahul.id).single();
  check('edit customer', edit.status === 200 && rahul2.name === 'Rahul S' && rahul2.tags.includes('big spender'), rahul2);
  check('bad birthday rejected', (await call('customers?id=' + rahul.id, { method: 'PATCH', token: OA, body: { birthday: '2024-13-45' } })).status === 400);
  check('very long name rejected', (await call('customers?id=' + rahul.id, { method: 'PATCH', token: OA, body: { name: 'x'.repeat(500) } })).status === 400);

  // ------------------------------------------------------------------
  section('Check-in, loyalty, thank-you message');
  await call(`businesses?id=${bizA}`, { method: 'PATCH', token: A, body: { loyalty_every: 3, loyalty_reward: 'Free dessert', google_review_url: 'https://g.page/r/test/review' } });
  const v1 = await call('visits', { method: 'POST', token: OA, body: { phone: '9811111111', name: 'Neha', amount: 850, birthday: '1996-03-04' } });
  check('check-in new guest', v1.body.customer?.new && v1.body.customer.visits === 1 && Number(v1.body.customer.total_spent) === 850, v1.body);
  check('shows visits left to reward', v1.body.next_reward_in === 2, v1.body);
  const { data: neha } = await db.from('customers').select('id, birthday').eq('business_id', bizA).eq('phone', '919811111111').single();
  check('birthday saved at check-in', neha.birthday === '1996-03-04', neha);
  await call('visits', { method: 'POST', token: OA, body: { phone: '9811111111', amount: 150 } });
  const v3 = await call('visits', { method: 'POST', token: OA, body: { phone: '+91 98111 11111' } });
  check('3rd visit earns loyalty reward', v3.body.reward === 'Free dessert' && v3.body.customer.visits === 3, v3.body);
  check('spend adds up', Number(v3.body.customer.total_spent) === 1000, v3.body.customer);
  check('name kept from first visit', v3.body.customer.name === 'Neha');
  const { data: neha2 } = await db.from('customers').select('birthday').eq('id', neha.id).single();
  check('check-in without a birthday keeps the saved one', neha2.birthday === '1996-03-04', neha2);
  check('bad birthday at check-in refused', (await call('visits', { method: 'POST', token: OA, body: { phone: '9811111111', birthday: '1996-99-99' } })).status === 400);
  const par = await Promise.all(Array.from({ length: 6 }, () => call('visits', { method: 'POST', token: OA, body: { phone: '9822222222', amount: 100 } })));
  const { data: racer } = await db.from('customers').select('visits, total_spent').eq('business_id', bizA).eq('phone', '919822222222').single();
  check('6 simultaneous check-ins = exactly 6 visits (no race)', par.every(r => r.status === 200) && racer.visits === 6 && Number(racer.total_spent) === 600, racer);
  check('invalid phone rejected', (await call('visits', { method: 'POST', token: OA, body: { phone: '123' } })).status === 400);
  check('negative bill rejected', (await call('visits', { method: 'POST', token: OA, body: { phone: '9811111111', amount: -5 } })).status === 400);
  const noTpl = await call('visits', { method: 'POST', token: OA, body: { phone: '9811111111', send_review: true } });
  check('message skipped when none is set up', noTpl.body.review?.includes('no check-in message'), noTpl.body.review);

  // ------------------------------------------------------------------
  section('Templates (admin only, Utility only)');
  const mkTpl = async (biz, name, extra = {}) => (await db.from('templates').insert({
    business_id: biz, title: name, name, text: 'Hi {name}, thanks for visiting {business}: {link} Thanks!', body: 'Hi {{1}}, thanks for visiting {{2}}: {{3}} Thanks!',
    params: ['{name}', '{business}', '{link}'], category: 'UTILITY', status: 'APPROVED', meta_id: '1' + run, ...extra,
  }).select().single()).data;
  const thanks = await mkTpl(bizA, 'thanks');
  const waiting = await mkTpl(bizA, 'waiting', { status: 'PENDING' });
  const marketing = await mkTpl(bizA, 'pricey', { category: 'MARKETING' });
  const otherTpl = await mkTpl(bizB, 'bloom_thanks');
  check('owner cannot create a template', (await call('templates', { method: 'POST', token: OA, body: { title: 'x', text: 'Hello {name} there' } })).status === 403);
  check('owner cannot edit a template', (await call('templates?id=' + thanks.id, { method: 'PATCH', token: OA, body: { title: 'x' } })).status === 403);
  check('owner cannot delete a template', (await call('templates?id=' + thanks.id, { method: 'DELETE', token: OA })).status === 403);
  const ownList = await call('templates', { token: OA });
  check('owner only sees approved cheap messages', ownList.body.rows?.map(t => t.title).join() === 'thanks', ownList.body);
  check('owner gets the text only, no Meta details', !('meta_id' in ownList.body.rows[0]) && !!ownList.body.rows[0].text, ownList.body.rows[0]);
  check('owner B does not see A templates', (await call('templates', { token: OB })).body.rows?.every(t => t.title !== 'thanks'));
  const admList = await call(`templates?business_id=${bizA}`, { token: A });
  check('admin sees all, with Marketing flagged unsendable', admList.body.rows?.length === 3 && admList.body.rows.find(t => t.name === 'pricey').sendable === false, admList.body);
  check('creating without a WhatsApp account explains why', /WhatsApp account ID/.test((await call('templates', { method: 'POST', token: A, body: { business_id: bizA, title: 'x', text: 'Hello {name} there' } })).body.error));
  await call(`businesses?id=${bizA}`, { method: 'PATCH', token: A, body: { wa_waba_id: '123', wa_token: 'fake-token' } });
  const tplErr = async text => (await call('templates', { method: 'POST', token: A, body: { business_id: bizA, title: 'x', text } })).body.error;
  check('unknown variable refused', /not available/.test(await tplErr('Hello {price} there')));
  check('message cannot start with a variable', /start or end/.test(await tplErr('{name} hello there')));
  check('message cannot end with a variable', /start or end/.test(await tplErr('Hello there {name}')));
  check('two variables side by side refused', /between two/.test(await tplErr('Hello {name} {business} there')));
  check('a real Meta error is shown, not hidden', typeof (await tplErr('Hello {name} there')) === 'string');
  check('check-in message must belong to this restaurant', (await call(`businesses?id=${bizA}`, { method: 'PATCH', token: A, body: { checkin_template_id: otherTpl.id } })).status === 400);

  // ------------------------------------------------------------------
  section('No repeat messages');
  await call(`businesses?id=${bizA}`, { method: 'PATCH', token: A, body: { checkin_template_id: waiting.id } });
  const pend = await call('visits', { method: 'POST', token: OA, body: { phone: '9811111111', send_review: true } });
  check('template waiting for approval is not sent', pend.body.review?.includes('waiting for approval'), pend.body.review);
  await call(`businesses?id=${bizA}`, { method: 'PATCH', token: A, body: { checkin_template_id: marketing.id } });
  const mk1 = await call('visits', { method: 'POST', token: OA, body: { phone: '9811111111', send_review: true } });
  check('Marketing template is blocked at check-in', mk1.body.review?.includes('waiting for approval'), mk1.body.review);
  await call(`businesses?id=${bizA}`, { method: 'PATCH', token: A, body: { checkin_template_id: thanks.id } });
  const rv1 = await call('visits', { method: 'POST', token: OA, body: { phone: '9811111111', send_review: true } });
  check('failed send is reported', rv1.body.review?.startsWith('failed'), rv1.body.review);
  const rv2 = await call('visits', { method: 'POST', token: OA, body: { phone: '9811111111', send_review: true } });
  check('a failed message can be retried', rv2.body.review?.startsWith('failed'), rv2.body.review);
  const { count: orphanReviews } = await db.from('reviews').select('id', { count: 'exact', head: true }).eq('customer_id', neha.id);
  check('failed send leaves no review link behind', orphanReviews === 0, orphanReviews);
  await db.from('messages').insert({ business_id: bizA, customer_id: neha.id, template_name: 'thanks', status: 'sent', sent_at: new Date(Date.now() - 5 * 864e5).toISOString() });
  const rep1 = await call('visits', { method: 'POST', token: OA, body: { phone: '9811111111', send_review: true } });
  check('same message within 30 days is not sent again', rep1.body.review?.startsWith('skipped: already sent on'), rep1.body.review);
  const { data: racerRow } = await db.from('customers').select('id').eq('business_id', bizA).eq('phone', '919822222222').single();
  await Promise.all(Array.from({ length: 5 }, () => call('visits', { method: 'POST', token: OA, body: { phone: '9822222222', send_review: true } })));
  const { count: claims } = await db.from('messages').select('id', { count: 'exact', head: true }).eq('customer_id', racerRow.id).eq('status', 'sending');
  check('no message left stuck after simultaneous check-ins', claims === 0, claims);
  const racing = await Promise.all(Array.from({ length: 5 }, () => db.rpc('claim_message', { p_business: bizA, p_customer: racerRow.id, p_template: 'race', p_days: 30 })));
  check('5 simultaneous claims: exactly one message wins', racing.filter(r => r.data).length === 1, racing.map(r => r.data));
  await db.from('messages').delete().eq('customer_id', racerRow.id).eq('template_name', 'race');
  await db.from('messages').update({ sent_at: new Date(Date.now() - 31 * 864e5).toISOString() }).eq('customer_id', neha.id).eq('status', 'sent');
  const later = await call('visits', { method: 'POST', token: OA, body: { phone: '9811111111', send_review: true } });
  check('after 30 days it can go again', later.body.review?.startsWith('failed'), later.body.review);
  await call(`businesses?id=${bizA}`, { method: 'PATCH', token: A, body: { repeat_days: 60 } });
  const rule = await call('visits', { method: 'POST', token: OA, body: { phone: '9811111111', send_review: true } });
  check('repeat days can be changed per restaurant', rule.body.review?.startsWith('skipped: already sent'), rule.body.review);
  await call(`businesses?id=${bizA}`, { method: 'PATCH', token: A, body: { repeat_days: 30 } });
  const noCons = await call('visits', { method: 'POST', token: OA, body: { phone: '9833333333', consent: false, send_review: true } });
  check('no message without consent', noCons.body.review === 'skipped: no WhatsApp consent', noCons.body.review);
  const { data: rvIns } = await db.from('reviews').insert({ business_id: bizA, customer_id: neha.id, token: 'tok' + run + 'abcdef' }).select('token').single();

  // ------------------------------------------------------------------
  section('Public review page');
  const tk = rvIns.token;
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
  section('Select customers and send');
  const allA = (await call('customers?all=1', { token: OA })).body.rows;
  const priya = allA.find(c => c.name === 'Priya'), amit = allA.find(c => c.name === 'Amit');
  check('sending needs a customer', (await call('send', { method: 'POST', token: OA, body: { template_id: thanks.id, ids: [] } })).status === 400);
  check('Marketing template cannot be sent', /low-cost/.test((await call('send', { method: 'POST', token: OA, body: { template_id: marketing.id, ids: [priya.id] } })).body.error));
  check('template waiting for approval cannot be sent', (await call('send', { method: 'POST', token: OA, body: { template_id: waiting.id, ids: [priya.id] } })).status === 400);
  check('another restaurant\'s template refused', (await call('send', { method: 'POST', token: OA, body: { template_id: otherTpl.id, ids: [priya.id] } })).status === 404);
  const s1 = await call('send', { method: 'POST', token: OA, body: { template_id: thanks.id, ids: [priya.id, amit.id, bCust.id] } });
  check('selected customers queued; another restaurant\'s customer skipped', s1.body.queued === 2 && s1.body.skipped === 1, s1.body);
  check('owner B cannot send A batch', (await call('send-batch', { method: 'POST', token: OB, body: { campaign_id: s1.body.id } })).status === 404);
  const again = await call('send', { method: 'POST', token: OA, body: { template_id: thanks.id, ids: [priya.id] } });
  check('already queued customer is not queued twice', again.body.queued === 0 && again.body.skipped === 1, again.body);
  const pendingList = await call('messages', { token: OA });
  check('unfinished send can be continued', pendingList.body.pending?.[0]?.queued === 2, pendingList.body.pending);
  const sb = await call('send-batch', { method: 'POST', token: OA, body: { campaign_id: s1.body.id } });
  check('failed sends are counted with the reason', sb.body.failed === 2 && sb.body.remaining === 0 && !!sb.body.last_error, sb.body);
  const vipOnly = await call('send', { method: 'POST', token: OA, body: { template_id: thanks.id, all: true, filters: { group: 'vip' } } });
  check('select all follows the filter (VIP only)', vipOnly.body.queued === 1 && vipOnly.body.skipped === 0, vipOnly.body);
  await db.from('customers').update({ opted_out_at: new Date().toISOString() }).eq('id', amit.id);
  await db.from('templates').update({ category: 'MARKETING' }).eq('id', thanks.id);
  const blocked = await call('send-batch', { method: 'POST', token: OA, body: { campaign_id: vipOnly.body.id } });
  check('template re-labelled Marketing mid-send stops the batch', blocked.status === 400 && /no longer approved/.test(blocked.body.error), blocked.body);
  await db.from('templates').update({ category: 'UTILITY' }).eq('id', thanks.id);
  const optOut = await call('send', { method: 'POST', token: OA, body: { template_id: thanks.id, ids: [amit.id] } });
  check('unsubscribed customer is skipped', optOut.body.queued === 0 && optOut.body.skipped === 1, optOut.body);
  await db.from('customers').update({ opted_out_at: null }).eq('id', amit.id);
  const sentList = await call('messages', { token: OA });
  check('sent messages list works', sentList.body.total >= 2 && !!sentList.body.rows[0].customers, sentList.body.total);
  check('sent messages are read-only', (await call('messages', { method: 'POST', token: OA, body: {} })).status === 405);
  check('owner B sees no A messages', (await call('messages', { token: OB })).body.total === 0);
  check('old offer and coupon routes are gone', (await call('campaigns', { token: OA })).status === 404 && (await call('coupons?code=ABCD', { token: OA })).status === 404);

  // ------------------------------------------------------------------
  section('Stats & QR');
  const st = await call('stats', { token: OA });
  check('stats', st.body.customers === 6 && st.body.visits_by_day?.length === 14 && st.body.ratings === 1, st.body);
  check('QR needs WhatsApp number', (await call('qr', { token: OA })).status === 400);
  check('invalid WhatsApp number refused', (await call(`businesses?id=${bizA}`, { method: 'PATCH', token: A, body: { wa_number: '12' } })).status === 400);
  await call(`businesses?id=${bizA}`, { method: 'PATCH', token: A, body: { wa_number: '98000 11111', wa_phone_number_id: '1111' + run.replace(/\D/g, '') } });
  const qr = await call('qr', { token: OA });
  check('QR code generated', qr.body.svg?.startsWith('<svg') && qr.body.link === 'https://wa.me/919800011111?text=JOIN', qr.body.link);
  check('non-https review link refused', (await call(`businesses?id=${bizA}`, { method: 'PATCH', token: A, body: { google_review_url: 'javascript:alert(1)' } })).status === 400);

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
  section('Birthdays');
  const O2 = pc.body.token;
  const cron = () => call('cron/daily', { headers: { authorization: 'Bearer ' + process.env.CRON_SECRET } });
  check('cron refuses callers without the secret', (await call('cron/daily')).status === 401);
  const wishes = async () => (await db.from('messages').select('status').eq('customer_id', rahul.id).eq('kind', 'birthday')).data;
  const bd1 = await mkTpl(bizA, 'bday_one', { purpose: 'birthday', category: 'MARKETING' });
  const bd2 = await mkTpl(bizA, 'bday_two', { purpose: 'birthday', category: 'MARKETING' });
  const bdWait = await mkTpl(bizA, 'bday_wait', { purpose: 'birthday', category: 'MARKETING', status: 'PENDING' });
  const bdOther = await mkTpl(bizC, 'bday_other', { purpose: 'birthday', category: 'MARKETING' });
  check('owner without access is refused', (await call('birthdays', { token: O2 })).status === 403);
  check('owner cannot give themselves access', (await call(`businesses?id=${bizA}`, { method: 'PATCH', token: O2, body: { birthday_access: true } })).status === 403);
  check('owner without access sees no birthday messages', (await call('templates', { token: O2 })).body.rows?.every(t => t.purpose !== 'birthday'));
  check('admin cannot switch on before giving access', (await call('birthdays', { method: 'PATCH', token: A, body: { business_id: bizA, auto: true } })).status === 400);
  await call(`businesses?id=${bizA}`, { method: 'PATCH', token: A, body: { birthday_access: true } });
  const bg = await call('birthdays', { token: O2 });
  check('owner sees only approved birthday messages', bg.body.templates?.map(t => t.title).join() === 'bday_one,bday_two', bg.body.templates);
  check('switching on needs a message', (await call('birthdays', { method: 'PATCH', token: O2, body: { auto: true } })).status === 400);
  check('message waiting for approval cannot be picked', (await call('birthdays', { method: 'PATCH', token: O2, body: { template_id: bdWait.id } })).status === 400);
  check('thank-you message cannot be picked as birthday', (await call('birthdays', { method: 'PATCH', token: O2, body: { template_id: thanks.id } })).status === 400);
  check('another restaurant\'s message cannot be picked', (await call('birthdays', { method: 'PATCH', token: O2, body: { template_id: bdOther.id } })).status === 400);
  check('birthday message cannot go in a bulk send', (await call('send', { method: 'POST', token: O2, body: { template_id: bd1.id, ids: [priya.id] } })).status === 400);
  check('birthday message cannot be the check-in message', (await call(`businesses?id=${bizA}`, { method: 'PATCH', token: A, body: { checkin_template_id: bd1.id } })).status === 400);
  check('owner picks a message and switches on', (await call('birthdays', { method: 'PATCH', token: O2, body: { template_id: bd2.id, auto: true } })).status === 200);
  const today = new Date(Date.now() + 5.5 * 36e5);
  const pad = n => String(n).padStart(2, '0');
  await db.from('customers').update({ birthday: `1990-${pad(today.getUTCMonth() + 1)}-${pad(today.getUTCDate())}` }).eq('id', rahul.id);
  const up = await call('birthdays', { token: O2 });
  check('upcoming list shows today\'s birthday first', up.body.upcoming?.[0]?.id === rahul.id && up.body.upcoming[0].days_away === 0, up.body.upcoming?.[0]);
  await call('birthdays', { method: 'PATCH', token: O2, body: { auto: false } });
  await cron();
  check('switched off: no wish goes out', (await wishes()).length === 0);
  await call('birthdays', { method: 'PATCH', token: O2, body: { auto: true } });
  await call(`businesses?id=${bizA}`, { method: 'PATCH', token: A, body: { birthday_access: false } });
  await cron();
  check('access removed: no wish goes out, even if switched on', (await wishes()).length === 0);
  await call(`businesses?id=${bizA}`, { method: 'PATCH', token: A, body: { birthday_access: true } });
  const cr = await cron();
  check('cron tries the wish', cr.status === 200 && cr.body.birthdays.failed >= 1, cr.body);
  check('failed wish is recorded', (await wishes()).map(m => m.status).join() === 'failed', await wishes());
  await db.from('messages').update({ status: 'sent' }).eq('customer_id', rahul.id).eq('kind', 'birthday');
  await cron();
  check('only one wish a year', (await wishes()).length === 1, await wishes());
  const race = await Promise.all(Array.from({ length: 5 }, () => db.rpc('claim_birthday', { p_business: bizA, p_customer: priya.id, p_template: 'x' })));
  check('5 simultaneous birthday claims: exactly one wins', race.filter(r => r.data).length === 1, race.map(r => r.data));

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
