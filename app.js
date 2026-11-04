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
  messages: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  birthdays: '<path d="M20 21v-8a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8M4 16s1.5-1 4-1 4 2 4 2 1.5-2 4-2 4 1 4 1M2 21h20M12 11V7M12 3v.01"/>',
  templates: '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  reviews: '<path d="m12 2 3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/>',
  qr: '<rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><path d="M14 14h3v3h-3zM20 14v.01M14 20h.01M17 20h4v-3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  print: '<path d="M6 9V2h12v7M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/>',
};
const icon = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${I[k]}</svg>`;

// Restaurants get the three simple screens; everything else is for the platform admin.
const PAGES = [
  ['overview', 'Overview', true], ['checkin', 'Check-in'], ['customers', 'Customers'], ['messages', 'Messages'], ['birthdays', 'Birthdays'],
  ['templates', 'Templates', true], ['reviews', 'Reviews', true], ['qr', 'QR sign-up', true], ['settings', 'Settings', true],
];
const pages = () => PAGES.filter(p => state.role === 'admin' || (!p[2] && (p[0] !== 'birthdays' || biz()?.birthday_access)));

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
  $('#nav').innerHTML = pages().map(([id, label]) => `<button data-page="${id}">${icon(id)}<span>${label}</span></button>`).join('');
  $('#nav').onclick = e => { const b = e.target.closest('button'); if (b) go(b.dataset.page); };
  const hash = location.hash.replace('#/', '');
  const home = state.role === 'admin' ? (state.businesses.length ? 'overview' : 'settings') : 'checkin';
  go(pages().some(p => p[0] === hash) ? hash : home);
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
    [!!b.wa_waba_id, 'Add the WhatsApp account ID'],
    [!!b.checkin_template_id, 'Choose the check-in message'],
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
      ${tile('Messages sent', nf(s.messages_30d), 'last 30 days')}
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
  const canSend = b.checkin_template_id && b.has_token && b.wa_phone_number_id;
  el.innerHTML = head('Check in a guest', 'Type the mobile number at billing. New guests are added automatically.') + `
    <div class="grid g2">
      <div class="card">
        <form id="ciForm">
          <label>Mobile number <input name="phone" class="input-big" inputmode="tel" autocomplete="off" required placeholder="98765 43210"></label>
          <div id="ciMatch"></div>
          <div class="row" style="margin-top:12px">
            <label>Name (optional) <input name="name" autocomplete="off"></label>
            <label>Bill amount ₹ (optional) <input name="amount" type="number" min="0" step="any" inputmode="decimal"></label>
            <label>Birthday (optional) <input name="birthday" type="date"></label>
          </div>
          <label class="check" style="margin-top:14px"><input type="checkbox" name="consent" checked> Guest agreed to get WhatsApp messages</label>
          <label class="check" style="margin-top:8px"><input type="checkbox" name="send_review" ${canSend ? 'checked' : 'disabled'}> <span>Send thank-you message on WhatsApp ${canSend ? '' : '<span class="muted small">(not set up yet)</span>'}</span></label>
          <button class="btn btn-gold btn-block" style="margin-top:16px">Check in</button>
        </form>
        <div id="ciResult"></div>
      </div>
      <div class="card"><h2>How it works</h2>
        <p class="muted small">1. Check in every guest at billing. Returning guests are found automatically as you type.<br>
        2. The guest gets one thank-you message on WhatsApp. If they already got it in the last ${b.repeat_days} days, it isn't sent again.<br>
        3. ${b.loyalty_every ? `Every <b>${b.loyalty_every}th</b> visit earns <b>${esc(b.loyalty_reward || 'a reward')}</b>, and you'll see a gold banner here.` : 'Their visits and spend add up on the Customers screen.'}</p>
      </div>
    </div>`;
  const f = $('#ciForm');
  f.phone.focus();

  // Look the guest up in the customer list while the cashier types the number or name.
  let timer, seq = 0, found = [];
  const clearMatch = () => { seq++; found = []; $('#ciMatch').innerHTML = ''; };
  const pick = c => {
    f.phone.value = c.phone.replace(/^91(?=\d{10}$)/, '');
    f.name.value = c.name || '';
    f.birthday.value = c.birthday || '';
    $('#ciMatch').innerHTML = `<div class="notice good">Returning guest: <b>${esc(c.name || 'No name')}</b> · ${c.visits} visit${c.visits === 1 ? '' : 's'} · last ${fmtDate(c.last_visit_at)}</div>`;
    found = [];
  };
  const lookup = term => {
    clearTimeout(timer);
    const mine = ++seq;
    if (term.replace(/\s/g, '').length < 3) { $('#ciMatch').innerHTML = ''; return; }
    timer = setTimeout(async () => {
      const r = await api(withBiz('customers?q=' + encodeURIComponent(term))).catch(() => null);
      if (!r || mine !== seq) return;
      found = r.rows.slice(0, 5);
      const digits = f.phone.value.replace(/\D/g, '').slice(-10);
      const exact = digits.length === 10 && found.find(c => c.phone.endsWith(digits));
      if (exact) return pick(exact);
      $('#ciMatch').innerHTML = found.map((c, i) => `<button type="button" class="sugg" data-i="${i}"><b>${esc(c.name || 'No name')}</b> <span class="muted">${phoneFmt(c.phone)} · ${c.visits} visit${c.visits === 1 ? '' : 's'}</span></button>`).join('');
    }, 250);
  };
  f.phone.oninput = () => lookup(f.phone.value);
  f.name.oninput = () => { if (!f.phone.value.trim()) lookup(f.name.value); };
  $('#ciMatch').onclick = e => { const x = e.target.closest('[data-i]'); if (x) pick(found[x.dataset.i]); };

  f.onsubmit = e => {
    e.preventDefault();
    busy($('button.btn', f), async () => {
      const r = await api('visits', { method: 'POST', body: {
        business_id: state.bizId, phone: f.phone.value, name: f.name.value, amount: f.amount.value || null,
        birthday: f.birthday.value || null, consent: f.consent.checked, send_review: f.send_review.checked,
      } });
      const c = r.customer;
      const rv = r.review;
      $('#ciResult').innerHTML = `<div class="result">
        <div class="who">${esc(c.name || 'Guest')} <span class="muted small">${phoneFmt(c.phone)}</span></div>
        <div style="margin-top:6px">${c.new ? '<span class="badge gold">New guest</span>' : `<span class="badge good">Visit #${c.visits}</span>`}
          <span class="badge">Total spent ${inr(c.total_spent)}</span>
          ${r.next_reward_in ? `<span class="badge">${r.next_reward_in} more visit${r.next_reward_in > 1 ? 's' : ''} to reward</span>` : ''}</div>
        ${r.reward ? `<div class="reward">🎁 Reward earned: ${esc(r.reward)}</div>` : ''}
        <div class="small" style="margin-top:10px">WhatsApp message: <span class="badge wrap ${rv === 'sent' ? 'good' : rv.startsWith('failed') ? 'bad' : ''}">${esc(rv)}</span></div>
      </div>`;
      f.phone.value = f.name.value = f.amount.value = f.birthday.value = '';
      clearMatch();
      f.phone.focus();
    });
  };
};

// ---------- customers ----------

const cust = { q: '', group: '', from: '', to: '', page: 0, rows: [], total: 0, sel: new Set(), all: false };
const custFilters = () => ({
  q: cust.q, group: cust.group,
  from: cust.from ? new Date(cust.from).toISOString() : '', to: cust.to ? new Date(cust.to).toISOString() : '',
});

RENDER.customers = async el => {
  const list = (await api(withBiz('templates'))).rows.filter(t => t.sendable !== false && t.purpose !== 'birthday');
  cust.sel.clear(); cust.all = false;
  el.innerHTML = head('Customers', 'Everyone who has checked in or joined. Tick customers to send them a message.',
    `<button class="btn btn-ghost" id="exportBtn">${icon('download')} Export CSV</button><button class="btn btn-gold" id="addBtn">${icon('plus')} Add / import</button>`) + `
    <div class="card" id="addCard" hidden>
      <h2>Add or import customers</h2>
      <p class="muted small">One per line: <code>phone, name, tags, birthday</code>. Use the tag <code>vip</code> for VIPs, and write the birthday as YYYY-MM-DD. You can also upload a CSV.</p>
      <textarea id="impBox" placeholder="9876543210, Rahul Sharma, vip, 1994-08-21&#10;9123456780, Priya"></textarea>
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
        <label>Show <select id="cgroup">
          <option value="">Everyone</option><option value="vip">VIP</option><option value="common">Common</option><option value="opted_out">Unsubscribed</option>
        </select></label>
        <label>Last visit from <input id="cfrom" type="datetime-local" value="${esc(cust.from)}"></label>
        <label>Last visit to <input id="cto" type="datetime-local" value="${esc(cust.to)}"></label>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th class="tick"><input type="checkbox" id="cpage" aria-label="Select everyone on this page"></th><th>Name</th><th>Phone</th><th class="num">Visits</th><th class="num hide-sm">Spent</th><th class="hide-sm">Last visit</th><th class="hide-sm">Group</th></tr></thead>
        <tbody id="crows"><tr><td colspan="7" class="empty">Loading…</td></tr></tbody>
      </table></div>
      <div class="pager"><span class="muted small" id="ccount"></span><div class="row"><button class="btn btn-ghost btn-sm" id="cprev">Previous</button><button class="btn btn-ghost btn-sm" id="cnext">Next</button></div></div>
      <div id="sendMsg" hidden></div>
    </div>
    <div class="sendbar" id="sendBar" hidden>
      <div class="sendbar-top">
        <b id="selCount"></b>
        <button class="linkbtn small" id="selAll"></button>
        <button class="linkbtn small" id="selClear">Clear</button>
      </div>
      ${list.length ? `<div class="row">
        <label>Message <select id="sendTpl">${list.map(t => `<option value="${t.id}">${esc(t.title)}</option>`).join('')}</select></label>
        <button class="btn btn-gold" id="sendBtn" style="align-self:flex-end">Send</button>
      </div><div class="muted small" id="sendPreview" style="margin-top:8px"></div>`
        : '<div class="muted small">No approved messages yet. They appear here once hungriAR sets them up.</div>'}
    </div>`;
  $('#cgroup').value = cust.group;
  let timer;
  const reload = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { cust.page = 0; cust.sel.clear(); cust.all = false; loadCustomers(); }, 250);
  };
  $('#cq').oninput = e => { cust.q = e.target.value; reload(); };
  $('#cgroup').onchange = e => { cust.group = e.target.value; reload(); };
  $('#cfrom').onchange = e => { cust.from = e.target.value; reload(); };
  $('#cto').onchange = e => { cust.to = e.target.value; reload(); };
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
  $('#crows').onclick = e => {
    if (e.target.closest('.tick')) return;
    const tr = e.target.closest('tr[data-id]');
    if (tr) openCustomer(tr.dataset.id);
  };
  $('#crows').onchange = e => {
    const id = e.target.dataset.sel;
    if (!id) return;
    if (cust.all) {  // leaving "all matching": keep what's ticked on this page
      cust.all = false;
      cust.rows.forEach(c => cust.sel.add(c.id));
    }
    e.target.checked ? cust.sel.add(id) : cust.sel.delete(id);
    syncSelection();
  };
  $('#cpage').onchange = e => {
    cust.all = false;
    cust.rows.forEach(c => e.target.checked ? cust.sel.add(c.id) : cust.sel.delete(c.id));
    syncSelection();
  };
  $('#selAll').onclick = () => { cust.all = true; syncSelection(); };
  $('#selClear').onclick = () => { cust.all = false; cust.sel.clear(); syncSelection(); };
  if (list.length) {
    const show = () => { $('#sendPreview').textContent = list.find(t => t.id === $('#sendTpl').value)?.text || ''; };
    $('#sendTpl').onchange = show;
    show();
    $('#sendBtn').onclick = e => busy(e.target, () => sendSelected(list));
  }
  await loadCustomers();
};

function syncSelection() {
  const count = cust.all ? cust.total : cust.sel.size;
  $$('[data-sel]').forEach(x => { x.checked = cust.all || cust.sel.has(x.dataset.sel); });
  $('#cpage').checked = cust.rows.length > 0 && (cust.all || cust.rows.every(c => cust.sel.has(c.id)));
  $('#sendBar').hidden = !count;
  $('#selCount').textContent = `${nf(count)} selected`;
  $('#selAll').hidden = cust.all || cust.total <= cust.sel.size;
  $('#selAll').textContent = `Select all ${nf(cust.total)}`;
}

async function sendSelected(list) {
  const t = list.find(x => x.id === $('#sendTpl').value);
  const count = cust.all ? cust.total : cust.sel.size;
  if (!confirm(`Send "${t.title}" to ${nf(count)} customer${count === 1 ? '' : 's'} on WhatsApp now?`)) return;
  const r = await api('send', { method: 'POST', body: {
    business_id: state.bizId, template_id: t.id,
    ...(cust.all ? { all: true, filters: custFilters() } : { ids: [...cust.sel] }),
  } });
  const skipped = r.skipped ? ` ${nf(r.skipped)} skipped: already got this message recently, unsubscribed, or no consent.` : '';
  if (!r.queued) return notice($('#sendMsg'), 'Nothing to send.' + skipped, 'warn');
  const done = await runSend(r.id, (sent, left) => notice($('#sendMsg'), `Sending… ${sent} sent, ${left} left`, 'warn'));
  notice($('#sendMsg'), done.text + skipped, done.kind);
  cust.all = false; cust.sel.clear(); syncSelection();
}

// Keep calling send-batch until the batch is finished or the daily limit stops it.
async function runSend(id, progress) {
  let sent = 0, failed = 0, lastError = null;
  while (true) {
    const r = await api('send-batch', { method: 'POST', body: { campaign_id: id } });
    sent += r.sent; failed += r.failed; lastError = r.last_error || lastError;
    progress(sent, r.remaining);
    if (r.limited) return { kind: 'warn', text: `Daily limit reached after ${sent} messages. Continue tomorrow from the Messages screen.` };
    if (!r.remaining || (!r.sent && !r.failed)) {
      return { kind: failed ? 'bad' : 'good', text: `Finished: ${sent} sent, ${failed} failed.` + (lastError ? ` Last error: ${lastError}` : '') };
    }
  }
}

async function loadCustomers() {
  const qs = new URLSearchParams({ ...custFilters(), page: cust.page });
  const r = await api(withBiz('customers?' + qs));
  cust.rows = r.rows; cust.total = r.total;
  const filtered = cust.q || cust.group || cust.from || cust.to;
  $('#crows').innerHTML = r.rows.map(c => `<tr class="click" data-id="${c.id}">
      <td class="tick"><input type="checkbox" data-sel="${c.id}" aria-label="Select ${esc(c.name || c.phone)}"></td>
      <td><b>${esc(c.name) || '<span class="muted">–</span>'}</b>${c.opted_out_at ? ' <span class="badge bad">unsubscribed</span>' : ''}${!c.consent_at ? ' <span class="badge warn">no consent</span>' : ''}</td>
      <td class="nowrap">${phoneFmt(c.phone)}</td><td class="num">${c.visits}</td><td class="num hide-sm">${inr(c.total_spent)}</td>
      <td class="hide-sm">${fmtWhen(c.last_visit_at)}</td><td class="hide-sm">${c.tags.includes('vip') ? '<span class="badge gold">VIP</span>' : '<span class="badge">Common</span>'}</td></tr>`).join('')
    || `<tr><td colspan="7" class="empty">${filtered ? 'No customers match.' : 'No customers yet. Check in a guest or import a list.'}</td></tr>`;
  const from = r.total ? r.page * r.limit + 1 : 0, to = Math.min(r.total, (r.page + 1) * r.limit);
  $('#ccount').textContent = `${from}–${to} of ${nf(r.total)}`;
  $('#cprev').disabled = r.page === 0;
  $('#cnext').disabled = to >= r.total;
  syncSelection();
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
  const r = await api(withBiz('customers?' + new URLSearchParams({ ...custFilters(), all: 1 })));
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
      <label class="check" style="margin-top:12px"><input type="checkbox" name="vip" ${c.tags.includes('vip') ? 'checked' : ''}> VIP customer</label>
      <label>Birthday <input name="birthday" type="date" value="${esc(c.birthday || '')}"></label>
      ${!c.consent_at ? '<label class="check" style="margin-top:12px"><input type="checkbox" name="consent"> Customer agreed to WhatsApp messages</label>' : ''}
      <button class="btn btn-gold" style="margin-top:14px">Save</button>
    </form></div>
    <div class="card"><h2>Ratings</h2>${c.reviews.filter(r => r.rating).map(r => `<div style="padding:6px 0"><span class="stars">${stars(r.rating)}</span> <span class="muted small">${fmtDate(r.rated_at)}</span>${r.feedback ? `<div class="small">${esc(r.feedback)}</div>` : ''}</div>`).join('') || '<div class="muted small">No ratings yet.</div>'}</div>
    <div class="card"><h2>Visit history</h2>${c.visit_list.map(v => `<div class="row" style="justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--line)"><span>${fmtWhen(v.created_at)}</span><span>${v.amount ? inr(v.amount) : '–'}</span></div>`).join('') || '<div class="muted small">No visits yet.</div>'}</div>
    <div class="row">${!c.opted_out_at ? '<button class="btn btn-ghost btn-sm" id="cOpt">Unsubscribe from messages</button>' : ''}<button class="btn btn-danger btn-sm" id="cDel">Delete customer</button></div>
  </aside>`;
  $('.drawer-bg', root).onclick = $('.x', root).onclick = closeDrawer;
  $('#cEdit').onsubmit = e => {
    e.preventDefault();
    const f = e.target;
    busy($('button', f), async () => {
      await api('customers?id=' + c.id, { method: 'PATCH', body: { name: f.name.value, tags: [...c.tags.filter(t => t !== 'vip'), ...(f.vip.checked ? ['vip'] : [])], birthday: f.birthday.value || null, ...(f.consent?.checked ? { consent: true } : {}) } });
      toast('Saved'); closeDrawer(); loadCustomers();
    });
  };
  $('#cOpt') && ($('#cOpt').onclick = e => confirm('Stop all WhatsApp messages to this customer?') && busy(e.target, async () => {
    await api('customers?id=' + c.id, { method: 'PATCH', body: { opted_out: true } }); toast('Unsubscribed'); closeDrawer(); loadCustomers();
  }));
  $('#cDel').onclick = e => confirm('Delete this customer and all their visits and ratings? This cannot be undone.') && busy(e.target, async () => {
    await api('customers?id=' + c.id, { method: 'DELETE' }); toast('Deleted'); closeDrawer(); loadCustomers();
  });
}

// ---------- messages ----------

const STATUS = { sent: 'good', delivered: 'good', read: 'good', failed: 'bad' };

RENDER.messages = async el => {
  const tpl = (await api(withBiz('templates'))).rows.filter(t => t.sendable !== false);
  let page = 0;
  el.innerHTML = head('Messages', 'What goes out on WhatsApp. To change a message, contact hungriAR.') + `
    <div id="pendRow"></div>
    <div class="card"><h2>Your messages</h2>
      ${tpl.map(t => `<div class="tpl"><b>${esc(t.title)}</b><div class="small">${esc(t.text)}</div></div>`).join('') || '<div class="muted small">No approved messages yet.</div>'}
    </div>
    <div class="card"><h2>Sent messages</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Customer</th><th>Message</th><th>Status</th></tr></thead>
        <tbody id="mrows"><tr><td colspan="4" class="empty">Loading…</td></tr></tbody>
      </table></div>
      <div class="pager"><span class="muted small" id="mcount"></span><div class="row"><button class="btn btn-ghost btn-sm" id="mprev">Previous</button><button class="btn btn-ghost btn-sm" id="mnext">Next</button></div></div>
    </div>`;
  const load = async () => {
    const r = await api(withBiz('messages?page=' + page));
    $('#mrows').innerHTML = r.rows.map(m => `<tr>
        <td class="nowrap">${fmtWhen(m.sent_at || m.created_at)}</td>
        <td><b>${esc(m.customers?.name || 'Guest')}</b><div class="muted small nowrap">${phoneFmt(m.customers?.phone)}</div></td>
        <td class="small">${esc(m.preview || m.template_name || '–')}${m.error ? `<div class="muted small">${esc(m.error)}</div>` : ''}</td>
        <td><span class="badge ${STATUS[m.status] || ''}">${esc(m.status)}</span></td></tr>`).join('')
      || '<tr><td colspan="4" class="empty">Nothing sent yet.</td></tr>';
    const from = r.total ? r.page * r.limit + 1 : 0, to = Math.min(r.total, (r.page + 1) * r.limit);
    $('#mcount').textContent = `${from}–${to} of ${nf(r.total)}`;
    $('#mprev').disabled = r.page === 0;
    $('#mnext').disabled = to >= r.total;
    $('#pendRow').innerHTML = r.pending.map(p => `<div class="card card-head"><span><b>${esc(p.name)}</b>: ${nf(p.queued)} still waiting to send</span><button class="btn btn-gold btn-sm" data-go-on="${p.id}">Continue sending</button></div>`).join('');
    $$('[data-go-on]', el).forEach(x => x.onclick = () => busy(x, async () => {
      const done = await runSend(x.dataset.goOn, (sent, left) => { x.textContent = `Sending… ${sent} sent, ${left} left`; });
      toast(done.text, done.kind === 'bad');
      load();
    }));
  };
  $('#mprev').onclick = () => { page = Math.max(0, page - 1); load(); };
  $('#mnext').onclick = () => { page++; load(); };
  await load();
};

// ---------- birthdays ----------

const whenAway = n => n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `In ${n} days`;

RENDER.birthdays = async el => {
  const r = await api(withBiz('birthdays'));
  const admin = state.role === 'admin';
  const due = r.upcoming.filter(c => c.reachable && !c.wished).length;
  const chosen = r.templates.find(t => t.id === r.template_id);
  el.innerHTML = head('Birthdays', 'Wish guests automatically at 9 AM on their birthday.') + `
    ${r.access ? '' : '<div class="notice warn" style="margin:0 0 18px">This restaurant has no Birthday access yet. Turn it on in Settings.</div>'}
    <div class="card">
      <label class="switch"><input type="checkbox" id="bAuto" ${r.auto ? 'checked' : ''} ${r.access ? '' : 'disabled'}><span class="track"></span><span><b>Automatic birthday wishes</b><span class="muted small" style="display:block">${r.auto ? 'On' : 'Off'}. Each wish costs about ₹1.</span></span></label>
      ${r.auto && !chosen ? '<div class="notice bad">The chosen message is no longer approved, so no wishes are going out. Pick another.</div>' : ''}
      ${r.templates.length ? `<label style="margin-top:16px">Birthday message <select id="bTpl" ${r.access ? '' : 'disabled'}><option value="">Choose a message</option>${r.templates.map(t => `<option value="${t.id}" ${t.id === r.template_id ? 'selected' : ''}>${esc(t.title)}</option>`).join('')}</select></label>
        <div class="muted small" id="bPrev" style="margin-top:8px"></div>`
        : `<div class="notice">No approved birthday messages yet. ${admin ? 'Create them on the Templates screen.' : 'hungriAR will add them for you.'}</div>`}
    </div>
    <div class="card"><div class="card-head"><h2>Next 30 days</h2><span class="muted small">${nf(due)} to wish · about ${inr(due * 1.02)}</span></div>
      <div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Guest</th><th>Phone</th><th></th></tr></thead>
        <tbody>${r.upcoming.map(c => `<tr><td class="nowrap"><b>${whenAway(c.days_away)}</b></td><td>${esc(c.name || 'Guest')}</td><td class="nowrap">${phoneFmt(c.phone)}</td>
          <td>${c.wished ? '<span class="badge good">wished</span>' : c.reachable ? '' : '<span class="badge warn">can\'t message</span>'}</td></tr>`).join('')
          || '<tr><td colspan="4" class="empty">No birthdays in the next 30 days. Add birthdays at check-in.</td></tr>'}</tbody>
      </table></div>
    </div>`;
  const save = async body => {
    try { await api('birthdays', { method: 'PATCH', body: { business_id: state.bizId, ...body } }); toast('Saved'); }
    catch (e) { toast(e.message, true); }
    go('birthdays');
  };
  $('#bAuto').onchange = e => save({ auto: e.target.checked });
  if ($('#bTpl')) {
    $('#bPrev').textContent = chosen?.text || '';
    $('#bTpl').onchange = e => save({ template_id: e.target.value || null });
  }
};

// ---------- templates (platform admin) ----------

const CATEGORY = { UTILITY: ['good', 'Utility · about 14 paise'], MARKETING: ['bad', 'Marketing · about ₹1 · blocked'] };
const categoryOf = t => t.purpose === 'birthday' && t.category === 'MARKETING' ? ['gold', 'Marketing · about ₹1'] : CATEGORY[t.category] || ['', t.category];
const TPL_STATUS = { APPROVED: 'good', PENDING: 'warn', REJECTED: 'bad', PAUSED: 'bad', DISABLED: 'bad', DELETED: 'bad' };

RENDER.templates = async el => {
  const b = biz();
  el.innerHTML = head('Templates', `Messages for ${b.name}. Restaurants can see these but can't change them.`,
    `<button class="btn btn-gold" id="tplNew">${icon('plus')} New message</button>`) + `
    ${b.wa_waba_id ? '' : '<div class="notice warn" style="margin:0 0 18px">Add the WhatsApp account ID in Settings before creating messages.</div>'}
    <div class="card" id="tplCard" hidden><h2 id="tplHead">New message</h2>
      <form id="tplForm">
        <div class="row"><label>Title <input name="title" required maxlength="60" placeholder="Thank you + review"></label>
          <label>Type <select name="purpose"><option value="visit">Thank-you (about 14 paise)</option><option value="birthday">Birthday (about ₹1)</option></select></label></div>
        <label style="margin-top:12px">Message <textarea name="text" required maxlength="1000" placeholder="Hi {name}, thanks for visiting {business} today. How did we do? It takes 10 seconds: {link} Thank you!"></textarea>
          <span class="hint">Tap to add: <button type="button" class="linkbtn" data-tok="{name}">{name}</button> · <button type="button" class="linkbtn" data-tok="{business}">{business}</button> · <button type="button" class="linkbtn" data-tok="{link}">{link}</button> (review page). The message can't start or end with one of these.</span></label>
        <div class="notice" id="tplNote"></div>
        <div class="row" style="margin-top:14px"><button class="btn btn-gold" id="tplSave">Send to Meta for approval</button><button type="button" class="btn btn-ghost" id="tplCancel">Cancel</button></div>
      </form>
    </div>
    <div id="tplWarn"></div>
    <div class="card"><div class="card-head"><h2>Messages</h2><span class="muted small">Status comes live from Meta</span></div><div id="tplList"><div class="empty">Loading…</div></div></div>`;
  const f = $('#tplForm');
  let editing = null, rows = [];
  const note = () => {
    $('#tplNote').textContent = f.purpose.value === 'birthday'
      ? 'Goes to Meta as Marketing. End it with "Reply STOP to unsubscribe."'
      : "Keep it about the guest's visit, with no offers or discounts. Otherwise Meta labels it Marketing (about ₹1) and the CRM blocks it.";
  };
  f.purpose.onchange = note;
  const open = t => {
    editing = t;
    f.title.value = t?.title || ''; f.text.value = t?.text || '';
    f.purpose.value = t?.purpose || 'visit'; f.purpose.disabled = !!t;
    note();
    $('#tplHead').textContent = t ? 'Edit message' : 'New message';
    $('#tplCard').hidden = false;
    f.title.focus();
  };
  const load = async () => {
    const r = await api(withBiz('templates?sync=1'));
    rows = r.rows.filter(t => t.status !== 'DELETED');
    $('#tplWarn').innerHTML = r.sync_error ? `<div class="notice bad" style="margin:0 0 18px">Couldn't reach Meta: ${esc(r.sync_error)}</div>` : '';
    $('#tplList').innerHTML = rows.map(t => {
      const [kind, label] = categoryOf(t);
      const unmapped = !t.sendable && t.status === 'APPROVED' && (t.category === 'UTILITY' || t.purpose === 'birthday');
      return `<div class="tpl">
        <div class="card-head" style="margin:0"><b>${esc(t.title)}</b><div>
          ${t.id === b.checkin_template_id ? '<span class="badge gold">Check-in message</span>' : ''}
          ${t.purpose === 'birthday' ? '<span class="badge">Birthday</span>' : ''}
          <span class="badge ${TPL_STATUS[t.status] || ''}">${esc(t.status.toLowerCase())}</span><span class="badge ${kind}">${esc(label)}</span></div></div>
        <div class="small">${esc(t.text)}</div>
        ${t.reason ? `<div class="small" style="color:var(--bad)">Meta says: ${esc(t.reason)}</div>` : ''}
        ${unmapped ? '<div class="small" style="color:var(--warn)">Made outside the CRM. Tap Edit and write it with {name}, {business} or {link} so it can be sent.</div>' : ''}
        <div class="row" style="margin-top:8px"><button class="btn btn-ghost btn-sm" data-edit="${t.id}">Edit</button><button class="btn btn-danger btn-sm" data-del="${t.id}">Delete</button></div>
      </div>`;
    }).join('') || '<div class="empty">No messages yet.</div>';
  };
  $('#tplNew').onclick = () => open(null);
  $('#tplCancel').onclick = () => { $('#tplCard').hidden = true; };
  $$('[data-tok]', f).forEach(x => x.onclick = () => {
    const a = f.text, at = a.selectionStart ?? a.value.length;
    a.value = a.value.slice(0, at) + x.dataset.tok + a.value.slice(a.selectionEnd ?? at);
    a.focus();
  });
  f.onsubmit = e => {
    e.preventDefault();
    if (editing && f.text.value.trim() !== editing.text && !confirm('This goes back to Meta for approval, and it can\'t be sent until it is approved. Continue?')) return;
    busy($('#tplSave'), async () => {
      const body = { title: f.title.value, text: f.text.value };
      if (editing) await api('templates?id=' + editing.id, { method: 'PATCH', body });
      else await api('templates', { method: 'POST', body: { ...body, purpose: f.purpose.value, business_id: state.bizId } });
      $('#tplCard').hidden = true;
      toast(editing ? 'Saved' : 'Sent to Meta for approval');
      await load();
    });
  };
  $('#tplList').onclick = e => {
    const ed = e.target.closest('[data-edit]'), del = e.target.closest('[data-del]');
    if (ed) open(rows.find(t => t.id === ed.dataset.edit));
    if (del && confirm('Delete this message here and in Meta? This cannot be undone.')) busy(del, async () => {
      await api('templates?id=' + del.dataset.del, { method: 'DELETE' });
      await loadBusinesses(state.bizId);
      toast('Deleted');
      go('templates');
    });
  };
  await load();
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
    <div class="poster"><h1>${esc(r.name)}</h1><p>Join us on WhatsApp</p><div class="qr-img">${r.svg}</div><p><b>Scan → tap Send → done</b></p><p style="font-size:10pt;color:#6b7280">Reply STOP anytime to unsubscribe</p></div>`;
  $('#printBtn').onclick = () => window.print();
};

// ---------- settings ----------

RENDER.settings = async el => {
  const b = biz();
  const creating = !b;
  const tpl = creating ? [] : (await api(withBiz('templates'))).rows.filter(t => t.status !== 'DELETED' && t.purpose !== 'birthday');
  el.innerHTML = head(creating ? 'Add a restaurant' : 'Settings', creating ? 'Create the account your restaurant owner will log in with.' : b.name,
    !creating ? `<button class="btn btn-ghost" id="newBizBtn">${icon('plus')} New restaurant</button>` : '') + `
    <div class="card" id="newBizCard" ${creating ? '' : 'hidden'}><h2>New restaurant</h2>
      <form id="newBizForm"><div class="row">
        <label>Restaurant name <input name="name" required maxlength="80"></label>
        <label>Login ID <input name="slug" required pattern="[a-z0-9][a-z0-9\\-]{2,39}" placeholder="cafe-mocha" autocapitalize="none"></label>
        <label>Owner password <input name="password" type="text" minlength="8" autocomplete="off" placeholder="min 8 characters"></label>
      </div><button class="btn btn-gold" style="margin-top:14px">Create restaurant</button></form></div>
    ${creating ? '' : `
    <form id="setForm">
      <div class="card"><h2>Restaurant</h2>
        <div class="row"><label>Name <input name="name" required maxlength="80" value="${esc(b.name)}"></label>
          <label>Google review link <input name="google_review_url" type="url" placeholder="https://g.page/r/.../review" value="${esc(b.google_review_url || '')}"><span class="hint">Google Business Profile → Ask for reviews → copy link</span></label></div>
        <div class="row" style="margin-top:12px"><label>Login ID <input name="slug" value="${esc(b.slug || '')}" pattern="[a-z0-9][a-z0-9\\-]{2,39}"></label>
          <label>Daily WhatsApp limit <input name="daily_limit" type="number" min="1" value="${b.daily_limit}"><span class="hint">250 until Meta verifies the business</span></label>
          <label class="check" style="flex:0 1 auto;align-self:center"><input type="checkbox" name="active" ${b.active ? 'checked' : ''}> Account active</label></div>
      </div>
      <div class="card"><h2>WhatsApp connection</h2>
        <div class="row"><label>Phone number ID <input name="wa_phone_number_id" inputmode="numeric" value="${esc(b.wa_phone_number_id || '')}"><span class="hint">Meta → WhatsApp → API Setup</span></label>
          <label>WhatsApp account ID <input name="wa_waba_id" inputmode="numeric" value="${esc(b.wa_waba_id || '')}"><span class="hint">Needed to create messages</span></label>
          <label>Permanent access token <input name="wa_token" type="password" autocomplete="off" placeholder="${b.has_token ? 'saved, leave blank to keep' : 'paste System User token'}"></label>
          <label>Shop WhatsApp number <input name="wa_number" inputmode="tel" value="${esc(b.wa_number || '')}" placeholder="98765 43210"><span class="hint">Used for the QR sign-up</span></label></div>
        <label style="margin-top:12px">Welcome message (sent when someone joins via QR) <textarea name="welcome_message" maxlength="500">${esc(b.welcome_message || '')}</textarea><span class="hint">Use {business} and {name}</span></label>
      </div>
      <div class="card"><h2>Messages</h2>
        <div class="row"><label>Message at check-in <select name="checkin_template_id"><option value="">None</option>${tpl.map(t => `<option value="${t.id}" ${t.id === b.checkin_template_id ? 'selected' : ''}>${esc(t.title)}${t.sendable ? '' : ' (not approved yet)'}</option>`).join('')}</select><span class="hint">Create messages on the Templates screen</span></label>
          <label>Same message at most once every (days) <input name="repeat_days" type="number" min="1" max="3650" value="${b.repeat_days}"></label></div>
        <label class="check" style="margin-top:14px"><input type="checkbox" name="birthday_access" ${b.birthday_access ? 'checked' : ''}> <span>Let this restaurant use Birthdays <span class="muted small">(about ₹1 per wish, on their Meta bill)</span></span></label>
      </div>
      <div class="card"><h2>Loyalty</h2>
        <div class="row"><label>Reward every N visits <input name="loyalty_every" type="number" min="0" max="100" value="${b.loyalty_every || ''}" placeholder="5"><span class="hint">Leave empty to turn off</span></label>
          <label>Reward <input name="loyalty_reward" maxlength="100" value="${esc(b.loyalty_reward || '')}" placeholder="Free dessert"></label></div>
      </div>
      <button class="btn btn-gold" id="saveSet">Save settings</button>
    </form>
    <div class="card" style="margin-top:18px"><h2>Owner password</h2>
      <form id="pwForm"><div class="row">
        <label>New password <input name="password" type="password" autocomplete="new-password" minlength="8" required></label>
      </div><span class="hint">${b.has_password ? 'Setting a new password logs the owner out of every device.' : 'No password set yet, so the owner can\'t log in.'}</span>
      <div><button class="btn btn-ghost" style="margin-top:12px">Set owner password</button></div></form>
    </div>
    <div class="card"><h2>Danger zone</h2><p class="muted small">Deleting removes the restaurant and all its customers, messages and reviews for good.</p><button class="btn btn-danger" id="delBiz">Delete restaurant</button></div>`}`;

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
  if (creating) return;

  $('#setForm').onsubmit = e => {
    e.preventDefault();
    const f = e.target;
    busy($('#saveSet'), async () => {
      const body = Object.fromEntries(new FormData(f));
      body.active = f.active.checked;
      body.birthday_access = f.birthday_access.checked;
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
      await api('businesses/password', { method: 'POST', body: { business_id: state.bizId, password: e.target.password.value } });
      e.target.reset();
      await loadBusinesses(state.bizId);
      toast('Password updated');
    });
  };
  $('#delBiz').onclick = e => {
    const typed = prompt(`Type DELETE to permanently delete ${b.name} and all its data.`);
    if (typed !== 'DELETE') return;
    busy(e.target, async () => {
      await api(`businesses?id=${state.bizId}&confirm=DELETE`, { method: 'DELETE' });
      state.bizId = null;
      await loadBusinesses();
      toast('Restaurant deleted');
      go(state.businesses.length ? 'overview' : 'settings');
    });
  };
};

document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

// Back/forward buttons and typed #/page links.
window.addEventListener('hashchange', () => {
  const page = location.hash.replace('#/', '');
  if (state.token && page !== state.page && pages().some(p => p[0] === page)) go(page, true);
});

boot();
