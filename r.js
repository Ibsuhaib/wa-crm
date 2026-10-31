// Public review page: /r/<token>. Every guest can reach Google; Google forbids
// showing the review link only to happy customers ("review gating").
const $ = s => document.querySelector(s);
const t = new URLSearchParams(location.search).get('t') || location.pathname.split('/').pop();
let rating = 0;

const show = id => ['ask', 'happy', 'sad', 'done', 'already'].forEach(x => ($('#' + x).hidden = x !== id));
function setGoogle(url) {
  for (const id of ['#googleBtn', '#googleLink', '#googleAgain']) {
    const a = $(id);
    if (url) { a.href = url; a.hidden = false; } else a.hidden = true;
  }
}
async function post(body) {
  const r = await fetch('/api/review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t, ...body }) });
  const j = await r.json().catch(() => ({}));
  if (r.status === 409) { show('already'); throw new Error(j.error); }
  if (!r.ok) throw new Error(j.error || 'Something went wrong');
  return j;
}
const paint = n => [...$('#stars').children].forEach((b, i) => b.classList.toggle('on', i < n));

for (let i = 1; i <= 5; i++) {
  const b = document.createElement('button');
  b.type = 'button'; b.textContent = '★'; b.setAttribute('role', 'radio'); b.setAttribute('aria-label', `${i} star${i > 1 ? 's' : ''}`);
  b.onmouseenter = () => paint(i);
  b.onmouseleave = () => paint(rating);
  b.onclick = async () => {
    if (rating) return;
    rating = i; paint(i);
    try {
      const r = await post({ rating: i });
      setGoogle(r.google);
      show(i >= 4 ? 'happy' : 'sad');
    } catch (e) { if (!$('#already').hidden) return; rating = 0; paint(0); alert(e.message); }
  };
  $('#stars').append(b);
}

$('#addNote').onclick = () => show('sad');
$('#sendFb').onclick = async e => {
  const text = $('#fb').value.trim();
  if (!text) return $('#fb').focus();
  e.target.disabled = true;
  try { await post({ feedback: text }); show('done'); } catch (err) { if ($('#already').hidden) alert(err.message); e.target.disabled = false; }
};

fetch('/api/review?t=' + encodeURIComponent(t)).then(r => r.json()).then(r => {
  if (r.error) { $('#title').textContent = r.error; $('#stars').hidden = true; $('#ask p').hidden = true; return; }
  document.title = `Rate ${r.business}`;
  $('#title').textContent = `How was your visit to ${r.business}?`;
  setGoogle(r.google);
  if (r.rated) show('already');
});
