'use strict';
// End-to-end test against the in-memory store: node test.js
process.env.PORT = '3911'; process.env.ADMIN_PASSWORD = 'secret-pass'; delete process.env.MONGODB_URI;
require('./config').mongodbUri = '';
const assert = require('assert');
const server = require('./server');
const B = 'http://127.0.0.1:3911';
const j = async (m, u, b, h) => { const r = await fetch(B + u, { method: m, headers: Object.assign(b ? { 'Content-Type': 'application/json' } : {}, h || {}), body: b ? JSON.stringify(b) : undefined }); let o = {}; try { o = await r.json(); } catch (e) {} return { s: r.status, o, r }; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  await sleep(400);
  let r = await j('GET', '/health'); assert.equal(r.s, 200);
  r = await fetch(B + '/'); assert.equal(r.status, 200); assert((await r.text()).includes('Typex Board Admin'));
  r = await fetch(B + '/logo.png'); assert.equal(r.headers.get('content-type'), 'image/png');

  // admin needs login
  assert.equal((await j('GET', '/admin/api/stats')).s, 401);
  assert.equal((await j('POST', '/admin/login', { password: 'nope' })).s, 401);
  r = await j('POST', '/admin/login', { password: 'secret-pass' }); assert.equal(r.s, 200);
  const ck = r.r.headers.get('set-cookie').split(';')[0]; const A = { Cookie: ck };
  assert((r.r.headers.get('set-cookie')).includes('HttpOnly'));
  assert.equal((await j('GET', '/admin/api/stats', null, { Cookie: 'tx_admin=1.bad' })).s, 401);
  assert.equal((await j('POST', '/admin/api/messages', { title: 'a', text: 'b' }, Object.assign({ Origin: 'http://evil.com' }, A))).s, 403);

  // update feed: empty -> manual -> validation
  r = await j('GET', '/api/update'); assert.equal(r.o.versionName, '0.0');
  assert.equal((await j('POST', '/admin/api/update', { mode: 'manual', version: 'abc', apk: 'https://x.io/a.apk' }, A)).s, 400);
  assert.equal((await j('POST', '/admin/api/update', { mode: 'manual', version: '2.9', apk: 'ftp://x' }, A)).s, 400);
  assert.equal((await j('POST', '/admin/api/update', { mode: 'manual', version: '2.9', page: 'https://x.io', force: true }, A)).s, 400);
  assert.equal((await j('POST', '/admin/api/update', { mode: 'github', repo: 'bad repo' }, A)).s, 400);
  r = await j('POST', '/admin/api/update', { mode: 'manual', version: 'v2.9', apk: 'https://x.io/Lipi-2.9.apk', notes: '- faster', force: true }, A); assert.equal(r.s, 200);
  r = await j('GET', '/api/update');
  assert.deepEqual(r.o, { versionName: '2.9', notes: '- faster', apk: 'https://x.io/Lipi-2.9.apk', page: '', force: true });

  // phones connect
  const d1 = 'aaaaaaaa-1111', d2 = 'bbbbbbbb-2222';
  assert.equal((await j('POST', '/api/ping', { id: 'x' })).s, 400);
  assert.equal((await j('POST', '/api/ping', { id: d1, v: '2.8', model: 'Redmi 12', sdk: 34 })).s, 200);
  assert.equal((await j('POST', '/api/ping', { id: d2, v: '2.5', model: 'Galaxy A14', sdk: 33 })).s, 200);
  r = await j('GET', '/admin/api/stats', null, A); assert.equal(r.o.total, 2); assert.equal(r.o.versions['2.8'], 1);

  // notifications
  assert.equal((await j('POST', '/admin/api/messages', { title: '', text: 'x' }, A)).s, 400);
  assert.equal((await j('POST', '/admin/api/messages', { title: 't', text: 'x', link: 'javascript:alert(1)' }, A)).s, 400);
  const m1 = (await j('POST', '/admin/api/messages', { title: 'Hello all', text: 'New themes', link: 'https://x.io' }, A)).o.message;
  await sleep(5);
  const m2 = (await j('POST', '/admin/api/messages', { title: 'Old phones only', text: 'Please update', before: '2.8' }, A)).o.message;
  r = await j('GET', '/api/messages?since=0&v=2.8&id=' + d1); assert.deepEqual(r.o.messages.map(m => m.title), ['Hello all']);
  r = await j('GET', '/api/messages?since=0&v=2.5&id=' + d2); assert.deepEqual(r.o.messages.map(m => m.title), ['Hello all', 'Old phones only']);
  r = await j('GET', '/api/messages?since=' + m1.ts + '&v=2.5'); assert.deepEqual(r.o.messages.map(m => m.title), ['Old phones only']);
  assert(!('before' in r.o.messages[0]) && !('acks' in r.o.messages[0]));

  // delivery count counts each phone once
  await j('POST', '/api/ack', { id: d1, msg: m1.id }); await j('POST', '/api/ack', { id: d1, msg: m1.id });
  await j('POST', '/api/ack', { id: d2, msg: m1.id });
  r = await j('GET', '/admin/api/messages', null, A); assert.equal(r.o.messages.find(m => m.id === m1.id).acks, 2);
  assert.equal((await j('DELETE', '/admin/api/messages/' + m2.id, null, A)).s, 200);
  r = await j('GET', '/api/messages?since=0&v=2.5&id=' + d2); assert.equal(r.o.messages.length, 1);
  r = await j('GET', '/admin/api/devices', null, A); assert.equal(r.o.devices.length, 2);


  // survey: built-in questions work before anything is published
  r = await j('GET', '/api/survey'); assert.equal(r.s, 200); assert.equal(r.o.id, 'default1'); assert.equal(r.o.questions.length, 4);
  const good = { use: ['Every day'], fav: ['Themes', 'Clipboard'], rate: ['4 - Very good'], next: ['Other'] };
  assert.equal((await j('POST', '/api/survey', { id: 'x', survey: 'default1', answers: good })).s, 400);
  assert.equal((await j('POST', '/api/survey', { id: d1, survey: 'nope', answers: good })).s, 409);
  assert.equal((await j('POST', '/api/survey', { id: d1, survey: 'default1', answers: Object.assign({}, good, { use: ['Every day', 'Rarely'] }) })).s, 400); // single choice
  assert.equal((await j('POST', '/api/survey', { id: d1, survey: 'default1', answers: Object.assign({}, good, { rate: ['hack'] }) })).s, 400); // not an option
  assert.equal((await j('POST', '/api/survey', { id: d1, survey: 'default1', answers: { use: ['Every day'] } })).s, 400); // missing questions
  assert.equal((await j('POST', '/api/survey', { id: d1, survey: 'default1', answers: good, v: '2.9' })).s, 200);
  assert.equal((await j('POST', '/api/survey', { id: d1, survey: 'default1', answers: Object.assign({}, good, { rate: ['5 - Excellent'] }) })).s, 200); // same phone replaces its answer
  assert.equal((await j('POST', '/api/survey', { id: d2, survey: 'default1', answers: good })).s, 200);
  assert.equal((await j('GET', '/admin/api/survey')).s, 401);
  r = await j('GET', '/admin/api/survey', null, A); assert.equal(r.o.count, 2); assert(r.o.isDefault);
  const rate = r.o.results.find(q => q.id === 'rate').options; assert.equal(rate.find(o => o.o === '5 - Excellent').n, 1); assert.equal(rate.find(o => o.o === '4 - Very good').n, 1);
  assert.equal(r.o.results.find(q => q.id === 'fav').options.find(o => o.o === 'Themes').n, 2);
  r = await j('GET', '/admin/api/stats', null, A); assert.equal(r.o.surveyAnswers, 2); assert.equal(r.o.breakdown.daily.length, 14); assert.equal(r.o.breakdown.models[0][1], 1);
  r = await fetch(B + '/admin/api/survey.csv', { headers: A }); assert(r.headers.get('content-type').startsWith('text/csv')); const csv = await r.text(); assert(csv.includes('5 - Excellent') && csv.split('\r\n').length === 3);

  // survey: publish own questions, validation, old survey closes
  assert.equal((await j('POST', '/admin/api/survey', { title: 'x', questions: [] }, A)).s, 400);
  assert.equal((await j('POST', '/admin/api/survey', { title: 'x', questions: [{ q: 'Only one option?', options: ['a', 'a'] }] }, A)).s, 400);
  assert.equal((await j('POST', '/admin/api/survey', { title: 'x', questions: [null] }, A)).s, 400);
  r = await j('POST', '/admin/api/survey', { title: 'Next features', questions: [{ q: 'Pick one', options: ['Dark mode', 'Gestures', ' Gestures '], multi: false }, { q: 'Pick many', options: ['A', 'B', 'C'], multi: true }] }, A);
  assert.equal(r.s, 200); const sid = r.o.survey.id;
  r = await j('GET', '/api/survey'); assert.equal(r.o.id, sid); assert.deepEqual(r.o.questions[0].options, ['Dark mode', 'Gestures']); assert.equal(r.o.questions[1].id, 'q2');
  assert.equal((await j('POST', '/api/survey', { id: d1, survey: 'default1', answers: good })).s, 409); // old survey closed
  assert.equal((await j('POST', '/api/survey', { id: d1, survey: sid, answers: { q1: ['Gestures'], q2: ['A', 'C'] } })).s, 200);
  r = await j('GET', '/admin/api/survey', null, A); assert.equal(r.o.count, 1); assert(!r.o.isDefault);
  r = await j('POST', '/admin/api/survey/clear', {}, A); assert.equal(r.o.removed, 1);
  assert.equal((await j('GET', '/admin/api/survey', null, A)).o.count, 0);

  // phones: search, csv, remove
  r = await j('GET', '/admin/api/devices?q=redmi', null, A); assert.equal(r.o.devices.length, 1); assert.equal(r.o.devices[0].model, 'Redmi 12');
  r = await j('GET', '/admin/api/devices?q=2.5', null, A); assert.equal(r.o.devices.length, 1);
  r = await j('GET', '/admin/api/devices?q=zzz', null, A); assert.equal(r.o.devices.length, 0);
  r = await fetch(B + '/admin/api/devices.csv', { headers: A }); assert((await r.text()).includes('Galaxy A14'));
  assert.equal((await j('DELETE', '/admin/api/devices/' + d2, null, A)).s, 200);
  assert.equal((await j('DELETE', '/admin/api/devices/' + d2, null, A)).s, 404);
  assert.equal((await j('GET', '/admin/api/stats', null, A)).o.total, 1);
  await j('POST', '/api/ping', { id: d2, v: '2.5', model: 'Galaxy A14', sdk: 33 });

  // block / unblock a phone
  assert.equal((await j('POST', '/admin/api/devices/block', { id: d2, blocked: true })).s, 401);
  assert.equal((await j('POST', '/admin/api/devices/block', { id: 'x', blocked: true }, A)).s, 400);
  assert.equal((await j('POST', '/admin/api/devices/block', { id: 'cccccccc-9999', blocked: true }, A)).s, 404);
  assert.equal((await j('POST', '/admin/api/devices/block', { id: d2, blocked: true, reason: 'spam' }, A)).s, 200);
  r = await j('POST', '/api/ping', { id: d2, v: '2.5', model: 'Galaxy A14', sdk: 33 }); assert.equal(r.o.blocked, true); assert.equal(r.o.reason, 'spam');
  r = await j('POST', '/api/ping', { id: d1, v: '2.8', model: 'Redmi 12', sdk: 34 }); assert.equal(r.o.blocked, false);
  r = await j('GET', '/api/messages?since=0&v=2.5&id=' + d2); assert.equal(r.o.messages.length, 0); assert.equal(r.o.blocked, true);
  assert.equal((await j('POST', '/api/ack', { id: d2, msg: m1.id })).s, 403);
  assert.equal((await j('POST', '/api/survey', { id: d2, survey: (await j('GET', '/api/survey')).o.id, answers: { q1: ['Gestures'], q2: ['A'] } })).s, 403);
  r = await j('GET', '/admin/api/stats', null, A); assert.equal(r.o.blocked, 1);
  r = await j('GET', '/admin/api/devices?blocked=1', null, A); assert.equal(r.o.devices.length, 1); assert.equal(r.o.devices[0].id, d2);
  assert.equal((await j('POST', '/admin/api/devices/block', { id: d2, blocked: false }, A)).s, 200);
  r = await j('POST', '/api/ping', { id: d2, v: '2.5', model: 'Galaxy A14', sdk: 33 }); assert.equal(r.o.blocked, false);
  assert.equal((await j('GET', '/admin/api/stats', null, A)).o.blocked, 0);

  // premium / payments (manual approval)
  r = await j('GET', '/api/premium?id=' + d1); assert.equal(r.s, 200); assert.equal(r.o.enabled, false); assert.equal(r.o.active, false); assert.equal(r.o.plans.length, 3);
  r = await j('POST', '/api/ping', { id: d1, v: '2.8', model: 'Redmi 12', sdk: 34 }); assert.equal(r.o.premiumOn, false); assert.equal(r.o.premiumUntil, 0);
  assert.equal((await j('POST', '/api/premium/request', { id: d1, plan: 'p1', ref: 'ABC12345' })).s, 409); // premium still off
  assert.equal((await j('GET', '/admin/api/premium')).s, 401);
  assert.equal((await j('POST', '/admin/api/premium/config', { enabled: true, plans: [] }, A)).s, 400);
  assert.equal((await j('POST', '/admin/api/premium/config', { enabled: true, payInfo: 'Bank X 123', plans: [{ name: 'Month', days: 30, price: 300 }, { name: 'Year', days: 365, price: 2500 }] }, A)).s, 200);
  r = await j('POST', '/api/ping', { id: d1, v: '2.8', model: 'Redmi 12', sdk: 34 }); assert.equal(r.o.premiumOn, true);
  assert.equal((await j('POST', '/api/premium/request', { id: d1, plan: 'zz', ref: 'ABC12345' })).s, 400);
  assert.equal((await j('POST', '/api/premium/request', { id: d1, plan: 'p1', ref: 'ab' })).s, 400);
  r = await j('POST', '/api/premium/request', { id: d1, plan: 'p1', ref: 'EZ-98765', name: 'Kamal' }); assert.equal(r.s, 200); assert.equal(r.o.request.status, 'pending'); assert.equal(r.o.request.amount, 300);
  assert.equal((await j('POST', '/api/premium/request', { id: d2, plan: 'p1', ref: 'ez 98765' })).s, 409); // same reference, other phone
  r = await j('GET', '/api/premium?id=' + d1); assert.equal(r.o.active, false); assert.equal(r.o.requests.length, 1);
  r = await j('GET', '/admin/api/payments?status=pending', null, A); assert.equal(r.o.payments.length, 1); const pid = r.o.payments[0].id; assert.equal(r.o.payments[0].model, 'Redmi 12');
  r = await j('GET', '/admin/api/stats', null, A); assert.equal(r.o.pendingPayments, 1);
  assert.equal((await j('POST', '/admin/api/payments/decide', { id: pid, action: 'approve' })).s, 401);
  r = await j('POST', '/admin/api/payments/decide', { id: pid, action: 'approve' }, A); assert.equal(r.s, 200); assert(r.o.until > Date.now() + 29 * 864e5);
  assert.equal((await j('POST', '/admin/api/payments/decide', { id: pid, action: 'approve' }, A)).s, 409); // cannot approve twice
  r = await j('GET', '/api/premium?id=' + d1); assert.equal(r.o.active, true); assert.equal(r.o.plan, 'Month'); assert.equal(r.o.requests[0].status, 'approved');
  r = await j('POST', '/api/ping', { id: d1, v: '2.8', model: 'Redmi 12', sdk: 34 }); assert(r.o.premiumUntil > Date.now());
  // second approved payment extends the time instead of replacing it
  r = await j('POST', '/api/premium/request', { id: d1, plan: 'p2', ref: 'EZ-55555' }); assert.equal(r.s, 200);
  const pid2 = (await j('GET', '/admin/api/payments?status=pending', null, A)).o.payments[0].id;
  const before = (await j('GET', '/api/premium?id=' + d1)).o.until;
  await j('POST', '/admin/api/payments/decide', { id: pid2, action: 'approve' }, A);
  assert(Math.abs((await j('GET', '/api/premium?id=' + d1)).o.until - before - 365 * 864e5) < 5000);
  // reject keeps premium unchanged and frees the reference
  r = await j('POST', '/api/premium/request', { id: d2, plan: 'p1', ref: 'EZ-77777' }); const pid3 = (await j('GET', '/admin/api/payments?status=pending', null, A)).o.payments[0].id;
  assert.equal((await j('POST', '/admin/api/payments/decide', { id: pid3, action: 'reject', note: 'Not found' }, A)).s, 200);
  r = await j('GET', '/api/premium?id=' + d2); assert.equal(r.o.active, false); assert.equal(r.o.requests[0].status, 'rejected'); assert.equal(r.o.requests[0].note, 'Not found');
  assert.equal((await j('POST', '/api/premium/request', { id: d2, plan: 'p1', ref: 'EZ-77777' })).s, 200);
  // admin stats, gift, revoke
  r = await j('GET', '/admin/api/premium', null, A); assert.equal(r.o.stats.vip, 1); assert.equal(r.o.stats.income.total, 300 + 2500); assert.equal(r.o.stats.income.today, 2800); assert.equal(r.o.vips.length, 1);
  assert.equal((await j('POST', '/admin/api/premium/grant', { id: d2, days: 7 }, A)).s, 200);
  assert.equal((await j('GET', '/api/premium?id=' + d2)).o.active, true);
  assert.equal((await j('POST', '/admin/api/premium/grant', { id: d2, days: 0 }, A)).s, 200);
  assert.equal((await j('GET', '/api/premium?id=' + d2)).o.active, false);
  assert.equal((await j('POST', '/admin/api/premium/grant', { id: 'cccccccc-9999', days: 5 }, A)).s, 404);
  r = await fetch(B + '/admin/api/payments.csv', { headers: A }); assert.equal(r.status, 200); assert((await r.text()).includes('EZ-98765'));
  // too many waiting requests from one phone
  for (const k of ['AAAA1', 'AAAA2', 'AAAA3']) await j('POST', '/api/premium/request', { id: d1, plan: 'p1', ref: k });
  assert.equal((await j('POST', '/api/premium/request', { id: d1, plan: 'p1', ref: 'AAAA4' })).s, 429);

  // login rate limit
  let last; for (let i = 0; i < 9; i++) last = await j('POST', '/admin/login', { password: 'x' }); assert.equal(last.s, 429);
  // oversized body
  r = await j('POST', '/api/ping', { id: d1, model: 'x'.repeat(20000) }); assert.equal(r.s, 413);
  console.log('ALL TESTS PASSED'); server.close(); process.exit(0);
})().catch(e => { console.error('TEST FAILED', e); process.exit(1); });
