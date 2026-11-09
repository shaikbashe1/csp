'use strict';
// Client router + views. All authorization decisions are enforced again by the API; this only shapes the UI.
const $ = s => document.querySelector(s);
const main = $('#main');
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = d => d ? new Date(d).toLocaleString() : '—';
const fmtDate = d => d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '—';
const ROLE_LABEL = { citizen: 'Citizen', field_worker: 'Field worker', researcher: 'Researcher', admin: 'Admin' };
let me = null, pollTimer = null;

function toast(msg) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); setTimeout(() => t.classList.remove('show'), 2800); }

async function api(method, path, body, retried) {
  const res = await fetch(path, {
    method, credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && !retried && !path.startsWith('/api/auth/')) {
    const r = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin', headers: { 'X-Requested-With': 'fetch' } });
    if (r.ok) return api(method, path, body, true);
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) { const e = new Error(data.error || 'Request failed'); e.status = res.status; e.fields = data.fields; e.data = data; throw e; }
  return data;
}
async function loadMe() { try { me = (await api('GET', '/api/auth/me')).user; } catch { me = null; } return me; }

// ---- route table ----
const ANY = 'authenticated', PUBLIC = 'public';
const routes = [
  ['/', PUBLIC, home], ['/login', PUBLIC, loginView], ['/register', PUBLIC, registerView],
  ['/forgot-password', PUBLIC, forgotView], ['/reset-password', PUBLIC, resetView], ['/awareness', PUBLIC, awarenessView],
  ['/dashboard', ANY, dashboardView], ['/profile', ANY, profileView], ['/map', ANY, mapView],
  ['/assessment/healthcare', ['citizen', 'field_worker'], v => assessmentView('healthcare')],
  ['/assessment/antibiotic', ['citizen', 'field_worker'], v => assessmentView('antibiotic')],
  ['/history', ['citizen', 'field_worker'], historyView],
  ['/field', ['field_worker'], fieldView],
  ['/research', ['researcher', 'admin'], researchView], ['/reports', ['researcher', 'admin'], reportsView],
  ['/admin', ['admin'], adminDashView], ['/admin/users', ['admin'], adminUsersView], ['/admin/villages', ['admin'], adminVillagesView],
  ['/admin/facilities', ['admin'], adminFacilitiesView], ['/admin/surveys', ['admin'], adminSurveysView], ['/admin/settings', ['admin'], adminSettingsView],
];
const homeFor = u => (u.role === 'admin' ? '/admin' : u.role === 'researcher' ? '/research' : '/dashboard');

function navigate(path, replace) { history[replace ? 'replaceState' : 'pushState']({}, '', path); render(); }
document.addEventListener('click', e => {
  const a = e.target.closest('a[data-link]');
  if (a && !e.metaKey && !e.ctrlKey) { e.preventDefault(); navigate(a.getAttribute('href')); }
});
window.addEventListener('popstate', render);

async function render() {
  clearInterval(pollTimer);
  await loadMe();
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const route = routes.find(r => r[0] === path);
  renderNav();
  if (!route) return notFound();
  const [, rule, view] = route;
  if (rule !== PUBLIC && !me) return navigate('/login', true);   // unauthenticated -> /login
  if (Array.isArray(rule) && !rule.includes(me.role)) return forbidden();
  if (me && (path === '/login' || path === '/register')) return navigate(homeFor(me), true);
  try { await view(); } catch (e) { main.innerHTML = `<div class="alert error">${esc(e.message)}</div>`; }
  main.focus({ preventScroll: true });
}

function renderNav() {
  const p = location.pathname;
  const L = (href, label) => `<a data-link href="${href}" ${p === href ? 'aria-current="page"' : ''}>${label}</a>`;
  let links = '';
  if (me) {
    links += L('/dashboard', 'Dashboard');
    if (['citizen', 'field_worker'].includes(me.role)) links += L('/assessment/healthcare', 'Healthcare') + L('/assessment/antibiotic', 'Antibiotic') + L('/history', 'History');
    if (me.role === 'field_worker') links += L('/field', 'My villages');
    links += L('/map', 'Facilities') + L('/awareness', 'Awareness');
    if (['researcher', 'admin'].includes(me.role)) links += L('/research', 'Research') + L('/reports', 'Reports');
    if (me.role === 'admin') links += L('/admin', 'Admin') + L('/admin/users', 'Users') + L('/admin/villages', 'Villages') + L('/admin/facilities', 'Facilities') + L('/admin/surveys', 'Surveys') + L('/admin/settings', 'Settings');
  } else links = L('/awareness', 'Awareness');
  $('#nav').innerHTML = `<a class="brand" data-link href="/">HealthGap</a><nav aria-label="Main">${links}</nav>` + (me
    ? `<span class="who">${esc(me.full_name)} · ${ROLE_LABEL[me.role]}</span>${L('/profile', 'Profile')}<button class="btn secondary sm" id="logout">Sign out</button>`
    : `${L('/login', 'Sign in')}<a class="btn sm" data-link href="/register">Create account</a>`);
  const lo = $('#logout');
  if (lo) lo.onclick = async () => { await api('POST', '/api/auth/logout').catch(() => {}); me = null; navigate('/login'); };
}

const forbidden = () => { main.innerHTML = `<div class="center"><div class="big">403</div><h1>Unauthorized</h1><p class="sub">Your role (${esc(ROLE_LABEL[me?.role])}) cannot open this page.</p><a class="btn" data-link href="/dashboard">Back to dashboard</a></div>`; };
const notFound = () => { main.innerHTML = `<div class="center"><div class="big">404</div><h1>Page not found</h1><a class="btn" data-link href="/">Go home</a></div>`; };

// ---- form helpers ----
function field(id, label, { type = 'text', autocomplete = '', hint = '', value = '', required = true } = {}) {
  return `<div><label for="${id}">${label}${required ? '' : ' (optional)'}</label>
    <input id="${id}" name="${id}" type="${type}" ${autocomplete ? `autocomplete="${autocomplete}"` : ''} value="${esc(value)}" ${required ? 'required' : ''} aria-describedby="${id}-err">
    ${hint ? `<div class="hint">${hint}</div>` : ''}<div class="field-error" id="${id}-err"></div></div>`;
}
function showErrors(form, e) {
  form.querySelectorAll('.field-error').forEach(n => (n.textContent = ''));
  form.querySelectorAll('[aria-invalid]').forEach(n => n.removeAttribute('aria-invalid'));
  for (const [k, msg] of Object.entries(e.fields || {})) {
    const err = form.querySelector(`#${k}-err`), inp = form.querySelector(`#${k}`);
    if (err) err.textContent = msg; if (inp) inp.setAttribute('aria-invalid', 'true');
  }
  const box = form.querySelector('.form-error'); if (box) { box.textContent = e.message; box.hidden = false; }
}
function bindForm(form, handler) {
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    const btn = form.querySelector('button[type=submit]'); const label = btn.textContent;
    btn.disabled = true; btn.textContent = 'Working…';
    const box = form.querySelector('.form-error'); if (box) box.hidden = true;
    try { await handler(Object.fromEntries(new FormData(form))); }
    catch (e) { showErrors(form, e); }
    finally { btn.disabled = false; btn.textContent = label; }
  });
  // blur-first validation: clear a field's error as soon as the user edits it
  form.addEventListener('input', e => { const err = form.querySelector(`#${e.target.id}-err`); if (err) err.textContent = ''; e.target.removeAttribute('aria-invalid'); });
}

// ---- public views ----
function home() {
  main.innerHTML = `<h1>Rural healthcare &amp; antibiotic awareness</h1><p class="sub">Measure healthcare access gaps and antibiotic-use risk for your village.</p>
  <div class="grid"><div class="card"><h2>Citizens</h2><p>Take assessments and track your results.</p><a class="btn" data-link href="/register">Create account</a></div>
  <div class="card"><h2>Learn</h2><p>Why finishing antibiotic courses matters.</p><a class="btn secondary" data-link href="/awareness">Awareness center</a></div></div>`;
}

function loginView() {
  main.innerHTML = `<div class="auth-wrap card"><h1>Sign in</h1><p class="sub">Use the email and password you registered with.</p>
  <form id="f" novalidate><div class="alert error form-error" role="alert" hidden></div>
  ${field('email', 'Email', { type: 'email', autocomplete: 'username' })}${field('password', 'Password', { type: 'password', autocomplete: 'current-password' })}
  <div class="form-actions"><button class="btn" type="submit">Sign in</button></div></form>
  <div class="links"><a data-link href="/forgot-password">Forgot password?</a><a data-link href="/register">Create account</a></div></div>`;
  bindForm($('#f'), async d => { const r = await api('POST', '/api/auth/login', d); navigate(r.redirect); });
}

function registerView() {
  main.innerHTML = `<div class="auth-wrap auth-wide card"><h1>Create your account</h1><p class="sub">Public accounts are created as citizens. Field worker, researcher and admin accounts are created by an administrator.</p>
  <form id="f" novalidate><div class="alert error form-error" role="alert" hidden></div>
  ${field('full_name', 'Full name', { autocomplete: 'name' })}
  <div class="row">${field('email', 'Email', { type: 'email', autocomplete: 'email' })}${field('phone', 'Phone number', { type: 'tel', autocomplete: 'tel', required: false })}</div>
  <div class="row">${field('password', 'Password', { type: 'password', autocomplete: 'new-password', hint: '8+ characters with upper, lower, digit and symbol' })}${field('confirm_password', 'Confirm password', { type: 'password', autocomplete: 'new-password' })}</div>
  <div class="row">${field('state', 'State', { autocomplete: 'address-level1' })}${field('district', 'District')}</div>
  ${field('village', 'Village')}
  <div><label for="role">User role</label><select id="role" name="role" disabled><option value="citizen">Citizen</option></select><div class="hint">Other roles are assigned by an administrator.</div></div>
  <div class="form-actions"><button class="btn" type="submit">Create account</button></div></form>
  <div class="links"><a data-link href="/login">Already have an account? Sign in</a></div></div>`;
  bindForm($('#f'), async d => { delete d.role; const r = await api('POST', '/api/auth/register', d); navigate(r.redirect); });
}

function forgotView() {
  main.innerHTML = `<div class="auth-wrap card"><h1>Reset your password</h1><p class="sub">Enter your email to get a reset link.</p>
  <form id="f" novalidate><div class="alert error form-error" role="alert" hidden></div>${field('email', 'Email', { type: 'email', autocomplete: 'username' })}
  <div id="out"></div><div class="form-actions"><button class="btn" type="submit">Send reset link</button></div></form><div class="links"><a data-link href="/login">Back to sign in</a></div></div>`;
  bindForm($('#f'), async d => {
    const r = await api('POST', '/api/auth/forgot-password', d);
    $('#out').innerHTML = `<div class="alert ok">${esc(r.message)}</div>` + (r.dev_only_reset_token
      ? `<div class="alert dev"><strong>DEVELOPMENT ONLY</strong> — no email service is configured, so the reset link is shown here:<br><a data-link href="/reset-password?token=${encodeURIComponent(r.dev_only_reset_token)}">Open reset page</a></div>` : '');
  });
}

function resetView() {
  const token = new URLSearchParams(location.search).get('token') || '';
  main.innerHTML = `<div class="auth-wrap card"><h1>Choose a new password</h1>
  <form id="f" novalidate><div class="alert error form-error" role="alert" hidden></div><input type="hidden" id="token" name="token" value="${esc(token)}">
  ${field('new_password', 'New password', { type: 'password', autocomplete: 'new-password' })}${field('confirm_new_password', 'Confirm new password', { type: 'password', autocomplete: 'new-password' })}
  <div class="form-actions"><button class="btn" type="submit">Update password</button></div></form></div>`;
  bindForm($('#f'), async d => { await api('POST', '/api/auth/reset-password', d); toast('Password updated. Please sign in.'); navigate('/login'); });
}

function awarenessView() {
  const items = [['Finish the course', 'Stopping early when you feel better can leave resistant bacteria behind.'], ['Never share antibiotics', 'A medicine prescribed for one person and illness may be wrong for another.'], ['Colds and flu are viral', 'Antibiotics do not work on viruses. Rest, fluids and a health worker’s advice do.'], ['Do not keep leftovers', 'Return or dispose of unused tablets rather than saving them.'], ['Ask a qualified provider', 'Buy antibiotics only with a prescription from a doctor or trained health worker.']];
  main.innerHTML = `<h1>Awareness center</h1><p class="sub">Simple habits that keep antibiotics working for your family and village.</p><div class="grid">${items.map(i => `<div class="card"><h2>${i[0]}</h2><p>${i[1]}</p></div>`).join('')}</div>`;
}

// ---- authenticated views ----
async function dashboardView() {
  const d = await api('GET', '/api/dashboard');
  const emoji = '👋';
  const canAssess = ['citizen', 'field_worker'].includes(me.role);
  main.innerHTML = `<h1>Welcome, ${esc(d.user.name.split(' ')[0])} ${emoji}</h1>
  <p class="sub">Role: ${esc(ROLE_LABEL[d.user.role])} · Village: ${esc(d.user.village || '—')} · District: ${esc(d.user.district)}</p>
  ${canAssess ? `<div class="grid">
    <div class="card"><h2>Healthcare Assessment</h2><span class="badge ${d.healthcare.status}">${d.healthcare.status}</span><p class="hint">Last taken: ${fmt(d.healthcare.last_taken)}</p><a class="btn sm" data-link href="/assessment/healthcare">${d.healthcare.total ? 'Retake' : 'Start'}</a></div>
    <div class="card"><h2>Antibiotic Assessment</h2><span class="badge ${d.antibiotic.status}">${d.antibiotic.status}</span><p class="hint">Last taken: ${fmt(d.antibiotic.last_taken)}</p><a class="btn sm" data-link href="/assessment/antibiotic">${d.antibiotic.total ? 'Retake' : 'Start'}</a></div>
    <div class="card"><h2>Healthcare Gap Score</h2>${d.healthcare.gap_score == null ? '<p class="hint">Complete the healthcare assessment to see your score.</p>' : `<div class="score">${d.healthcare.gap_score} <span class="hint">/ 100</span></div><p class="hint">Higher means a larger gap in access.</p>`}</div>
    <div class="card"><h2>Antibiotic Risk</h2>${d.antibiotic.risk_level ? `<div class="score">${d.antibiotic.risk_level}</div><p class="hint">Score ${d.antibiotic.risk_score} / 100</p>` : '<p class="hint">Complete the antibiotic assessment to see your risk.</p>'}</div></div>`
    : `<div class="card"><p>Use the menu to open your tools.</p></div>`}
  ${d.assigned_villages ? `<h2>Assigned villages</h2><div class="card">${d.assigned_villages.length ? d.assigned_villages.map(v => `<span class="badge">${esc(v.name)}, ${esc(v.district)}</span> `).join('') : '<p class="hint">No villages assigned yet. Ask an administrator.</p>'}</div>` : ''}`;
}

async function assessmentView(kind) {
  const { [kind]: qs } = await api('GET', '/api/assessments/questions');
  const title = kind === 'healthcare' ? 'Healthcare assessment' : 'Antibiotic assessment';
  let villageSel = '';
  if (me.role === 'field_worker') {
    const { villages } = await api('GET', '/api/field/villages');
    villageSel = `<div><label for="village_id">Village this assessment is for</label><select id="village_id" name="village_id">${villages.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select></div>`;
  }
  main.innerHTML = `<div class="card auth-wide"><h1>${title}</h1><p class="sub">Answer every question. Your score is calculated securely on the server.</p>
  <form id="f" novalidate><div class="alert error form-error" role="alert" hidden></div>${villageSel}
  ${qs.map((q, i) => `<fieldset class="q"><legend>${i + 1}. ${esc(q.text)}</legend>${q.options.map(o => `<label class="opt"><input type="radio" name="${q.id}" value="${o.v}" required> ${esc(o.label)}</label>`).join('')}</fieldset>`).join('')}
  <div class="form-actions"><button class="btn" type="submit">Save assessment</button></div></form><div id="res"></div></div>`;
  $('#f').addEventListener('submit', async ev => {
    ev.preventDefault();
    const f = ev.target, box = f.querySelector('.form-error'); box.hidden = true;
    const answers = {};
    for (const q of qs) { const c = f.querySelector(`input[name=${q.id}]:checked`); if (!c) { box.textContent = 'Please answer every question.'; box.hidden = false; return; } answers[q.id] = Number(c.value); }
    const btn = f.querySelector('button[type=submit]'); btn.disabled = true;
    try {
      const body = { answers }; if (f.village_id) body.village_id = Number(f.village_id.value);
      const r = (await api('POST', `/api/assessments/${kind}`, body)).assessment;
      f.hidden = true;
      $('#res').innerHTML = `<div class="alert ok">Saved.</div><div class="score">${kind === 'healthcare' ? r.gap_score + ' / 100' : r.risk_level}</div><p class="hint">${kind === 'healthcare' ? 'Healthcare gap score — higher means a larger gap.' : 'Antibiotic risk level (score ' + r.risk_score + ' / 100).'}</p><a class="btn" data-link href="/dashboard">Back to dashboard</a>`;
    } catch (e) { box.textContent = e.message; box.hidden = false; btn.disabled = false; }
  });
}

async function historyView() {
  const d = await api('GET', '/api/assessments/mine');
  const tbl = (head, rows) => rows.length ? `<div class="table-wrap"><table><thead><tr>${head.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table></div>` : '<div class="card"><p class="hint">Nothing here yet.</p></div>';
  main.innerHTML = `<h1>My assessment history</h1><h2>Healthcare</h2>${tbl(['Date', 'Gap score'], d.healthcare.map(h => `<tr><td>${fmt(h.created_at)}</td><td>${h.gap_score} / 100</td></tr>`))}
  <h2>Antibiotic</h2>${tbl(['Date', 'Risk', 'Score'], d.antibiotic.map(a => `<tr><td>${fmt(a.created_at)}</td><td><span class="badge ${a.risk_level}">${a.risk_level}</span></td><td>${a.risk_score} / 100</td></tr>`))}`;
}

async function mapView() {
  const { facilities } = await api('GET', '/api/facilities');
  main.innerHTML = `<h1>Healthcare facilities</h1><p class="sub">Facilities added by administrators.</p>` + (facilities.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>Location</th><th>Phone</th><th>Map</th></tr></thead><tbody>${facilities.map(f => `<tr><td>${esc(f.name)}</td><td>${esc(f.type.replace('_', ' '))}</td><td>${esc(f.village ? f.village + ', ' : '')}${esc(f.district)}</td><td>${esc(f.phone || '—')}</td><td>${f.latitude != null ? `<a target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${f.latitude}&mlon=${f.longitude}#map=15/${f.latitude}/${f.longitude}">View</a>` : '—'}</td></tr>`).join('')}</tbody></table></div>` : '<div class="card"><p>No facilities have been added yet.</p></div>');
}

async function profileView() {
  main.innerHTML = `<h1>My profile</h1><div class="grid">
  <div class="card"><h2>Account</h2><dl class="kv"><dt>Name</dt><dd>${esc(me.full_name)}</dd><dt>Email</dt><dd>${esc(me.email)}</dd><dt>Phone</dt><dd>${esc(me.phone || '—')}</dd><dt>Village</dt><dd>${esc(me.village || '—')}</dd><dt>District</dt><dd>${esc(me.district)}</dd><dt>Role</dt><dd>${esc(ROLE_LABEL[me.role])}</dd><dt>Status</dt><dd><span class="badge ${me.status}">${me.status}</span></dd><dt>Member since</dt><dd>${fmtDate(me.created_at)}</dd><dt>Last login</dt><dd>${fmt(me.last_login)}</dd></dl></div>
  <div class="card"><h2>Edit details</h2><form id="pf" novalidate><div class="alert error form-error" role="alert" hidden></div>
  ${field('full_name', 'Full name', { value: me.full_name })}${field('phone', 'Phone', { type: 'tel', value: me.phone || '', required: false })}${field('state', 'State', { value: me.state })}${field('district', 'District', { value: me.district })}${field('village', 'Village', { value: me.village || '' })}
  <div class="form-actions"><button class="btn" type="submit">Save changes</button></div></form></div>
  <div class="card"><h2>Change password</h2><form id="cf" novalidate><div class="alert error form-error" role="alert" hidden></div>
  ${field('current_password', 'Current password', { type: 'password', autocomplete: 'current-password' })}${field('new_password', 'New password', { type: 'password', autocomplete: 'new-password' })}${field('confirm_new_password', 'Confirm new password', { type: 'password', autocomplete: 'new-password' })}
  <div class="form-actions"><button class="btn" type="submit">Change password</button></div></form></div></div>`;
  bindForm($('#pf'), async d => { await api('PUT', '/api/auth/profile', d); toast('Profile updated'); render(); });
  bindForm($('#cf'), async d => { const r = await api('POST', '/api/auth/change-password', d); toast(r.message); $('#cf').reset(); });
}

async function fieldView() {
  const [{ villages }, { surveys }] = await Promise.all([api('GET', '/api/field/villages'), api('GET', '/api/field/surveys')]);
  main.innerHTML = `<h1>My villages</h1><p class="sub">Aggregate statistics for villages assigned to you.</p>
  ${villages.length ? `<div class="table-wrap"><table><thead><tr><th>Village</th><th>District</th><th>Healthcare</th><th>Avg gap</th><th>Antibiotic</th><th>Surveys</th></tr></thead><tbody>${villages.map(v => `<tr><td>${esc(v.name)}</td><td>${esc(v.district)}</td><td>${v.healthcare_assessments}</td><td>${v.avg_gap_score ?? '—'}</td><td>${v.antibiotic_assessments}</td><td>${v.surveys}</td></tr>`).join('')}</tbody></table></div>` : '<div class="card"><p>No villages assigned yet. An administrator assigns villages to field workers.</p></div>'}
  ${villages.length ? `<h2>Record a community survey</h2><div class="card auth-wide"><form id="sf" novalidate><div class="alert error form-error" role="alert" hidden></div>
  <div><label for="village_id">Village</label><select id="village_id" name="village_id">${villages.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select></div>
  ${field('households', 'Households surveyed', { type: 'number' })}<div><label for="notes">Notes (optional)</label><textarea id="notes" name="notes" rows="3" maxlength="2000"></textarea></div>
  <div class="form-actions"><button class="btn" type="submit">Save survey</button></div></form></div>` : ''}
  <h2>My recent surveys</h2>${surveys.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Village</th><th>Households</th><th>Notes</th></tr></thead><tbody>${surveys.map(s => `<tr><td>${fmt(s.created_at)}</td><td>${esc(s.village)}</td><td>${s.households}</td><td>${esc(s.notes || '')}</td></tr>`).join('')}</tbody></table></div>` : '<div class="card"><p class="hint">None yet.</p></div>'}`;
  const sf = $('#sf'); if (sf) bindForm(sf, async d => { await api('POST', '/api/field/surveys', { village_id: Number(d.village_id), households: Number(d.households), notes: d.notes || undefined }); toast('Survey saved'); render(); });
}

// ---- research ----
function villageTable(s) {
  const cell = v => (v == null ? `<span class="hint">&lt;${s.min_group_size} (suppressed)</span>` : v);
  return `<div class="table-wrap"><table><thead><tr><th>State</th><th>District</th><th>Village</th><th>Healthcare (n)</th><th>Avg gap</th><th>Antibiotic (n)</th><th>Avg risk</th><th>High risk</th></tr></thead><tbody>
  ${s.villages.map(v => `<tr><td>${esc(v.state)}</td><td>${esc(v.district)}</td><td>${esc(v.village)}</td><td>${v.healthcare_n}</td><td>${cell(v.avg_gap_score)}</td><td>${v.antibiotic_n}</td><td>${cell(v.avg_antibiotic_risk)}</td><td>${cell(v.high_risk_n)}</td></tr>`).join('')}</tbody></table></div>`;
}
async function researchView() {
  const s = await api('GET', '/api/research/summary');
  main.innerHTML = `<h1>Research analytics</h1><p class="sub">Aggregate data only. No personal identifiers are shown; averages for groups under ${s.min_group_size} are withheld.</p>
  <div class="grid"><div class="stat"><div class="n">${s.totals.healthcare_assessments}</div><div class="l">Healthcare assessments</div></div><div class="stat"><div class="n">${s.totals.avg_gap_score ?? '—'}</div><div class="l">Average gap score</div></div>
  <div class="stat"><div class="n">${s.totals.antibiotic_assessments}</div><div class="l">Antibiotic assessments</div></div><div class="stat"><div class="n">${s.totals.avg_antibiotic_risk ?? '—'}</div><div class="l">Average antibiotic risk</div></div></div>
  <h2>Risk distribution</h2><div class="card">${riskSvg(s.risk_distribution)}</div><h2>Village-level statistics</h2>${villageTable(s)}
  <div class="form-actions no-print"><a class="btn" href="/api/research/export.csv" download>Download CSV</a><a class="btn secondary" data-link href="/reports">Report / PDF</a></div>`;
}
async function reportsView() {
  const s = await api('GET', '/api/research/summary');
  main.innerHTML = `<h1>Village health report</h1><p class="sub">Generated ${fmt(new Date())}. Aggregate data; small groups (&lt;${s.min_group_size}) suppressed.</p>${villageTable(s)}
  <div class="form-actions no-print"><button class="btn" id="print">Print / Save as PDF</button><a class="btn secondary" href="/api/research/export.csv" download>Download CSV</a></div>`;
  $('#print').onclick = () => window.print();
}

// ---- admin ----
function svgBars(series, labels, colors) {
  const W = 640, H = 160, n = labels.length, gw = W / n, max = Math.max(1, ...series.flat());
  let g = '';
  labels.forEach((l, i) => series.forEach((s, k) => {
    const h = Math.round((s[i] / max) * (H - 24)), bw = gw / (series.length + 1);
    g += `<rect x="${i * gw + bw * (k + .5)}" y="${H - 16 - h}" width="${bw}" height="${h}" fill="${colors[k]}" rx="2"><title>${l}: ${s[i]}</title></rect>`;
  }));
  labels.forEach((l, i) => { if (i % 2 === 0) g += `<text x="${i * gw + gw / 2}" y="${H - 2}" font-size="10" text-anchor="middle" fill="currentColor" opacity=".6">${l.slice(5)}</text>`; });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Assessments per day, last 14 days">${g}</svg>`;
}
function riskSvg(dist) {
  const order = ['Low', 'Moderate', 'High'], m = Object.fromEntries(dist.map(d => [d.level, d.n])), max = Math.max(1, ...order.map(l => m[l] || 0));
  const cols = { Low: 'var(--ok)', Moderate: 'var(--warn)', High: 'var(--danger)' };
  return `<svg viewBox="0 0 300 120" width="100%" role="img" aria-label="Antibiotic risk distribution">${order.map((l, i) => { const h = Math.round(((m[l] || 0) / max) * 80); return `<rect x="${30 + i * 90}" y="${100 - h}" width="60" height="${h}" fill="${cols[l]}" rx="2"/><text x="${60 + i * 90}" y="${96 - h}" font-size="12" text-anchor="middle" fill="currentColor">${m[l] || 0}</text><text x="${60 + i * 90}" y="115" font-size="11" text-anchor="middle" fill="currentColor" opacity=".7">${l}</text>`; }).join('')}</svg>`;
}
async function adminDashView() {
  async function draw() {
    const s = await api('GET', '/api/admin/stats'), t = s.totals;
    const tiles = [['Total Users', t.total_users], ['Active Users', t.active_users], ['Citizens', t.citizens], ['Field Workers', t.field_workers], ['Researchers', t.researchers], ['Villages Surveyed', t.villages_surveyed], ['Healthcare Assessments', t.healthcare_assessments], ['Antibiotic Assessments', t.antibiotic_assessments]];
    const days = s.assessments_by_day;
    main.innerHTML = `<h1>Admin dashboard</h1><p class="sub">Live from the database · refreshes every 15 seconds · updated ${new Date().toLocaleTimeString()}</p>
    <div class="grid">${tiles.map(([l, n]) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`).join('')}</div>
    <div class="grid"><div class="card"><h2>Assessments, last 14 days</h2>${svgBars([days.map(d => d.healthcare), days.map(d => d.antibiotic)], days.map(d => d.day), ['var(--brand)', 'var(--warn)'])}<div class="legend"><span>■ Healthcare</span><span>■ Antibiotic</span></div></div>
    <div class="card"><h2>Antibiotic risk levels</h2>${riskSvg(s.risk_distribution)}</div></div>`;
  }
  await draw();
  pollTimer = setInterval(() => draw().catch(() => {}), 15000);
}

async function adminUsersView() {
  main.innerHTML = `<h1>User management</h1>
  <form id="flt" class="filters" novalidate><div><label for="q">Search name or email</label><input id="q" type="search"></div>
  <div><label for="role">Role</label><select id="role"><option value="">All roles</option>${Object.entries(ROLE_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
  <div><label for="status">Status</label><select id="status"><option value="">All</option><option>active</option><option>inactive</option><option>suspended</option></select></div>
  <button class="btn" type="submit">Apply filters</button></form>
  <div id="list"></div><div id="detail"></div>
  <h2>Create a staff account</h2><div class="card auth-wide"><form id="cf" novalidate><div class="alert error form-error" role="alert" hidden></div>
  ${field('full_name', 'Full name')}<div class="row">${field('email', 'Email', { type: 'email' })}${field('password', 'Temporary password', { type: 'password', autocomplete: 'new-password' })}</div>
  <div class="row">${field('state', 'State')}${field('district', 'District')}</div>${field('village', 'Village')}
  <div><label for="crole">Role</label><select id="crole" name="role">${Object.entries(ROLE_LABEL).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select></div>
  <div class="form-actions"><button class="btn" type="submit">Create account</button></div></form></div>`;
  async function load() {
    const p = new URLSearchParams(); for (const k of ['q', 'role', 'status']) if ($('#' + k).value) p.set(k, $('#' + k).value);
    const { users, total } = await api('GET', '/api/admin/users?' + p);
    $('#list').innerHTML = users.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th>Joined</th><th>Actions</th></tr></thead><tbody>${users.map(u => `<tr><td>${esc(u.full_name)}</td><td>${esc(u.email)}</td>
    <td><select class="rolesel" data-id="${u.id}" aria-label="Role for ${esc(u.full_name)}">${Object.entries(ROLE_LABEL).map(([k, v]) => `<option value="${k}" ${k === u.role ? 'selected' : ''}>${v}</option>`).join('')}</select></td>
    <td><span class="badge ${u.status}">${u.status}</span>${u.locked ? ' <span class="badge suspended">locked</span>' : ''}</td><td>${fmtDate(u.created_at)}</td>
    <td>${u.status === 'active' ? `<button class="btn danger sm" data-act="suspended" data-id="${u.id}">Suspend</button>` : `<button class="btn sm" data-act="active" data-id="${u.id}">Activate</button>`} <button class="btn secondary sm" data-view="${u.id}">View</button></td></tr>`).join('')}</tbody></table></div><p class="hint">${total} user(s)</p>` : '<div class="card"><p>No users match these filters. <button class="btn secondary sm" id="clr">Clear filters</button></p></div>';
    const clr = $('#clr'); if (clr) clr.onclick = () => { $('#flt').reset(); load(); };
  }
  $('#flt').addEventListener('submit', e => { e.preventDefault(); load(); });
  const onAction = async e => {
    const b = e.target.closest('button'); if (!b) return;
    try {
      if (b.dataset.act) { if (b.dataset.act === 'suspended' && !confirm('Suspend this user? They will be signed out immediately.')) return; await api('PATCH', '/api/admin/users/' + b.dataset.id, { status: b.dataset.act }); toast('Status updated'); load(); }
      if (b.dataset.view) {
        const { user, assigned_villages } = await api('GET', '/api/admin/users/' + b.dataset.view);
        $('#detail').innerHTML = `<h2>Account information</h2><div class="card"><dl class="kv"><dt>Name</dt><dd>${esc(user.full_name)}</dd><dt>User ID</dt><dd>${esc(user.id)}</dd><dt>Email</dt><dd>${esc(user.email)}</dd><dt>Phone</dt><dd>${esc(user.phone || '—')}</dd><dt>Location</dt><dd>${esc(user.village || '—')}, ${esc(user.district)}, ${esc(user.state)}</dd><dt>Role</dt><dd>${esc(ROLE_LABEL[user.role])}</dd><dt>Status</dt><dd>${user.status}</dd><dt>Created</dt><dd>${fmt(user.created_at)}</dd><dt>Last login</dt><dd>${fmt(user.last_login)}</dd>${user.role === 'field_worker' ? `<dt>Assigned villages</dt><dd><span id="av">${assigned_villages.map(v => esc(v.name)).join(', ') || 'none'}</span> <button class="btn secondary sm" data-assign="${user.id}">Assign villages…</button></dd>` : ''}</dl></div>`;
        $('#detail').scrollIntoView();
      }
      if (b.dataset.assign) {
        const { villages } = await api('GET', '/api/admin/villages');
        const pick = prompt('Enter village IDs to assign (comma-separated):\n' + villages.map(v => `${v.id} = ${v.name}`).join('\n'));
        if (pick === null) return;
        await api('PUT', `/api/admin/users/${b.dataset.assign}/villages`, { village_ids: pick.split(',').map(s => parseInt(s)).filter(Number.isInteger) }); toast('Villages assigned');
      }
    } catch (err) { toast(err.message); load(); }
  };
  $('#list').addEventListener('click', onAction); $('#detail').addEventListener('click', onAction);
  $('#list').addEventListener('change', async e => {
    if (!e.target.classList.contains('rolesel')) return;
    if (!confirm('Change this user’s role to ' + ROLE_LABEL[e.target.value] + '?')) return load();
    try { await api('PATCH', '/api/admin/users/' + e.target.dataset.id, { role: e.target.value }); toast('Role updated'); } catch (err) { toast(err.message); }
    load();
  });
  bindForm($('#cf'), async d => { await api('POST', '/api/admin/users', d); toast('Account created'); $('#cf').reset(); load(); });
  load();
}

async function adminVillagesView() {
  const { villages } = await api('GET', '/api/admin/villages');
  main.innerHTML = `<h1>Villages</h1><div class="table-wrap"><table><thead><tr><th>ID</th><th>Village</th><th>District</th><th>State</th><th>Residents</th><th>Assessments</th><th></th></tr></thead><tbody>${villages.map(v => `<tr><td>${v.id}</td><td>${esc(v.name)}</td><td>${esc(v.district)}</td><td>${esc(v.state)}</td><td>${v.residents}</td><td>${v.healthcare_assessments}</td><td><button class="btn danger sm" data-del="${v.id}" data-name="${esc(v.name)}">Delete</button></td></tr>`).join('') || '<tr><td colspan="7">No villages yet.</td></tr>'}</tbody></table></div>
  <h2>Add village</h2><div class="card auth-wide"><form id="vf" novalidate><div class="alert error form-error" role="alert" hidden></div>${field('name', 'Village name')}<div class="row">${field('district', 'District')}${field('state', 'State')}</div><div class="form-actions"><button class="btn" type="submit">Add village</button></div></form></div>`;
  bindForm($('#vf'), async d => { await api('POST', '/api/admin/villages', d); toast('Village added'); render(); });
  main.addEventListener('click', async e => { const b = e.target.closest('[data-del]'); if (!b || !confirm(`Delete village "${b.dataset.name}"? Related surveys are removed; assessments keep their data without a village.`)) return; await api('DELETE', '/api/admin/villages/' + b.dataset.del); render(); }, { once: true });
}

async function adminFacilitiesView() {
  const [{ facilities }, { villages }] = await Promise.all([api('GET', '/api/facilities'), api('GET', '/api/admin/villages')]);
  main.innerHTML = `<h1>Healthcare facilities</h1><div class="table-wrap"><table><thead><tr><th>Name</th><th>Type</th><th>District</th><th>Phone</th><th></th></tr></thead><tbody>${facilities.map(f => `<tr><td>${esc(f.name)}</td><td>${esc(f.type)}</td><td>${esc(f.district)}</td><td>${esc(f.phone || '—')}</td><td><button class="btn danger sm" data-del="${f.id}" data-name="${esc(f.name)}">Delete</button></td></tr>`).join('') || '<tr><td colspan="5">No facilities yet.</td></tr>'}</tbody></table></div>
  <h2>Add facility</h2><div class="card auth-wide"><form id="ff" novalidate><div class="alert error form-error" role="alert" hidden></div>${field('name', 'Facility name')}
  <div class="row"><div><label for="type">Type</label><select id="type" name="type">${['phc', 'chc', 'hospital', 'sub_centre', 'pharmacy', 'clinic'].map(t => `<option>${t}</option>`).join('')}</select></div>
  <div><label for="village_id">Village (optional)</label><select id="village_id" name="village_id"><option value="">—</option>${villages.map(v => `<option value="${v.id}">${esc(v.name)}</option>`).join('')}</select></div></div>
  <div class="row">${field('district', 'District')}${field('state', 'State')}</div><div class="row">${field('latitude', 'Latitude', { type: 'number', required: false })}${field('longitude', 'Longitude', { type: 'number', required: false })}</div>${field('phone', 'Phone', { required: false })}
  <div class="form-actions"><button class="btn" type="submit">Add facility</button></div></form></div>`;
  const num = v => (v === '' || v == null ? undefined : Number(v));
  bindForm($('#ff'), async d => { await api('POST', '/api/admin/facilities', { name: d.name, type: d.type, district: d.district, state: d.state, village_id: num(d.village_id), latitude: num(d.latitude), longitude: num(d.longitude), phone: d.phone || undefined }); toast('Facility added'); render(); });
  main.addEventListener('click', async e => { const b = e.target.closest('[data-del]'); if (!b || !confirm(`Delete facility "${b.dataset.name}"?`)) return; await api('DELETE', '/api/admin/facilities/' + b.dataset.del); render(); }, { once: true });
}

async function adminSurveysView() {
  const { surveys } = await api('GET', '/api/admin/surveys');
  main.innerHTML = `<h1>Community surveys</h1>${surveys.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>Village</th><th>Field worker</th><th>Households</th><th>Notes</th><th></th></tr></thead><tbody>${surveys.map(s => `<tr><td>${fmt(s.created_at)}</td><td>${esc(s.village)}</td><td>${esc(s.worker)}</td><td>${s.households}</td><td>${esc(s.notes || '')}</td><td><button class="btn danger sm" data-del="${s.id}">Delete</button></td></tr>`).join('')}</tbody></table></div>` : '<div class="card"><p>No surveys submitted yet.</p></div>'}`;
  main.addEventListener('click', async e => { const b = e.target.closest('[data-del]'); if (!b || !confirm('Delete this survey? This cannot be undone.')) return; await api('DELETE', '/api/admin/surveys/' + b.dataset.del); render(); }, { once: true });
}

async function adminSettingsView() {
  const { settings } = await api('GET', '/api/admin/settings'); const { roles } = await api('GET', '/api/admin/roles');
  main.innerHTML = `<h1>System settings</h1><div class="card auth-wide"><form id="sf"><label class="opt"><input type="checkbox" id="reg" ${settings.public_registration_enabled ? 'checked' : ''}> Allow public citizen registration</label><div class="form-actions"><button class="btn" type="submit">Save settings</button></div></form></div>
  <h2>Roles</h2><div class="table-wrap"><table><thead><tr><th>Role</th><th>Description</th></tr></thead><tbody>${roles.map(r => `<tr><td>${esc(r.name)}</td><td>${esc(r.description)}</td></tr>`).join('')}</tbody></table></div>`;
  $('#sf').addEventListener('submit', async e => { e.preventDefault(); await api('PUT', '/api/admin/settings', { public_registration_enabled: $('#reg').checked }); toast('Settings saved'); });
}

render();
