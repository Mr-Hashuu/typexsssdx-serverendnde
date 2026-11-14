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

function memoryDb() {
  const settings = new Map(), devices = new Map(), messages = [];
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
    async listDevices(limit) { return [...devices.values()].sort((a, b) => b.last - a.last).slice(0, limit); },
    async stats() {
      const now = Date.now(), all = [...devices.values()], versions = {};
      all.forEach(d => { versions[d.v || '?'] = (versions[d.v || '?'] || 0) + 1; });
      return {
        total: all.length,
        active24h: all.filter(d => now - d.last < 864e5).length,
        active7d: all.filter(d => now - d.last < 6048e5).length,
        new24h: all.filter(d => now - d.first < 864e5).length,
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
  let S, D, M;
  const strip = d => { if (d) delete d._id; return d; };
  return {
    kind: 'mongodb',
    async init() {
      await client.connect();
      const db = client.db(require('./config').dbName || 'typex');
      S = db.collection('settings'); D = db.collection('devices'); M = db.collection('messages');
      await D.createIndex({ last: -1 });
      await M.createIndex({ ts: -1 });
      await M.createIndex({ id: 1 }, { unique: true });
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
    async listDevices(limit) { return (await D.find({}).sort({ last: -1 }).limit(limit).toArray()).map(d => { d.id = d._id; delete d._id; return d; }); },
    async stats() {
      const now = Date.now();
      const [total, a24, a7, n24, vs] = await Promise.all([
        D.countDocuments({}), D.countDocuments({ last: { $gt: now - 864e5 } }), D.countDocuments({ last: { $gt: now - 6048e5 } }),
        D.countDocuments({ first: { $gt: now - 864e5 } }), D.aggregate([{ $group: { _id: '$v', n: { $sum: 1 } } }]).toArray()
      ]);
      const versions = {};
      vs.forEach(r => { versions[r._id || '?'] = r.n; });
      return { total, active24h: a24, active7d: a7, new24h: n24, versions };
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
