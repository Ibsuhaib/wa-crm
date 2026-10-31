// hungriAR CRM dashboard. Plain JS, no build step. Loaded as a module (CSP blocks inline scripts).

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const inr = n => '₹' + Math.round(Number(n) || 0).toLocaleString('en-IN');
const nf = n => (Number(n) || 0).toLocaleString('en-IN');
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: '2-digit' }) : '–';
const fmtDay = d => d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }) : '–';
const fmtWhen = d => d ? new Date(d).toLocaleString('en-IN', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '–';
const phoneFmt = p => p ? '+' + String(p).replace(/^91(\d{5})(\d{5})$/, '91 $1 $2') : '';
const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);
const lines = s => String(s || '').split('\n').map(x => x.trim()).filter(Boolean);
const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

const state = { token: store.get('crm.token'), role: store.get('crm.role'), bizId: store.get('crm.biz'), businesses: [], page: 'overview' };
const biz = () => state.businesses.find(b => b.id === state.bizId);

// ---------- API ----------

async function api(path, { method = 'GET', body } = {}) {
  const r = await fetch('/api/' + path, {
    method,
    headers: { 'content-type': 'application/json', ...(state.token ? { authorization: 'Bearer ' + state.token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && state.token && path !== 'login') { logout('Your session ended. Please log in again.'); throw new Error('Please log in again'); }
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}
const withBiz = path => path + (path.includes('?') ? '&' : '?') + 'business_id=' + encodeURIComponent(state.bizId);

let toastTimer;
function toast(msg, bad) {
  const t = $('#toast');
  t.textContent = msg; t.className = bad ? 'bad' : ''; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), bad ? 6000 : 3000);
}
function notice(el, msg, kind = 'bad') { el.className = 'notice ' + kind; el.textContent = msg; el.hidden = !msg; }

// Run an async action with the button disabled; show the error as a toast.
async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, true); } finally { if (btn) btn.disabled = false; }
}

// ---------- icons ----------

const I = {
  overview: '<path d="M3 13h8V3H3zM13 21h8V11h-8zM3 21h8v-6H3zM13 3v6h8V3z"/>',
  checkin: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="m16 11 2 2 4-4"/>',
  customers: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  campaigns: '<path d="m3 11 18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
  coupons: '<path d="M20 12V8H4v4a2 2 0 1 1 0 4v4h16v-4a2 2 0 1 1 0-4z"/><path d="M9 8v12"/>',
  reviews: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
  qr: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
};
const icon = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[k]}</svg>`;

const PAGES = [
  ['overview', 'Overview'], ['checkin', 'Check-in'], ['customers', 'Customers'], ['campaigns', 'Campaigns'],
  ['coupons', 'Coupons'], ['reviews', 'Reviews'], ['qr', 'QR sign-up'], ['settings', 'Settings'],
];

// ---------- login ----------

let loginMode = 'owner';
$$('.seg button').forEach(b => b.onclick = () => {
  loginMode = b.dataset.mode;
  $$('.seg button').forEach(x => x.classList.toggle('on', x === b));
  $$('[data-for]').forEach(d => d.hidden = d.dataset.for !== loginMode);
});
$('#loginForm').onsubmit = e => {
  e.preventDefault();
  const f = e.target, btn = $('button.btn', f);
  busy(btn, async () => {
    try {
      const body = loginMode === 'admin' ? { admin_key: f.admin_key.value } : { slug: f.slug.value, password: f.password.value };
      const r = await api('login', { method: 'POST', body });
      state.token = r.token; state.role = r.role;
      store.set('crm.token', r.token); store.set('crm.role', r.role);
      f.reset(); $('#loginMsg').hidden = true;
      await boot();
    } catch (err) { notice($('#loginMsg'), err.message); }
  });
};

function logout(msg) {
  state.token = state.role = null; state.businesses = [];
  store.set('crm.token', null); store.set('crm.role', null);
  $('#appView').hidden = true; $('#loginView').hidden = false;
  if (msg) notice($('#loginMsg'), msg, 'warn');
}
$('#logout').onclick = () => logout();
$('#menuBtn').onclick = e => { e.stopPropagation(); $('#side').classList.toggle('open'); };
// On phones, tapping anywhere outside the open menu closes it.
document.addEventListener('click', e => { if (!e.target.closest('#side')) $('#side').classList.remove('open'); });

// ---------- shell ----------

async function boot() {
  if (!state.token) return logout();
  try {
    const me = await api('me');
    state.role = me.role;
    await loadBusinesses(me.business_id);
  } catch { return; }
  $('#loginView').hidden = true; $('#appView').hidden = false;
  $('#nav').innerHTML = PAGES.map(([id, label]) => `<button data-page="${id}">${icon(id)}<span>${label}</span></button>`).join('');
  $('#nav').onclick = e => { const b = e.target.closest('button'); if (b) go(b.dataset.page); };
  const hash = location.hash.replace('#/', '');
  go(PAGES.some(p => p[0] === hash) ? hash : (state.businesses.length ? 'overview' : 'settings'));
}

async function loadBusinesses(ownBiz) {
  state.businesses = await api('businesses');
  if (state.role === 'owner') state.bizId = ownBiz;
  else if (!state.businesses.some(b => b.id === state.bizId)) state.bizId = state.businesses[0]?.id || null;
  store.set('crm.biz', state.bizId);
  const isAdmin = state.role === 'admin';
  $('#bizPick').hidden = !isAdmin || !state.businesses.length;
  $('#bizSel').innerHTML = state.businesses.map(b => `<option value="${b.id}">${esc(b.name)}${b.active ? '' : ' (paused)'}</option>`).join('');
  $('#bizSel').value = state.bizId || '';
  $('#whoami').textContent = isAdmin ? 'Platform admin' : (biz()?.name || '');
}
$('#bizSel').onchange = e => { state.bizId = e.target.value; store.set('crm.biz', state.bizId); go(state.page); };

function go(page, fromHash = false) {
  if (!fromHash && location.hash !== '#/' + page) history.pushState(null, '', '#/' + page);
  state.page = page;
  $$('#nav button').forEach(b => b.classList.toggle('on', b.dataset.page === page));
  $('#side').classList.remove('open');
  closeDrawer();
  const el = $('#page');
  if (!state.bizId && page !== 'settings') {
    el.innerHTML = head('Welcome', 'Add your first restaurant to get started.') + `<div class="card empty"><button class="btn btn-gold" data-go="settings">Add a restaurant</button></div>`;
    $('[data-go]', el).onclick = () => go('settings');
    return;
  }
  el.innerHTML = '<div class="empty">Loading…</div>';
  RENDER[page](el).catch(e => { el.innerHTML = head('Something went wrong') + `<div class="notice bad">${esc(e.message)}</div>`; });
  window.scrollTo(0, 0);
}

const head = (title, sub = '', actions = '') =>
  `<div class="page-head"><div><h1>${esc(title)}</h1>${sub ? `<p class="muted">${esc(sub)}</p>` : ''}</div><div class="row">${actions}</div></div>`;

const RENDER = {};

// ---------- overview ----------

RENDER.overview = async el => {
  const b = biz();
  const [s, low] = await Promise.all([api(withBiz('stats')), api(withBiz('reviews?filter=low'))]);
  const repeatRate = s.visited ? Math.round(s.repeat / s.visited * 100) : 0;
  const max = Math.max(1, ...s.visits_by_day.map(d => d.visits));
  const setup = [
    [!!b.wa_phone_number_id && b.has_token, 'Connect WhatsApp (phone number ID + token)'],
    [!!b.google_review_url, 'Add your Google review link'],
    [!!b.review_template, 'Set your review message template'],
    [!!b.wa_number, 'Add your WhatsApp number for the QR sign-up'],
    [!!b.loyalty_every, 'Turn on loyalty rewards (optional)'],
  ];
  const todo = setup.filter(x => !x[0]);
  el.innerHTML = head(b.name, 'Last 30 days at a glance', `<button class="btn btn-gold" data-go="checkin">${icon('checkin')} Check in a guest</button>`) + `
    ${todo.length ? `<div class="card"><div class="card-head"><h2>Finish setting up</h2><span class="badge gold">${setup.length - todo.length} of ${setup.length} done</span></div>
      ${setup.map(([ok, t]) => `<div class="check" style="margin:6px 0"><span class="badge ${ok ? 'good' : ''}">${ok ? '✓' : '•'}</span> ${esc(t)}</div>`).join('')}
      <button class="btn btn-ghost btn-sm" data-go="settings" style="margin-top:10px">Open settings</button></div>` : ''}
    <div class="stats six">
      ${tile('Customers', nf(s.customers), `${nf(s.reachable)} reachable on WhatsApp`)}
      ${tile('Visits', nf(s.visits_30d), `${nf(s.new_30d)} new customers`)}
      ${tile('Repeat rate', repeatRate + '%', 'came back 2+ times')}
      ${tile('Revenue logged', inr(s.revenue_30d), 'from check-in bills')}
      ${tile('Avg rating', s.avg_rating ? s.avg_rating + ' ★' : '–', `${nf(s.ratings)} ratings of ${nf(s.review_requests)} asked`)}
      ${tile('Coupons used', nf(s.coupons_redeemed_30d), `${nf(s.coupons_issued_30d)} sent out`)}
    </div>
    <div class="grid g2">
      <div class="card"><h2>Visits, last 14 days</h2>
        <div class="bars">${s.visits_by_day.map(d => `<div class="b" title="${fmtDay(d.day)}: ${d.visits}"><span class="n">${d.visits || ''}</span><div class="fill" style="height:${Math.max(2, Math.round(d.visits / max * 110))}px"></div><span class="lbl">${new Date(d.day).getDate()}</span></div>`).join('')}</div>
      </div>
      <div class="card"><div class="card-head"><h2>Recent complaints</h2><button class="linkbtn" data-go="reviews">See all</button></div>
        ${low.length ? low.slice(0, 5).map(r => `<div style="padding:8px 0;border-bottom:1px solid var(--line)"><span class="stars">${stars(r.rating)}</span> <b>${esc(r.customers?.name || phoneFmt(r.customers?.phone))}</b> <span class="muted small">${fmtWhen(r.rated_at)}</span>${r.feedback ? `<div class="small">${esc(r.feedback)}</div>` : ''}</div>`).join('')
          : '<div class="empty">No complaints. 🎉</div>'}
      </div>
    </div>`;
  $$('[data-go]', el).forEach(x => x.onclick = () => go(x.dataset.go));
};
const tile = (k, v, s) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="s">${esc(s)}</div></div>`;

// ---------- check-in ----------

RENDER.checkin = async el => {
  const b = biz();
  const canReview = b.review_template && b.has_token && b.wa_phone_number_id;
  const reviewHint = !b.has_token || !b.wa_phone_number_id ? '(connect WhatsApp in Settings)' : !b.review_template ? '(set a template in Settings)' : '';
  el.innerHTML = head('Check in a guest', 'Type the mobile number at billing. New guests are added automatically.') + `
    <div class="grid g2">
      <div class="card">
        <form id="ciForm">
          <label>Mobile number <input name="phone" class="input-big" inputmode="tel" autocomplete="off" required placeholder="98765 43210"></label>
          <div class="row" style="margin-top:12px">
            <label>Name (optional) <input name="name" autocomplete="off"></label>
            <label>Bill amount ₹ (optional) <input name="amount" type="number" min="0" step="any" inputmode="decimal"></label>
          </div>
          <label class="check" style="margin-top:14px"><input type="checkbox" name="consent" checked> Guest agreed to get offers on WhatsApp</label>
          <label class="check" style="margin-top:8px"><input type="checkbox" name="send_review" ${canReview ? 'checked' : 'disabled'}> <span>Send review request on WhatsApp ${reviewHint ? `<span class="muted small">${reviewHint}</span>` : ''}</span></label>
          <button class="btn btn-gold btn-block" style="margin-top:16px">Check in</button>
        </form>
        <div id="ciResult"></div>
      </div>
      <div class="card"><h2>How it works</h2>
        <p class="muted small">1. Check in every guest at billing. Their visits and spend add up automatically.<br>
        2. If they agreed, a WhatsApp message asks them to rate the visit. Happy guests get your Google review link, and unhappy ones can message you privately.<br>
        3. ${b.loyalty_every ? `Every <b>${b.loyalty_every}th</b> visit earns <b>${esc(b.loyalty_reward || 'a reward')}</b>, and you'll see a gold banner here.` : 'Turn on loyalty rewards in Settings (e.g. every 5th visit gets a free dessert).'}<br>
        4. Any unused coupons the guest has show up here, so you can redeem them in one tap.</p>
      </div>
    </div>`;
  const f = $('#ciForm');
  f.phone.focus();
  f.onsubmit = e => {
    e.preventDefault();
    busy($('button', f), async () => {
      const r = await api('visits', { method: 'POST', body: {
        business_id: state.bizId, phone: f.phone.value, name: f.name.value, amount: f.amount.value || null,
        consent: f.consent.checked, send_review: f.send_review.checked,
      } });
      const c = r.customer;
      const rv = r.review;
      $('#ciResult').innerHTML = `<div class="result">
        <div class="who">${esc(c.name || 'Guest')} <span class="muted small">${phoneFmt(c.phone)}</span></div>
        <div style="margin-top:6px">${c.new ? '<span class="badge gold">New guest</span>' : `<span class="badge good">Visit #${c.visits}</span>`}
          <span class="badge">Total spent ${inr(c.total_spent)}</span>
          ${r.next_reward_in ? `<span class="badge">${r.next_reward_in} more visit${r.next_reward_in > 1 ? 's' : ''} to reward</span>` : ''}</div>
        ${r.reward ? `<div class="reward">🎁 Reward earned: ${esc(r.reward)}</div>` : ''}
        <div class="small" style="margin-top:10px">Review request: <span class="badge ${rv === 'sent' ? 'good' : rv.startsWith('failed') ? 'bad' : ''}">${esc(rv)}</span></div>
        ${r.coupons.length ? `<div style="margin-top:12px"><h3>Unused coupons</h3>${r.coupons.map(k => `<div class="coupon-row"><div><span class="code">${esc(k.code)}</span> · ${k.percent}% off <span class="muted small">till ${fmtDay(k.expires_at)}</span></div><button class="btn btn-gold btn-sm" data-redeem="${esc(k.code)}">Redeem</button></div>`).join('')}</div>` : ''}
      </div>`;
      $$('[data-redeem]', el).forEach(x => x.onclick = () => busy(x, async () => {
        const k = await api('coupons', { method: 'POST', body: { business_id: state.bizId, code: x.dataset.redeem } });
        x.replaceWith(Object.assign(document.createElement('span'), { className: 'badge good', textContent: `Redeemed · ${k.percent}% off` }));
      }));
      f.phone.value = f.name.value = f.amount.value = '';
      f.phone.focus();
    });
  };
};

// ---------- customers ----------

const cust = { q: '', tag: '', filter: '', page: 0 };

RENDER.customers = async el => {
  el.innerHTML = head('Customers', 'Everyone who has checked in, joined by QR or been imported.',
    `<button class="btn btn-ghost" id="exportBtn">${icon('download')} Export CSV</button><button class="btn btn-gold" id="addBtn">${icon('plus')} Add / import</button>`) + `
    <div class="card" id="addCard" hidden>
      <h2>Add or import customers</h2>
      <p class="muted small">One per line: <code>phone, name, tags, birthday</code>. Tags are separated by <code>;</code> and the birthday is YYYY-MM-DD. You can also upload a CSV.</p>
      <textarea id="impBox" placeholder="9876543210, Rahul Sharma, vip;regular, 1994-08-21&#10;9123456780, Priya"></textarea>
      <div class="row" style="margin-top:10px;align-items:center">
        <input type="file" id="impFile" accept=".csv,.txt" style="flex:1 1 200px">
      </div>
      <label class="check" style="margin-top:12px"><input type="checkbox" id="impConsent"> These customers agreed to receive WhatsApp messages from us</label>
      <button class="btn btn-gold" id="impBtn" style="margin-top:12px">Save customers</button>
      <div id="impMsg" hidden></div>
    </div>
    <div class="card">
      <div class="row" style="margin-bottom:6px">
        <label>Search <input id="cq" placeholder="Name or phone" value="${esc(cust.q)}"></label>
        <label>Tag <input id="ctag" placeholder="vip" value="${esc(cust.tag)}"></label>
        <label>Show <select id="cfilter">
          <option value="">Everyone</option><option value="birthday">Has birthday</option><option value="opted_out">Unsubscribed</option>
        </select></label>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Phone</th><th class="num">Visits</th><th class="num hide-sm">Spent</th><th class="hide-sm">Last visit</th><th class="hide-sm">Tags</th></tr></thead>
        <tbody id="crows"><tr><td colspan="6" class="empty">Loading…</td></tr></tbody>
      </table></div>
      <div class="pager"><span class="muted small" id="ccount"></span><div class="row"><button class="btn btn-ghost btn-sm" id="cprev">Previous</button><button class="btn btn-ghost btn-sm" id="cnext">Next</button></div></div>
    </div>`;
  $('#cfilter').value = cust.filter;
  let timer;
  const reload = () => { clearTimeout(timer); timer = setTimeout(() => { cust.page = 0; loadCustomers(); }, 250); };
  $('#cq').oninput = e => { cust.q = e.target.value; reload(); };
  $('#ctag').oninput = e => { cust.tag = e.target.value; reload(); };
  $('#cfilter').onchange = e => { cust.filter = e.target.value; reload(); };
  $('#cprev').onclick = () => { cust.page = Math.max(0, cust.page - 1); loadCustomers(); };
  $('#cnext').onclick = () => { cust.page++; loadCustomers(); };
  $('#addBtn').onclick = () => { $('#addCard').hidden = !$('#addCard').hidden; };
  $('#impFile').onchange = async e => { const file = e.target.files[0]; if (file) $('#impBox').value = await file.text(); };
  $('#impBtn').onclick = e => busy(e.target, async () => {
    const rows = parseCsv($('#impBox').value).filter(r => /\d{6}/.test(r[0] || ''));  // skips a header row
    if (!rows.length) throw new Error('Nothing to import. Put one phone number per line.');
    const r = await api('customers', { method: 'POST', body: {
      business_id: state.bizId, consent: $('#impConsent').checked,
      customers: rows.map(([phone, name, tags, birthday]) => ({ phone, name, tags: (tags || '').split(';'), birthday })),
    } });
    notice($('#impMsg'), `Saved ${r.saved}: ${r.added} new, ${r.updated} updated.` + (r.invalid.length ? ` Skipped invalid numbers: ${r.invalid.join(', ')}` : ''), r.invalid.length ? 'warn' : 'good');
    $('#impBox').value = '';
    loadCustomers();
  });
  $('#exportBtn').onclick = e => busy(e.target, exportCustomers);
  $('#crows').onclick = e => { const tr = e.target.closest('tr[data-id]'); if (tr) openCustomer(tr.dataset.id); };
  await loadCustomers();
};

async function loadCustomers() {
  const qs = new URLSearchParams({ q: cust.q, tag: cust.tag, filter: cust.filter, page: cust.page });
  const r = await api(withBiz('customers?' + qs));
  $('#crows').innerHTML = r.rows.map(c => `<tr class="click" data-id="${c.id}">
      <td><b>${esc(c.name) || '<span class="muted">–</span>'}</b>${c.opted_out_at ? ' <span class="badge bad">unsubscribed</span>' : ''}${!c.consent_at ? ' <span class="badge warn">no consent</span>' : ''}</td>
      <td class="nowrap">${phoneFmt(c.phone)}</td><td class="num">${c.visits}</td><td class="num hide-sm">${inr(c.total_spent)}</td>
      <td class="hide-sm">${fmtDate(c.last_visit_at)}</td><td class="hide-sm">${c.tags.map(t => `<span class="badge">${esc(t)}</span>`).join('')}</td></tr>`).join('')
    || `<tr><td colspan="6" class="empty">${cust.q || cust.tag || cust.filter ? 'No customers match.' : 'No customers yet. Check in a guest or import a list.'}</td></tr>`;
  const from = r.total ? r.page * r.limit + 1 : 0, to = Math.min(r.total, (r.page + 1) * r.limit);
  $('#ccount').textContent = `${from}–${to} of ${nf(r.total)}`;
  $('#cprev').disabled = r.page === 0;
  $('#cnext').disabled = to >= r.total;
}

// Minimal CSV parser: handles quotes and commas inside quotes.
function parseCsv(text) {
  return String(text).split(/\r?\n/).filter(l => l.trim()).map(line => {
    const out = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  });
}

async function exportCustomers() {
  const r = await api(withBiz('customers?all=1'));
  // Prefix cells starting with = + - @ so Excel never runs them as formulas (CSV injection).
  const cell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const rows = [['phone', 'name', 'tags', 'birthday', 'visits', 'total_spent', 'last_visit', 'joined', 'source', 'unsubscribed']]
    .concat(r.rows.map(c => [c.phone, c.name, c.tags.join(';'), c.birthday, c.visits, c.total_spent, c.last_visit_at?.slice(0, 10), c.created_at.slice(0, 10), c.source, c.opted_out_at ? 'yes' : '']));
  const blob = new Blob(['﻿' + rows.map(r => r.map(cell).join(',')).join('\r\n')], { type: 'text/csv' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `customers-${new Date().toISOString().slice(0, 10)}.csv` });
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`Exported ${r.rows.length} customers`);
}

// ---------- customer drawer ----------

function closeDrawer() { $('#drawerRoot').innerHTML = ''; }

async function openCustomer(id) {
  const c = await api('customers/detail?id=' + encodeURIComponent(id)).catch(e => toast(e.message, true));
  if (!c) return;
  const root = $('#drawerRoot');
  root.innerHTML = `<div class="drawer-bg"></div><aside class="drawer" role="dialog" aria-label="Customer">
    <div class="drawer-head"><div><h1>${esc(c.name || 'Guest')}</h1><div class="muted">${phoneFmt(c.phone)} · joined ${fmtDate(c.created_at)} via ${esc(c.source)}</div></div><button class="x" aria-label="Close">×</button></div>
    <div class="kv"><div><b>${c.visits}</b><span>visits</span></div><div><b>${inr(c.total_spent)}</b><span>spent</span></div><div><b>${fmtDay(c.last_visit_at)}</b><span>last visit</span></div></div>
    ${c.opted_out_at ? `<div class="notice bad" style="margin:0 0 14px">Unsubscribed on ${fmtDate(c.opted_out_at)}. They can re-join by sending START on WhatsApp.</div>` : ''}
    <div class="card"><form id="cEdit">
      <label>Name <input name="name" value="${esc(c.name)}"></label>
      <label>Tags (comma separated) <input name="tags" value="${esc(c.tags.join(', '))}"></label>
      <label>Birthday <input name="birthday" type="date" value="${esc(c.birthday || '')}"></label>
      ${!c.consent_at ? '<label class="check" style="margin-top:12px"><input type="checkbox" name="consent"> Customer agreed to WhatsApp messages</label>' : ''}
      <button class="btn btn-gold" style="margin-top:14px">Save</button>
    </form></div>
    <div class="card"><h2>Coupons</h2>${c.coupons.length ? c.coupons.map(k => `<div class="coupon-row"><div><span class="code">${esc(k.code)}</span> · ${k.percent}% ${k.reason === 'birthday' ? '🎂' : ''}<div class="muted small">expires ${fmtDate(k.expires_at)}</div></div>${k.redeemed_at ? `<span class="badge good">used ${fmtDay(k.redeemed_at)}</span>` : new Date(k.expires_at) < new Date() ? '<span class="badge">expired</span>' : '<span class="badge gold">active</span>'}</div>`).join('') : '<div class="muted small">No coupons yet.</div>'}</div>
    <div class="card"><h2>Ratings</h2>${c.reviews.filter(r => r.rating).map(r => `<div style="padding:6px 0"><span class="stars">${stars(r.rating)}</span> <span class="muted small">${fmtDate(r.rated_at)}</span>${r.feedback ? `<div class="small">${esc(r.feedback)}</div>` : ''}</div>`).join('') || '<div class="muted small">No ratings yet.</div>'}</div>
    <div class="card"><h2>Visit history</h2>${c.visit_list.map(v => `<div class="row" style="justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--line)"><span>${fmtWhen(v.created_at)}</span><span>${v.amount ? inr(v.amount) : '–'}</span></div>`).join('') || '<div class="muted small">No visits yet.</div>'}</div>
    <div class="row">${!c.opted_out_at ? '<button class="btn btn-ghost btn-sm" id="cOpt">Unsubscribe from messages</button>' : ''}<button class="btn btn-danger btn-sm" id="cDel">Delete customer</button></div>
  </aside>`;
  $('.drawer-bg', root).onclick = $('.x', root).onclick = closeDrawer;
  $('#cEdit').onsubmit = e => {
    e.preventDefault();
    const f = e.target;
    busy($('button', f), async () => {
      await api('customers?id=' + c.id, { method: 'PATCH', body: { name: f.name.value, tags: f.tags.value.split(','), birthday: f.birthday.value || null, ...(f.consent?.checked ? { consent: true } : {}) } });
      toast('Saved'); closeDrawer(); loadCustomers();
    });
  };
  $('#cOpt') && ($('#cOpt').onclick = e => confirm('Stop all WhatsApp messages to this customer?') && busy(e.target, async () => {
    await api('customers?id=' + c.id, { method: 'PATCH', body: { opted_out: true } }); toast('Unsubscribed'); closeDrawer(); loadCustomers();
  }));
  $('#cDel').onclick = e => confirm('Delete this customer and all their visits, coupons and ratings? This cannot be undone.') && busy(e.target, async () => {
    await api('customers?id=' + c.id, { method: 'DELETE' }); toast('Deleted'); closeDrawer(); loadCustomers();
  });
}

// ---------- campaigns ----------

RENDER.campaigns = async el => {
  el.innerHTML = head('Campaigns', 'Send an offer or message to a group of customers on WhatsApp.') + `
    <div class="card"><h2>New campaign</h2>
      <form id="campForm">
        <div class="section-title">1 · Who gets it</div>
        <div class="row">
          <label>Audience <select name="segment">
            <option value="all">Everyone</option>
            <option value="inactive">Haven't visited in a while (win-back)</option>
            <option value="regulars">Regulars</option>
            <option value="new">New customers</option>
            <option value="tag">Customers with a tag</option>
          </select></label>
          <label data-seg="inactive regulars new">
            <span id="segLabel">Days</span> <input name="segment_value" type="number" min="1" value="30"></label>
          <label data-seg="tag">Tag <input name="tag" placeholder="vip"></label>
        </div>
        <div class="notice" id="audience">Counting…</div>
        <div class="section-title">2 · What they get</div>
        <div class="row">
          <label>Campaign name <input name="name" required placeholder="Weekend 10% off" maxlength="80"></label>
          <label>Type <select name="kind"><option value="offer">Offer with unique coupon code</option><option value="message">Message only</option></select></label>
        </div>
        <div class="row" data-kind="offer" style="margin-top:12px">
          <label>Discount % <input name="offer_percent" type="number" min="1" max="100" value="10"></label>
          <label>Valid for (days) <input name="offer_valid_days" type="number" min="1" max="365" value="14"></label>
        </div>
        <div class="section-title">3 · WhatsApp template</div>
        <div class="row">
          <label>Approved template name <input name="template_name" required placeholder="next_visit_offer" pattern="[a-z0-9_]+" title="lowercase letters, numbers and _ exactly as in Meta"></label>
          <label>Language <input name="template_lang" value="en"></label>
        </div>
        <label style="margin-top:12px">Template variables, one per line, in order ({{1}}, {{2}}…)
          <textarea name="params">{name}
{business}
{percent}
{code}
{expiry}</textarea>
          <span class="hint">Available: {name} {business} {percent} {code} {expiry}</span>
        </label>
        <div class="notice" id="tplPreview"></div>
        <button class="btn btn-gold" style="margin-top:14px">Create campaign</button>
      </form>
    </div>
    <div class="card"><h2>Your campaigns</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>Campaign</th><th class="num">To</th><th class="num">Sent</th><th class="num hide-sm">Delivered</th><th class="num hide-sm">Read</th><th class="num">Failed</th><th class="num">Used</th><th></th></tr></thead>
        <tbody id="camRows"></tbody>
      </table></div>
      <div id="camMsg" hidden></div>
    </div>`;
  const f = $('#campForm');
  const sync = () => {
    const seg = f.segment.value;
    $$('[data-seg]', f).forEach(x => x.hidden = !x.dataset.seg.split(' ').includes(seg));
    $('#segLabel').textContent = seg === 'regulars' ? 'At least this many visits' : seg === 'inactive' ? 'No visit in the last (days)' : 'Joined in the last (days)';
    $$('[data-kind]', f).forEach(x => x.hidden = f.kind.value !== x.dataset.kind);
    const sample = { name: 'Rahul', business: biz().name, percent: f.offer_percent.value, code: 'K7XM2PQ', expiry: fmtDay(Date.now() + f.offer_valid_days.value * 864e5) };
    $('#tplPreview').innerHTML = 'Preview: ' + lines(f.params.value).map((p, i) => `<b>{{${i + 1}}}</b> = ${esc(p.replace(/\{(\w+)\}/g, (_, k) => sample[k] ?? `{${k}}`))}`).join(' · ');
  };
  let pTimer;
  const countAudience = () => { clearTimeout(pTimer); pTimer = setTimeout(async () => {
    try {
      const r = await api('campaigns/preview', { method: 'POST', body: { business_id: state.bizId, segment: f.segment.value, segment_value: f.segment_value.value, tag: f.tag.value } });
      notice($('#audience'), `${nf(r.count)} customer${r.count === 1 ? '' : 's'} will get this. Unsubscribed and no-consent customers are always left out.`, r.count ? 'good' : 'warn');
      const limit = biz().daily_limit;
      if (r.count > limit) $('#audience').textContent += ` Your limit is ${nf(limit)} a day, so it will take ${Math.ceil(r.count / limit)} days.`;
    } catch (e) { notice($('#audience'), e.message); }
  }, 300); };
  const SEG_DEFAULT = { inactive: 30, regulars: 3, new: 30 };
  let lastSeg = f.segment.value;
  f.oninput = e => {
    if (f.segment.value !== lastSeg) { lastSeg = f.segment.value; if (SEG_DEFAULT[lastSeg]) f.segment_value.value = SEG_DEFAULT[lastSeg]; }
    sync();
    if (['segment', 'segment_value', 'tag'].includes(e.target.name)) countAudience();
  };
  f.onchange = f.oninput;
  sync(); countAudience();
  f.onsubmit = e => {
    e.preventDefault();
    busy($('button', f), async () => {
      const body = Object.fromEntries(new FormData(f));
      body.business_id = state.bizId; body.params = lines(body.params);
      const r = await api('campaigns', { method: 'POST', body });
      toast(`Campaign created for ${r.queued} customers. Press Send to start.`);
      f.name.value = '';
      loadCampaigns();
    });
  };
  $('#camRows').onclick = e => { const b = e.target.closest('[data-send]'); if (b) runCampaign(b); };
  await loadCampaigns();
};

async function loadCampaigns() {
  const rows = await api(withBiz('campaigns'));
  $('#camRows').innerHTML = rows.map(c => `<tr>
      <td><b>${esc(c.name)}</b><div class="muted small">${c.kind === 'offer' ? c.offer_percent + '% off · ' : 'message · '}${fmtDate(c.created_at)}</div></td>
      <td class="num">${nf(c.total)}</td><td class="num">${nf(c.sent)}</td><td class="num hide-sm">${nf(c.delivered)}</td><td class="num hide-sm">${nf(c.read)}</td>
      <td class="num">${c.failed ? `<span class="badge bad">${nf(c.failed)}</span>` : 0}</td>
      <td class="num">${c.kind === 'offer' ? `<b>${nf(c.redeemed)}</b>` : '–'}</td>
      <td>${c.queued ? `<button class="btn btn-gold btn-sm" data-send="${c.id}">Send ${nf(c.queued)}</button>` : '<span class="badge good">done</span>'}</td></tr>`).join('')
    || '<tr><td colspan="8" class="empty">No campaigns yet.</td></tr>';
}

async function runCampaign(btn) {
  if (!confirm('Start sending this campaign on WhatsApp now?')) return;
  btn.disabled = true;
  let sent = 0, failed = 0, lastError = null;
  try {
    while (true) {
      const r = await api('send-batch', { method: 'POST', body: { campaign_id: btn.dataset.send } });
      sent += r.sent; failed += r.failed; lastError = r.last_error || lastError;
      btn.textContent = `Sending… ${sent} sent, ${r.remaining} left`;
      if (r.limited) { notice($('#camMsg'), `Daily limit reached after ${sent} messages. Press Send again tomorrow to continue.`, 'warn'); break; }
      if (!r.remaining || (!r.sent && !r.failed)) {
        notice($('#camMsg'), `Finished: ${sent} sent, ${failed} failed.` + (lastError ? ` Last error: ${lastError}` : ''), failed ? 'bad' : 'good');
        break;
      }
    }
  } catch (e) { notice($('#camMsg'), e.message); }
  loadCampaigns();
}

// ---------- coupons ----------

RENDER.coupons = async el => {
  el.innerHTML = head('Coupons', 'Redeem a code at the counter, or look up a guest\'s unused coupons.') + `
    <div class="grid g2">
      <div class="card"><h2>Redeem a code</h2>
        <form id="rdForm"><label>Coupon code <input name="code" class="input-big code" required autocomplete="off" autocapitalize="characters" maxlength="12" style="text-transform:uppercase"></label>
          <div class="row" style="margin-top:12px"><button type="button" class="btn btn-ghost" id="rdCheck">Check only</button><button class="btn btn-gold">Redeem</button></div></form>
        <div id="rdOut"></div>
      </div>
      <div class="card"><h2>Find by phone</h2>
        <form id="lkForm"><label>Mobile number <input name="phone" inputmode="tel" required autocomplete="off"></label><button class="btn btn-ghost" style="margin-top:12px">Find coupons</button></form>
        <div id="lkOut"></div>
      </div>
    </div>`;
  const f = $('#rdForm');
  const show = (k, msg) => {
    const status = msg ? `<span class="badge good">${msg}</span>` : k.redeemed_at ? `<span class="badge bad">already used ${fmtWhen(k.redeemed_at)}</span>`
      : new Date(k.expires_at) < new Date() ? `<span class="badge bad">expired ${fmtDate(k.expires_at)}</span>` : `<span class="badge gold">valid till ${fmtDate(k.expires_at)}</span>`;
    $('#rdOut').innerHTML = `<div class="result"><div class="bigcode">${k.percent}% off ${k.reason === 'birthday' ? '🎂' : ''}</div><div>${esc(k.customers?.name || 'Guest')} <span class="muted">${phoneFmt(k.customers?.phone)}</span></div><div style="margin-top:8px">${status}</div></div>`;
  };
  $('#rdCheck').onclick = e => busy(e.target, async () => show(await api(withBiz('coupons?code=' + encodeURIComponent(f.code.value.trim())))));
  f.onsubmit = e => {
    e.preventDefault();
    busy($('button.btn-gold', f), async () => {
      try { show(await api('coupons', { method: 'POST', body: { business_id: state.bizId, code: f.code.value } }), 'Redeemed ✓'); f.code.value = ''; }
      catch (err) { $('#rdOut').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`; }
    });
  };
  $('#lkForm').onsubmit = e => {
    e.preventDefault();
    busy($('button', e.target), async () => {
      try {
        const r = await api(withBiz('coupons?phone=' + encodeURIComponent(e.target.phone.value)));
        $('#lkOut').innerHTML = `<div class="result"><div class="who">${esc(r.customer.name || 'Guest')}</div>${r.coupons.map(k => `<div class="coupon-row"><div><span class="code">${esc(k.code)}</span> · ${k.percent}% ${k.reason === 'birthday' ? '🎂' : ''}<div class="muted small">till ${fmtDate(k.expires_at)}</div></div><button class="btn btn-gold btn-sm" data-code="${esc(k.code)}">Redeem</button></div>`).join('') || '<div class="muted small" style="margin-top:6px">No unused coupons.</div>'}</div>`;
        $$('[data-code]', $('#lkOut')).forEach(b => b.onclick = () => busy(b, async () => {
          await api('coupons', { method: 'POST', body: { business_id: state.bizId, code: b.dataset.code } });
          b.replaceWith(Object.assign(document.createElement('span'), { className: 'badge good', textContent: 'Redeemed ✓' }));
        }));
      } catch (err) { $('#lkOut').innerHTML = `<div class="notice bad">${esc(err.message)}</div>`; }
    });
  };
  f.code.focus();
};

// ---------- reviews ----------

RENDER.reviews = async el => {
  let filter = '';
  el.innerHTML = head('Reviews & feedback', 'What guests said after their visit. Low ratings come to you privately.') + `
    <div class="stats" id="rvStats"></div>
    <div class="card"><div class="card-head"><h2>Ratings</h2><div class="seg" style="margin:0"><button class="on" data-f="">All</button><button data-f="low">1–3 stars</button></div></div><div id="rvList"></div></div>`;
  const load = async () => {
    const [list, s] = await Promise.all([api(withBiz('reviews' + (filter ? '?filter=low' : ''))), api(withBiz('stats'))]);
    $('#rvStats').innerHTML = tile('Average rating', s.avg_rating ? s.avg_rating + ' ★' : '–', `${nf(s.ratings)} ratings`) +
      tile('Response rate', s.review_requests ? Math.round(s.ratings / s.review_requests * 100) + '%' : '–', `${nf(s.review_requests)} requests sent`) +
      tile('Complaints', nf(s.complaints_30d), 'last 30 days');
    $('#rvList').innerHTML = list.map(r => `<div style="padding:12px 0;border-bottom:1px solid var(--line)">
        <div class="row" style="justify-content:space-between"><div><span class="stars">${stars(r.rating)}</span> <b>${esc(r.customers?.name || 'Guest')}</b> <span class="muted small">${phoneFmt(r.customers?.phone)}</span></div><span class="muted small">${fmtWhen(r.rated_at)}</span></div>
        ${r.feedback ? `<div style="margin-top:4px">${esc(r.feedback)}</div>` : ''}
        ${r.rating <= 3 && r.customers?.phone ? `<a class="linkbtn small" href="https://wa.me/${esc(r.customers.phone)}" target="_blank" rel="noopener">Reply on WhatsApp →</a>` : ''}
      </div>`).join('') || '<div class="empty">No ratings yet.</div>';
  };
  $$('.seg button', el).forEach(b => b.onclick = () => { filter = b.dataset.f; $$('.seg button', el).forEach(x => x.classList.toggle('on', x === b)); load(); });
  await load();
};

// ---------- QR sign-up ----------

RENDER.qr = async el => {
  const b = biz();
  if (!b.wa_number) {
    el.innerHTML = head('QR sign-up') + `<div class="card empty">Add your shop's WhatsApp number in Settings to get a sign-up QR code.<br><br><button class="btn btn-gold" id="toSet">Open settings</button></div>`;
    $('#toSet').onclick = () => go('settings');
    return;
  }
  const r = await api(withBiz('qr'));
  el.innerHTML = head('QR sign-up', 'Print this for your tables and counter. Guests scan it and join on WhatsApp in one tap.', `<button class="btn btn-gold" id="printBtn">${icon('print')} Print poster</button>`) + `
    <div class="card"><div class="qr-box">
      <div class="qr-img">${r.svg}</div>
      <div><h2>How it works</h2>
        <p class="muted">1. The guest scans the code, and WhatsApp opens with <b>JOIN</b> already typed.<br>2. They tap send, and they're added to your customers with their consent recorded.<br>3. They get your welcome message right away.</p>
        <p class="small muted">Link: <a href="${esc(r.link)}" target="_blank" rel="noopener">${esc(r.link)}</a></p>
        <div class="notice warn">Sign-ups only arrive once your WhatsApp webhook is connected in Meta.</div>
      </div>
    </div></div>
    <div class="poster"><h1>${esc(r.name)}</h1><p>Get offers and birthday treats on WhatsApp</p><div class="qr-img">${r.svg}</div><p><b>Scan → tap Send → done</b></p><p style="font-size:10pt;color:#6b7280">Reply STOP anytime to unsubscribe</p></div>`;
  $('#printBtn').onclick = () => window.print();
};

// ---------- settings ----------

RENDER.settings = async el => {
  const admin = state.role === 'admin';
  const b = biz();
  const creating = !b;
  el.innerHTML = head(creating ? 'Add a restaurant' : 'Settings', creating ? 'Create the account your restaurant owner will log in with.' : b.name,
    admin && !creating ? `<button class="btn btn-ghost" id="newBizBtn">${icon('plus')} New restaurant</button>` : '') + `
    ${admin ? `<div class="card" id="newBizCard" ${creating ? '' : 'hidden'}><h2>New restaurant</h2>
      <form id="newBizForm"><div class="row">
        <label>Restaurant name <input name="name" required maxlength="80"></label>
        <label>Login ID <input name="slug" required pattern="[a-z0-9][a-z0-9\\-]{2,39}" placeholder="cafe-mocha" autocapitalize="none"></label>
        <label>Owner password <input name="password" type="text" minlength="8" autocomplete="off" placeholder="min 8 characters"></label>
      </div><button class="btn btn-gold" style="margin-top:14px">Create restaurant</button></form></div>` : ''}
    ${creating ? '' : `
    <form id="setForm">
      <div class="card"><h2>Restaurant</h2>
        <div class="row"><label>Name <input name="name" required maxlength="80" value="${esc(b.name)}"></label>
          <label>Google review link <input name="google_review_url" type="url" placeholder="https://g.page/r/.../review" value="${esc(b.google_review_url || '')}"><span class="hint">Google Business Profile → Ask for reviews → copy link</span></label></div>
        ${admin ? `<div class="row" style="margin-top:12px"><label>Login ID <input name="slug" value="${esc(b.slug || '')}" pattern="[a-z0-9][a-z0-9\\-]{2,39}"></label>
          <label>Daily WhatsApp limit <input name="daily_limit" type="number" min="1" value="${b.daily_limit}"><span class="hint">250 until Meta verifies the business</span></label>
          <label class="check" style="flex:0 1 auto;align-self:center"><input type="checkbox" name="active" ${b.active ? 'checked' : ''}> Account active</label></div>` : ''}
      </div>
      <div class="card"><h2>WhatsApp connection</h2>
        <div class="row"><label>Phone number ID <input name="wa_phone_number_id" inputmode="numeric" value="${esc(b.wa_phone_number_id || '')}"><span class="hint">Meta → WhatsApp → API Setup</span></label>
          <label>Permanent access token <input name="wa_token" type="password" autocomplete="off" placeholder="${b.has_token ? 'saved, leave blank to keep' : 'paste System User token'}"></label>
          <label>Shop WhatsApp number <input name="wa_number" inputmode="tel" value="${esc(b.wa_number || '')}" placeholder="98765 43210"><span class="hint">Used for the QR sign-up</span></label></div>
        <label style="margin-top:12px">Welcome message (sent when someone joins via QR) <textarea name="welcome_message" maxlength="500">${esc(b.welcome_message || '')}</textarea><span class="hint">Use {business} and {name}</span></label>
      </div>
      <div class="card"><h2>Review request after a visit</h2>
        <div class="row"><label>Template name <input name="review_template" value="${esc(b.review_template || '')}" placeholder="visit_review"></label>
          <label>Language <input name="review_lang" value="${esc(b.review_lang)}"></label></div>
        <label style="margin-top:12px">Variables, one per line <textarea name="review_params">${esc((b.review_params || []).join('\n'))}</textarea><span class="hint">Available: {name} {business} {link}</span></label>
      </div>
      <div class="card"><h2>Loyalty</h2>
        <div class="row"><label>Reward every N visits <input name="loyalty_every" type="number" min="0" max="100" value="${b.loyalty_every || ''}" placeholder="5"><span class="hint">Leave empty to turn off</span></label>
          <label>Reward <input name="loyalty_reward" maxlength="100" value="${esc(b.loyalty_reward || '')}" placeholder="Free dessert"></label></div>
      </div>
      <div class="card"><h2>Birthday treat (sent automatically at 9 AM)</h2>
        <div class="row"><label>Template name <input name="birthday_template" value="${esc(b.birthday_template || '')}" placeholder="birthday_offer"><span class="hint">Leave empty to turn off</span></label>
          <label>Language <input name="birthday_lang" value="${esc(b.birthday_lang)}"></label>
          <label>Discount % <input name="birthday_percent" type="number" min="1" max="100" value="${b.birthday_percent}"></label></div>
        <label style="margin-top:12px">Variables, one per line <textarea name="birthday_params">${esc((b.birthday_params || []).join('\n'))}</textarea><span class="hint">Available: {name} {business} {percent} {code} {expiry}. The coupon is valid for 7 days.</span></label>
      </div>
      <button class="btn btn-gold" id="saveSet">Save settings</button>
    </form>
    <div class="card" style="margin-top:18px"><h2>${admin ? 'Owner password' : 'Change password'}</h2>
      <form id="pwForm"><div class="row">
        ${admin ? '' : '<label>Current password <input name="current_password" type="password" autocomplete="current-password" required></label>'}
        <label>New password <input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
      </div><span class="hint">${admin ? (b.has_password ? 'Setting a new password logs the owner out of every device.' : 'No password set yet, so the owner can\'t log in.') : 'This logs you out on every other device.'}</span>
      <div><button class="btn btn-ghost" style="margin-top:12px">${admin ? 'Set owner password' : 'Change password'}</button></div></form>
    </div>
    ${admin ? `<div class="card"><h2>Danger zone</h2><p class="muted small">Deleting removes the restaurant and all its customers, campaigns, coupons and reviews for good.</p><button class="btn btn-danger" id="delBiz">Delete restaurant</button></div>` : ''}`}`;

  if (admin) {
    $('#newBizBtn') && ($('#newBizBtn').onclick = () => { $('#newBizCard').hidden = false; $('#newBizCard input').focus(); });
    $('#newBizForm').onsubmit = e => {
      e.preventDefault();
      busy($('button', e.target), async () => {
        const body = Object.fromEntries(new FormData(e.target));
        const r = await api('businesses', { method: 'POST', body });
        state.bizId = r.id; store.set('crm.biz', r.id);
        await loadBusinesses();
        toast('Restaurant created');
        go('settings');
      });
    };
  }
  if (creating) return;

  $('#setForm').onsubmit = e => {
    e.preventDefault();
    const f = e.target;
    busy($('#saveSet'), async () => {
      const body = Object.fromEntries(new FormData(f));
      body.review_params = lines(body.review_params);
      body.birthday_params = lines(body.birthday_params);
      if (admin) body.active = f.active.checked;
      if (!body.wa_token) delete body.wa_token;
      await api('businesses?id=' + state.bizId, { method: 'PATCH', body });
      await loadBusinesses(state.bizId);
      toast('Settings saved');
      go('settings');
    });
  };
  $('#pwForm').onsubmit = e => {
    e.preventDefault();
    busy($('button', e.target), async () => {
      const r = await api('businesses/password', { method: 'POST', body: { business_id: state.bizId, password: e.target.password.value, current_password: e.target.current_password?.value } });
      if (r.token) { state.token = r.token; store.set('crm.token', r.token); }
      e.target.reset();
      await loadBusinesses(state.bizId);
      toast('Password updated');
    });
  };
  $('#delBiz') && ($('#delBiz').onclick = e => {
    const typed = prompt(`Type DELETE to permanently delete ${b.name} and all its data.`);
    if (typed !== 'DELETE') return;
    busy(e.target, async () => {
      await api(`businesses?id=${state.bizId}&confirm=DELETE`, { method: 'DELETE' });
      state.bizId = null;
      await loadBusinesses();
      toast('Restaurant deleted');
      go(state.businesses.length ? 'overview' : 'settings');
    });
  });
};

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

// Back/forward buttons and typed #/page links.
window.addEventListener('hashchange', () => {
  const page = location.hash.replace('#/', '');
  if (state.token && page !== state.page && PAGES.some(p => p[0] === page)) go(page, true);
});

boot();
