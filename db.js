'use strict';
// Storage layer. MongoDB when MONGODB_URI is set, otherwise an in-memory store (only for local testing).

function vparts(v) { return String(v || '').split(/[^0-9]+/).filter(Boolean).map(n => parseInt(n, 10) || 0); }
function newer(a, b) {
  const x = vparts(a), y = vparts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] || 0, q = y[i] || 0;
    if (p !== q) return p > q;
  }
  return false;
}


const hitDevice = (d, q) => !q || (String(d.model || '') + ' ' + String(d.v || '') + ' ' + String(d.id || '')).toLowerCase().includes(String(q).toLowerCase());
function topN(map, n) { return Object.entries(map).sort((a, b) => b[1] - a[1]).slice(0, n); }
function lastDays(map, days) {
  const out = [], now = Date.now();
  for (let i = days - 1; i >= 0; i--) { const k = new Date(now - i * 864e5).toISOString().slice(0, 10); out.push({ d: k, n: map[k] || 0 }); }
  return out;
}
const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function memoryDb() {
  const settings = new Map(), devices = new Map(), messages = [], responses = [];
  return {
    kind: 'memory',
    async init() {},
    async getSetting(k, d) { return settings.has(k) ? settings.get(k) : d; },
    async setSetting(k, v) { settings.set(k, v); },
    async upsertDevice(id, f) {
      const old = devices.get(id) || null;
      const now = Date.now();
      devices.set(id, Object.assign({ id, first: now }, old || {}, f, { last: now }));
      return old;
    },
    async getDevice(id) { return devices.get(id) || null; },
    async setLastAck(id, ts) { const d = devices.get(id); if (d && (d.lastAck || 0) < ts) d.lastAck = ts; },
    async listDevices(limit, q, onlyBlocked) { return [...devices.values()].filter(d => hitDevice(d, q) && (!onlyBlocked || d.blocked)).sort((a, b) => b.last - a.last).slice(0, limit); },
    async setBlocked(id, blocked, reason) {
      const d = devices.get(id); if (!d) return false;
      d.blocked = !!blocked; d.reason = blocked ? String(reason || '') : ''; d.blockedAt = blocked ? Date.now() : 0;
      return true;
    },
    async deleteDevice(id) { return devices.delete(id); },
    async breakdown() {
      const models = {}, sdks = {}, daily = {}, since = Date.now() - 14 * 864e5;
      for (const d of devices.values()) {
        const m = d.model || 'Unknown'; models[m] = (models[m] || 0) + 1;
        const k = d.sdk ? String(d.sdk) : '?'; sdks[k] = (sdks[k] || 0) + 1;
        if (d.first > since) { const day = new Date(d.first).toISOString().slice(0, 10); daily[day] = (daily[day] || 0) + 1; }
      }
      return { models: topN(models, 8), sdks: topN(sdks, 8), daily: lastDays(daily, 14) };
    },
    async upsertResponse(r) {
      const i = responses.findIndex(x => x.survey === r.survey && x.device === r.device);
      if (i >= 0) responses[i] = r; else responses.push(r);
    },
    async listResponses(survey, limit) { return responses.filter(x => x.survey === survey).sort((a, b) => b.ts - a.ts).slice(0, limit); },
    async countResponses(survey) { return responses.filter(x => x.survey === survey).length; },
    async clearResponses(survey) { let n = 0; for (let i = responses.length - 1; i >= 0; i--) if (responses[i].survey === survey) { responses.splice(i, 1); n++; } return n; },
    async stats() {
      const now = Date.now(), all = [...devices.values()], versions = {};
      all.forEach(d => { versions[d.v || '?'] = (versions[d.v || '?'] || 0) + 1; });
      return {
        total: all.length,
        active24h: all.filter(d => now - d.last < 864e5).length,
        active7d: all.filter(d => now - d.last < 6048e5).length,
        new24h: all.filter(d => now - d.first < 864e5).length,
        blocked: all.filter(d => d.blocked).length,
        versions
      };
    },
    async insertMessage(m) { messages.unshift(m); },
    async listMessages(limit) { return messages.slice(0, limit); },
    async messagesSince(ts, limit) { return messages.filter(m => m.ts > ts).sort((a, b) => a.ts - b.ts).slice(-limit); },
    async getMessage(id) { return messages.find(m => m.id === id) || null; },
    async deleteMessage(id) { const i = messages.findIndex(m => m.id === id); if (i >= 0) messages.splice(i, 1); return i >= 0; },
    async incAck(id) { const m = messages.find(x => x.id === id); if (m) m.acks = (m.acks || 0) + 1; }
  };
}

function mongoDb(uri) {
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });
  let S, D, M, R;
  const strip = d => { if (d) delete d._id; return d; };
  return {
    kind: 'mongodb',
    async init() {
      await client.connect();
      const db = client.db(require('./config').dbName || 'typex');
      S = db.collection('settings'); D = db.collection('devices'); M = db.collection('messages'); R = db.collection('responses');
      await D.createIndex({ last: -1 });
      await M.createIndex({ ts: -1 });
      await M.createIndex({ id: 1 }, { unique: true });
      await R.createIndex({ survey: 1, device: 1 }, { unique: true });
    },
    async getSetting(k, d) { const r = await S.findOne({ _id: k }); return r ? r.value : d; },
    async setSetting(k, v) { await S.updateOne({ _id: k }, { $set: { value: v } }, { upsert: true }); },
    async upsertDevice(id, f) {
      const now = Date.now();
      const old = await D.findOneAndUpdate({ _id: id }, { $set: Object.assign({}, f, { last: now }), $setOnInsert: { first: now } }, { upsert: true, returnDocument: 'before' });
      return old ? Object.assign({ id }, old) : null;
    },
    async getDevice(id) { const r = await D.findOne({ _id: id }); return r ? Object.assign({ id }, r) : null; },
    async setLastAck(id, ts) { await D.updateOne({ _id: id, $or: [{ lastAck: { $lt: ts } }, { lastAck: { $exists: false } }] }, { $set: { lastAck: ts } }); },
    async setBlocked(id, blocked, reason) {
      const set = blocked ? { blocked: true, reason: String(reason || ''), blockedAt: Date.now() } : { blocked: false, reason: '', blockedAt: 0 };
      return (await D.updateOne({ _id: id }, { $set: set })).matchedCount > 0;
    },
    async listDevices(limit, q, onlyBlocked) {
      const re = q ? new RegExp(escRe(q), 'i') : null;
      const f = re ? { $or: [{ model: re }, { v: re }, { _id: re }] } : {};
      if (onlyBlocked) f.blocked = true;
      return (await D.find(f).sort({ last: -1 }).limit(limit).toArray()).map(d => { d.id = d._id; delete d._id; return d; });
    },
    async deleteDevice(id) { return (await D.deleteOne({ _id: id })).deletedCount > 0; },
    async breakdown() {
      const since = Date.now() - 14 * 864e5;
      const [m, k, dd] = await Promise.all([
        D.aggregate([{ $group: { _id: '$model', n: { $sum: 1 } } }]).toArray(),
        D.aggregate([{ $group: { _id: '$sdk', n: { $sum: 1 } } }]).toArray(),
        D.aggregate([{ $match: { first: { $gt: since } } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: { $toDate: '$first' } } }, n: { $sum: 1 } } }]).toArray()
      ]);
      const models = {}, sdks = {}, daily = {};
      m.forEach(r => { const key = r._id || 'Unknown'; models[key] = (models[key] || 0) + r.n; });
      k.forEach(r => { const key = r._id ? String(r._id) : '?'; sdks[key] = (sdks[key] || 0) + r.n; });
      dd.forEach(r => { daily[r._id] = r.n; });
      return { models: topN(models, 8), sdks: topN(sdks, 8), daily: lastDays(daily, 14) };
    },
    async upsertResponse(r) { await R.updateOne({ survey: r.survey, device: r.device }, { $set: r }, { upsert: true }); },
    async listResponses(survey, limit) { return (await R.find({ survey }).sort({ ts: -1 }).limit(limit).toArray()).map(strip); },
    async countResponses(survey) { return R.countDocuments({ survey }); },
    async clearResponses(survey) { return (await R.deleteMany({ survey })).deletedCount; },
    async stats() {
      const now = Date.now();
      const [total, a24, a7, n24, vs, nb] = await Promise.all([
        D.countDocuments({}), D.countDocuments({ last: { $gt: now - 864e5 } }), D.countDocuments({ last: { $gt: now - 6048e5 } }),
        D.countDocuments({ first: { $gt: now - 864e5 } }), D.aggregate([{ $group: { _id: '$v', n: { $sum: 1 } } }]).toArray(),
        D.countDocuments({ blocked: true })
      ]);
      const versions = {};
      vs.forEach(r => { versions[r._id || '?'] = r.n; });
      return { total, active24h: a24, active7d: a7, new24h: n24, blocked: nb, versions };
    },
    async insertMessage(m) { await M.insertOne(Object.assign({}, m)); },
    async listMessages(limit) { return (await M.find({}).sort({ ts: -1 }).limit(limit).toArray()).map(strip); },
    async messagesSince(ts, limit) { return (await M.find({ ts: { $gt: ts } }).sort({ ts: -1 }).limit(limit).toArray()).map(strip).reverse(); },
    async getMessage(id) { return strip(await M.findOne({ id })); },
    async deleteMessage(id) { return (await M.deleteOne({ id })).deletedCount > 0; },
    async incAck(id) { await M.updateOne({ id }, { $inc: { acks: 1 } }); }
  };
}

function open() {
  const cfg = require('./config');
  const uri = String(cfg.mongodbUri || process.env.MONGODB_URI || '').trim();
  return uri ? mongoDb(uri) : memoryDb();
}

module.exports = { open, newer };
