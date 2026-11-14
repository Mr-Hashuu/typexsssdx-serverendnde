'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { open, newer } = require('./db');
const cfg = require('./config');

const PORT = parseInt(process.env.PORT || cfg.port || '3000', 10); // Render sets PORT itself
const ADMIN_PASSWORD = String(cfg.adminPassword || process.env.ADMIN_PASSWORD || '');
const SECRET = String(cfg.sessionSecret || process.env.SESSION_SECRET || '') || crypto.createHash('sha256').update('typex|' + ADMIN_PASSWORD).digest('hex');
const SESSION_MS = 7 * 864e5;
const db = open();

/* ---------- helpers ---------- */
const buckets = new Map();
function limited(key, max, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || now > b.reset) { b = { n: 0, reset: now + windowMs }; buckets.set(key, b); }
  b.n++;
  return b.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60000).unref();

function ipOf(req) { return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim(); }
function send(res, code, obj, headers) {
  const body = typeof obj === 'string' ? obj : JSON.stringify(obj);
  res.writeHead(code, Object.assign({
    'Content-Type': typeof obj === 'string' ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'
  }, headers || {}));
  res.end(body);
}
function readJson(req, max = 8192) {
  return new Promise((resolve, reject) => {
    let size = 0, over = false; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (over) return;
      if (size > max) { over = true; chunks.length = 0; reject(Object.assign(new Error('Body too large'), { code: 413 })); } else chunks.push(c);
    });
    req.on('end', () => { if (over) return; try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(Object.assign(new Error('Bad JSON'), { code: 400 })); } });
    req.on('error', reject);
  });
}
const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
const okId = s => /^[A-Za-z0-9-]{8,64}$/.test(s);
const okUrl = s => s === '' || /^https?:\/\/[^\s]+$/i.test(s);

/* ---------- admin session ---------- */
function sign(p) { return crypto.createHmac('sha256', SECRET).update(p).digest('base64url'); }
function makeToken() { const exp = String(Date.now() + SESSION_MS); return exp + '.' + sign(exp); }
function validToken(t) {
  if (!t || !ADMIN_PASSWORD) return false;
  const [exp, mac] = String(t).split('.');
  if (!exp || !mac) return false;
  const a = Buffer.from(mac), b = Buffer.from(sign(exp));
  return a.length === b.length && crypto.timingSafeEqual(a, b) && Number(exp) > Date.now();
}
function cookie(req, name) {
  const m = String(req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(name + '='));
  return m ? decodeURIComponent(m.slice(name.length + 1)) : '';
}
function isAdmin(req) { return validToken(cookie(req, 'tx_admin')); }
function passOk(p) {
  const a = crypto.createHash('sha256').update(String(p)).digest();
  const b = crypto.createHash('sha256').update(ADMIN_PASSWORD).digest();
  return ADMIN_PASSWORD.length > 0 && crypto.timingSafeEqual(a, b);
}

/* ---------- update feed ---------- */
let ghCache = { at: 0, repo: '', data: null };
async function githubRelease(repo) {
  if (ghCache.repo === repo && Date.now() - ghCache.at < 300000 && ghCache.data) return ghCache.data;
  const r = await fetch('https://api.github.com/repos/' + repo + '/releases/latest', { headers: { 'User-Agent': 'typex-server', Accept: 'application/vnd.github+json' } });
  if (!r.ok) throw new Error('GitHub answered ' + r.status);
  const o = await r.json();
  const asset = (o.assets || []).find(a => /\.apk$/i.test(a.name || ''));
  const body = String(o.body || '');
  const data = {
    versionName: String(o.tag_name || '').replace(/^[vV]/, ''),
    notes: body.replace(/\[force\]/ig, '').split('\n').filter(l => !l.trim().startsWith('#')).join('\n').trim().slice(0, 700),
    apk: asset ? asset.browser_download_url : '', page: o.html_url || '', force: /\[force\]/i.test(body)
  };
  ghCache = { at: Date.now(), repo, data };
  return data;
}
async function updateFeed() {
  const s = await db.getSetting('update', null) || {};
  const manual = { versionName: s.version || '0.0', notes: s.notes || '', apk: s.apk || '', page: s.page || '', force: !!s.force };
  if (s.mode === 'github' && s.repo) {
    try {
      const g = await githubRelease(s.repo);
      if (g.versionName) return Object.assign(g, { force: g.force || !!s.force });
    } catch (e) { /* fall back to manual values */ }
  }
  return manual;
}


/* ---------- survey ---------- */
const DEFAULT_SURVEY = {
  id: 'default1', title: 'Quick survey',
  questions: [
    { id: 'use', q: 'How often do you use Typex Board?', options: ['Every day', 'A few times a week', 'Rarely', 'Just installed'], multi: false },
    { id: 'fav', q: 'Which features do you like most?', options: ['Sinhala typing', 'Themes', 'Stylish fonts', 'Clipboard', 'Voice typing', 'Templates'], multi: true },
    { id: 'rate', q: 'How would you rate the keyboard?', options: ['1 - Poor', '2 - Fair', '3 - Good', '4 - Very good', '5 - Excellent'], multi: false },
    { id: 'next', q: 'What should we add next?', options: ['More themes', 'Better Sinhala suggestions', 'More templates', 'Faster typing', 'Other'], multi: true }
  ]
};
async function blockInfo(id) {
  if (!okId(id)) return null;
  const d = await db.getDevice(id);
  return d && d.blocked ? { blocked: true, reason: d.reason || '' } : null;
}
async function liveSurvey() { return (await db.getSetting('survey', null)) || DEFAULT_SURVEY; }
function cleanSurvey(b) {
  const title = str(b.title, 60) || 'Quick survey';
  const src = Array.isArray(b.questions) ? b.questions : [];
  if (src.length < 1 || src.length > 10) return { error: 'A survey needs 1 to 10 questions' };
  const questions = [];
  for (let i = 0; i < src.length; i++) {
    const it = src[i] || {};
    const q = str(it.q, 200);
    const options = [...new Set((Array.isArray(it.options) ? it.options : []).map(o => str(o, 60)).filter(Boolean))];
    if (!q) return { error: 'Question ' + (i + 1) + ' is empty' };
    if (options.length < 2 || options.length > 8) return { error: 'Question ' + (i + 1) + ' needs 2 to 8 different answers' };
    questions.push({ id: 'q' + (i + 1), q, options, multi: !!it.multi });
  }
  return { survey: { id: 's' + Date.now().toString(36), title, questions, at: Date.now() } };
}
function cleanAnswers(s, raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = {};
  for (const q of s.questions) {
    const a = raw[q.id];
    const uniq = [...new Set((Array.isArray(a) ? a : []).map(x => String(x)))];
    if (!uniq.length || uniq.some(x => !q.options.includes(x))) return null;
    if (!q.multi && uniq.length !== 1) return null;
    out[q.id] = uniq;
  }
  return out;
}
function tally(s, list) {
  return s.questions.map(q => {
    const c = Object.create(null); q.options.forEach(o => { c[o] = 0; });
    list.forEach(r => ((r.answers && r.answers[q.id]) || []).forEach(o => { if (o in c) c[o]++; }));
    return { id: q.id, q: q.q, multi: q.multi, options: q.options.map(o => ({ o, n: c[o] })) };
  });
}
function csvCell(v) { let t = String(v == null ? '' : v); if (/^[=+\-@\t\r]/.test(t)) t = "'" + t; return '"' + t.replace(/"/g, '""') + '"'; }
function sendCsv(res, name, rows) {
  const body = '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n');
  res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="' + name + '"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}

/* ---------- premium / payments ---------- */
const DEFAULT_PREMIUM = {
  enabled: false,
  payInfo: 'Send the amount to:\nBank: (bank name, branch)\nAccount name: (name)\nAccount number: (number)\neZ Cash: (number)\n\nThen type the reference / transaction ID below.',
  plans: [
    { id: 'p1', name: '1 Month', days: 30, price: 300 },
    { id: 'p2', name: '3 Months', days: 90, price: 750 },
    { id: 'p3', name: '1 Year', days: 365, price: 2500 }
  ]
};
async function premiumCfg() { return Object.assign({}, DEFAULT_PREMIUM, await db.getSetting('premium', null) || {}); }
function cleanPremium(b) {
  const src = Array.isArray(b.plans) ? b.plans : [];
  if (src.length < 1 || src.length > 6) return { error: 'Add 1 to 6 plans' };
  const plans = [];
  for (let i = 0; i < src.length; i++) {
    const it = src[i] || {};
    const name = str(it.name, 30), days = parseInt(it.days, 10), price = Math.round(Number(it.price));
    if (!name) return { error: 'Plan ' + (i + 1) + ' needs a name' };
    if (!(days >= 1 && days <= 3650)) return { error: 'Plan ' + (i + 1) + ': days must be 1 to 3650' };
    if (!(price >= 1 && price <= 1000000)) return { error: 'Plan ' + (i + 1) + ': price must be 1 to 1,000,000' };
    plans.push({ id: 'p' + (i + 1), name, days, price });
  }
  return { cfg: { enabled: !!b.enabled, payInfo: str(b.payInfo, 800), plans } };
}
const refKeyOf = r => String(r).toUpperCase().replace(/[^A-Z0-9]/g, '');
const vipUntil = d => (d && d.premiumUntil) || 0;
function pubPayment(p) { return { id: p.id, plan: p.planName, amount: p.amount, status: p.status, ts: p.ts, note: p.note || '' }; }
async function premiumState(id) {
  const [cfg, d, list] = await Promise.all([premiumCfg(), db.getDevice(id), db.paymentsFor(id, 5)]);
  const until = vipUntil(d);
  return { enabled: !!cfg.enabled, plans: cfg.plans, payInfo: cfg.payInfo, until, active: until > Date.now(), plan: (d && d.premiumPlan) || '', requests: list.map(pubPayment) };
}
async function premiumStats() {
  const [pending, vip, ap] = await Promise.all([db.countPayments('pending'), db.countVip(), db.approvedPayments(5000)]);
  const now = Date.now(), day0 = new Date(now); day0.setUTCHours(0, 0, 0, 0);
  let total = 0, today = 0, d7 = 0, d30 = 0; const daily = {}, byPlan = {};
  ap.forEach(p => {
    const a = p.amount || 0, t = p.decidedAt || p.ts;
    total += a; if (t >= day0.getTime()) today += a; if (now - t < 7 * 864e5) d7 += a; if (now - t < 30 * 864e5) d30 += a;
    const k = new Date(t).toISOString().slice(0, 10); daily[k] = (daily[k] || 0) + a;
    byPlan[p.planName] = (byPlan[p.planName] || 0) + 1;
  });
  const days = [];
  for (let i = 13; i >= 0; i--) { const k = new Date(now - i * 864e5).toISOString().slice(0, 10); days.push({ d: k, n: daily[k] || 0 }); }
  return { pending, vip, approved: ap.length, income: { total, today, d7, d30 }, daily: days, byPlan: Object.entries(byPlan).sort((a, b) => b[1] - a[1]) };
}

/* ---------- routes ---------- */
async function publicApi(req, res, url) {
  const ip = ipOf(req);
  if (limited('pub|' + ip, 240, 60000)) return send(res, 429, { error: 'Slow down' });

  if (req.method === 'GET' && url.pathname === '/api/update') return send(res, 200, await updateFeed());

  if (req.method === 'POST' && url.pathname === '/api/ping') {
    const b = await readJson(req);
    const id = str(b.id, 64);
    if (!okId(id)) return send(res, 400, { error: 'Bad id' });
    await db.upsertDevice(id, { v: str(b.v, 16) || '?', model: str(b.model, 60), sdk: parseInt(b.sdk, 10) || 0 });
    const bi = await blockInfo(id);
    const cfgP = await premiumCfg(), dv = await db.getDevice(id);
    const prem = { premiumOn: !!cfgP.enabled, premiumUntil: vipUntil(dv), premiumPlan: (dv && dv.premiumPlan) || '' };
    return send(res, 200, Object.assign(bi ? { ok: true, blocked: true, reason: bi.reason } : { ok: true, blocked: false }, prem));
  }

  if (req.method === 'GET' && url.pathname === '/api/messages') {
    const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
    const v = str(url.searchParams.get('v'), 16);
    const id = str(url.searchParams.get('id'), 64);
    if (okId(id)) await db.upsertDevice(id, v ? { v } : {});
    const bi = await blockInfo(id);
    if (bi) return send(res, 200, { messages: [], blocked: true, reason: bi.reason });
    const list = (await db.messagesSince(since, 10)).filter(m => !m.before || !v || newer(m.before, v));
    return send(res, 200, { messages: list.map(m => ({ id: m.id, title: m.title, text: m.text, link: m.link, ts: m.ts })) });
  }


  if (req.method === 'GET' && url.pathname === '/api/survey') return send(res, 200, await liveSurvey());

  if (req.method === 'POST' && url.pathname === '/api/survey') {
    if (limited('sv|' + ip, 20, 600000)) return send(res, 429, { error: 'Slow down' });
    const b = await readJson(req);
    const id = str(b.id, 64), sid = str(b.survey, 40);
    if (!okId(id)) return send(res, 400, { error: 'Bad id' });
    if (await blockInfo(id)) return send(res, 403, { error: 'This phone is blocked' });
    const s = await liveSurvey();
    if (sid !== s.id) return send(res, 409, { error: 'This survey is closed' });
    const answers = cleanAnswers(s, b.answers);
    if (!answers) return send(res, 400, { error: 'Please answer every question' });
    await db.upsertResponse({ survey: s.id, device: id, answers, v: str(b.v, 16) || '?', ts: Date.now() });
    return send(res, 200, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/premium') {
    const id = str(url.searchParams.get('id'), 64);
    if (!okId(id)) return send(res, 400, { error: 'Bad id' });
    return send(res, 200, await premiumState(id));
  }

  if (req.method === 'POST' && url.pathname === '/api/premium/request') {
    if (limited('pay|' + ip, 12, 3600000)) return send(res, 429, { error: 'Too many requests. Try again later.' });
    const b = await readJson(req);
    const id = str(b.id, 64), ref = str(b.ref, 40), name = str(b.name, 40), pid = str(b.plan, 8);
    if (!okId(id)) return send(res, 400, { error: 'Bad id' });
    if (await blockInfo(id)) return send(res, 403, { error: 'This phone is blocked' });
    const cfg = await premiumCfg();
    if (!cfg.enabled) return send(res, 409, { error: 'Premium is not open yet' });
    const plan = cfg.plans.find(x => x.id === pid);
    if (!plan) return send(res, 400, { error: 'Choose a plan' });
    const key = refKeyOf(ref);
    if (key.length < 4) return send(res, 400, { error: 'Enter the payment reference / transaction ID' });
    if (await db.countPendingFor(id) >= 3) return send(res, 429, { error: 'You already have 3 requests waiting. Please wait for approval.' });
    if (await db.findRef(key)) return send(res, 409, { error: 'This reference was already used' });
    await db.upsertDevice(id, {});
    const ts = Date.now();
    const p = { id: ts.toString(36) + crypto.randomBytes(3).toString('hex'), device: id, plan: plan.id, planName: plan.name, days: plan.days, amount: plan.price, ref, refKey: key, name, status: 'pending', ts, decidedAt: 0, note: '' };
    await db.insertPayment(p);
    return send(res, 200, { ok: true, request: pubPayment(p) });
  }

  if (req.method === 'POST' && url.pathname === '/api/ack') {
    const b = await readJson(req);
    const id = str(b.id, 64), mid = str(b.msg, 64);
    if (!okId(id) || !mid) return send(res, 400, { error: 'Bad request' });
    const m = await db.getMessage(mid), d = await db.getDevice(id);
    if (d && d.blocked) return send(res, 403, { error: 'This phone is blocked' });
    if (m && d && (d.lastAck || 0) < m.ts) { await db.setLastAck(id, m.ts); await db.incAck(mid); }
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'Not found' });
}

async function adminApi(req, res, url) {
  const ip = ipOf(req);
  if (req.method === 'POST' && url.pathname === '/admin/login') {
    if (limited('login|' + ip, 8, 600000)) return send(res, 429, { error: 'Too many attempts. Try again in a few minutes.' });
    if (!ADMIN_PASSWORD) return send(res, 500, { error: 'adminPassword is empty in config.js' });
    const b = await readJson(req);
    if (!passOk(b.password)) return send(res, 401, { error: 'Wrong password' });
    const secure = String(req.headers['x-forwarded-proto'] || '') === 'https' ? '; Secure' : '';
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'tx_admin=' + makeToken() + '; HttpOnly; SameSite=Strict; Path=/; Max-Age=' + (SESSION_MS / 1000) + secure });
  }
  if (req.method === 'POST' && url.pathname === '/admin/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': 'tx_admin=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
  if (!isAdmin(req)) return send(res, 401, { error: 'Login required' });
  if (req.method !== 'GET' && req.headers.origin) {
    let oh = '';
    try { oh = new URL(req.headers.origin).host; } catch (e) { }
    if (oh !== req.headers.host) return send(res, 403, { error: 'Bad origin' });
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/me') return send(res, 200, { ok: true, db: db.kind });
  if (req.method === 'GET' && url.pathname === '/admin/api/stats') {
    const live = await liveSurvey();
    const [st, msgs, bd, sc, pend, vip] = await Promise.all([db.stats(), db.listMessages(1), db.breakdown(), db.countResponses(live.id), db.countPayments('pending'), db.countVip()]);
    return send(res, 200, Object.assign(st, { latest: msgs[0] || null, db: db.kind, breakdown: bd, surveyAnswers: sc, surveyTitle: live.title, pendingPayments: pend, vip }));
  }
  if (req.method === 'GET' && url.pathname === '/admin/api/devices') return send(res, 200, { devices: await db.listDevices(200, str(url.searchParams.get('q'), 40), url.searchParams.get('blocked') === '1') });
  if (req.method === 'POST' && url.pathname === '/admin/api/devices/block') {
    const b = await readJson(req);
    const id = str(b.id, 64);
    if (!okId(id)) return send(res, 400, { error: 'Bad id' });
    const ok = await db.setBlocked(id, !!b.blocked, str(b.reason, 120));
    return send(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'Phone not found' });
  }
  if (req.method === 'GET' && url.pathname === '/admin/api/devices.csv') {
    const list = await db.listDevices(5000, '');
    const iso = t => t ? new Date(t).toISOString() : '';
    return sendCsv(res, 'typex-phones.csv', [['Phone id', 'Model', 'App version', 'Android API', 'First seen', 'Last seen', 'Blocked', 'Block reason']].concat(list.map(d => [d.id, d.model || '', d.v || '', d.sdk || '', iso(d.first), iso(d.last), d.blocked ? 'yes' : '', d.reason || ''])));
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/admin/api/devices/')) {
    const ok = await db.deleteDevice(decodeURIComponent(url.pathname.split('/').pop()));
    return send(res, ok ? 200 : 404, { ok });
  }
  if (req.method === 'GET' && url.pathname === '/admin/api/messages') return send(res, 200, { messages: await db.listMessages(50) });

  if (req.method === 'POST' && url.pathname === '/admin/api/messages') {
    const b = await readJson(req);
    const title = str(b.title, 80), text = str(b.text, 600), link = str(b.link, 300), before = str(b.before, 16);
    if (!title || !text) return send(res, 400, { error: 'Title and message are required' });
    if (!okUrl(link)) return send(res, 400, { error: 'The link must start with http:// or https://' });
    const ts = Date.now();
    const m = { id: ts.toString(36) + crypto.randomBytes(3).toString('hex'), title, text, link, before, ts, acks: 0 };
    await db.insertMessage(m);
    return send(res, 200, { ok: true, message: m });
  }
  if (req.method === 'DELETE' && url.pathname.startsWith('/admin/api/messages/')) {
    const ok = await db.deleteMessage(decodeURIComponent(url.pathname.split('/').pop()));
    return send(res, ok ? 200 : 404, { ok });
  }


  if (req.method === 'GET' && url.pathname === '/admin/api/survey') {
    const s = await liveSurvey(), list = await db.listResponses(s.id, 5000);
    return send(res, 200, { survey: s, isDefault: s.id === DEFAULT_SURVEY.id, count: list.length, results: tally(s, list) });
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/survey') {
    const c = cleanSurvey(await readJson(req, 32768));
    if (c.error) return send(res, 400, { error: c.error });
    await db.setSetting('survey', c.survey);
    return send(res, 200, { ok: true, survey: c.survey });
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/survey/clear') {
    const s = await liveSurvey();
    return send(res, 200, { ok: true, removed: await db.clearResponses(s.id) });
  }
  if (req.method === 'GET' && url.pathname === '/admin/api/survey.csv') {
    const s = await liveSurvey(), list = await db.listResponses(s.id, 5000);
    const head = ['Phone', 'App version', 'Answered at'].concat(s.questions.map(q => q.q));
    const rows = list.map(r => [String(r.device).slice(0, 8), r.v || '', new Date(r.ts).toISOString()].concat(s.questions.map(q => ((r.answers && r.answers[q.id]) || []).join(' | '))));
    return sendCsv(res, 'typex-survey-' + s.id + '.csv', [head].concat(rows));
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/premium') {
    const [cfg, stats, vips] = await Promise.all([premiumCfg(), premiumStats(), db.listVip(100)]);
    return send(res, 200, { config: cfg, stats, vips });
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/premium/config') {
    const c = cleanPremium(await readJson(req, 16384));
    if (c.error) return send(res, 400, { error: c.error });
    await db.setSetting('premium', c.cfg);
    return send(res, 200, { ok: true, config: c.cfg });
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/premium/grant') {
    const b = await readJson(req);
    const id = str(b.id, 64), days = parseInt(b.days, 10);
    if (!okId(id)) return send(res, 400, { error: 'Bad id' });
    if (!(days >= 0 && days <= 3650)) return send(res, 400, { error: 'Days must be 0 to 3650 (0 removes premium)' });
    const d = await db.getDevice(id);
    if (!d) return send(res, 404, { error: 'Phone not found' });
    const until = days === 0 ? 0 : Math.max(Date.now(), vipUntil(d)) + days * 864e5;
    await db.setPremium(id, until, days === 0 ? '' : 'Gift');
    return send(res, 200, { ok: true, until });
  }
  if (req.method === 'GET' && url.pathname === '/admin/api/payments') {
    const st = str(url.searchParams.get('status'), 10);
    const list = await db.listPayments(['pending', 'approved', 'rejected'].includes(st) ? st : '', 200);
    const devs = {};
    await Promise.all([...new Set(list.map(p => p.device))].map(async id => { const d = await db.getDevice(id); devs[id] = d ? { model: d.model || '', v: d.v || '' } : { model: '', v: '' }; }));
    return send(res, 200, { payments: list.map(p => Object.assign({}, p, { model: devs[p.device].model, v: devs[p.device].v })) });
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/payments/decide') {
    const b = await readJson(req);
    const id = str(b.id, 64), note = str(b.note, 120);
    if (b.action !== 'approve' && b.action !== 'reject') return send(res, 400, { error: 'Bad action' });
    const p0 = await db.getPayment(id);
    if (!p0) return send(res, 404, { error: 'Payment not found' });
    if (p0.status !== 'pending') return send(res, 409, { error: 'Already ' + p0.status });
    if (b.action === 'reject') {
      const p = await db.decidePayment(id, { status: 'rejected', decidedAt: Date.now(), note });
      return send(res, p ? 200 : 409, p ? { ok: true } : { error: 'Already decided' });
    }
    let days = parseInt(b.days, 10); if (!(days >= 1 && days <= 3650)) days = p0.days;
    const p = await db.decidePayment(id, { status: 'approved', decidedAt: Date.now(), note, days });
    if (!p) return send(res, 409, { error: 'Already decided' });
    const d = await db.getDevice(p.device);
    if (!d) await db.upsertDevice(p.device, {});
    const until = Math.max(Date.now(), vipUntil(d)) + days * 864e5;
    await db.setPremium(p.device, until, p.planName);
    return send(res, 200, { ok: true, until });
  }
  if (req.method === 'GET' && url.pathname === '/admin/api/payments.csv') {
    const list = await db.listPayments('', 5000);
    const iso = t => t ? new Date(t).toISOString() : '';
    return sendCsv(res, 'typex-payments.csv', [['Date', 'Status', 'Plan', 'Days', 'Amount (LKR)', 'Reference', 'Payer name', 'Phone id', 'Decided', 'Note']].concat(list.map(p => [iso(p.ts), p.status, p.planName, p.days, p.amount, p.ref, p.name || '', p.device, iso(p.decidedAt), p.note || ''])));
  }

  if (req.method === 'GET' && url.pathname === '/admin/api/update') {
    const s = await db.getSetting('update', null) || { mode: 'manual', version: '', notes: '', apk: '', page: '', force: false, repo: '' };
    return send(res, 200, { setting: s, live: await updateFeed() });
  }
  if (req.method === 'POST' && url.pathname === '/admin/api/update') {
    const b = await readJson(req);
    const s = {
      mode: b.mode === 'github' ? 'github' : 'manual', version: str(b.version, 16).replace(/^[vV]/, ''),
      notes: str(b.notes, 700), apk: str(b.apk, 400), page: str(b.page, 300), force: !!b.force, repo: str(b.repo, 100), at: Date.now()
    };
    if (s.mode === 'github' && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(s.repo)) return send(res, 400, { error: 'GitHub repo must look like owner/name' });
    if (s.mode === 'manual') {
      if (!/^\d+(\.\d+)*$/.test(s.version)) return send(res, 400, { error: 'Version must look like 2.9 or 3.0.1' });
      if (!okUrl(s.apk) || !okUrl(s.page)) return send(res, 400, { error: 'Links must start with http:// or https://' });
      if (!s.apk && !s.page) return send(res, 400, { error: 'Give the APK link (or at least a page link)' });
      if (s.force && !s.apk) return send(res, 400, { error: 'A required update needs the APK link' });
    }
    ghCache = { at: 0, repo: '', data: null };
    await db.setSetting('update', s);
    return send(res, 200, { ok: true, live: await updateFeed() });
  }
  return send(res, 404, { error: 'Not found' });
}

const PAGE = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const LOGO = fs.readFileSync(path.join(__dirname, 'public', 'logo.png'));

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/health') return send(res, 200, { ok: true, db: db.kind });
    if (url.pathname === '/logo.png') { res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' }); return res.end(LOGO); }
    if (url.pathname === '/' || url.pathname === '/admin') return send(res, 200, PAGE, { 'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; frame-ancestors 'none'" });
    if (url.pathname.startsWith('/api/')) return await publicApi(req, res, url);
    if (url.pathname.startsWith('/admin/')) return await adminApi(req, res, url);
    return send(res, 404, { error: 'Not found' });
  } catch (e) {
    send(res, e.code === 413 || e.code === 400 ? e.code : 500, { error: e.code ? e.message : 'Server error' }, e.code === 413 ? { Connection: 'close' } : {});
    if (!e.code) console.error(e);
  }
});

db.init().then(() => {
  server.listen(PORT, () => {
    console.log('Typex server on :' + PORT + ' (' + db.kind + ')');
    if (!ADMIN_PASSWORD) console.warn('WARNING: adminPassword is empty in config.js, admin login is disabled');
    if (db.kind === 'memory') console.warn('WARNING: mongodbUri is empty in config.js, data is kept in memory only');
  });
}).catch(e => { console.error('Database error:', e.message); process.exit(1); });

module.exports = server;
