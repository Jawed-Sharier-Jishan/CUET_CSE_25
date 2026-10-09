'use strict';

// Render entry point: runs server.js as a long-lived web service.
// - Data lives in Firestore (mirrored from a local SQLite working copy on Render's disk)
// - Uploaded media lives in Cloudinary (CLOUDINARY_URL)
// Run exactly ONE instance (the SQLite working copy is per-process).

const crypto = require('node:crypto');
const http = require('node:http');
const admin = require('firebase-admin');

process.env.DB_FILE ||= '/tmp/cuetcse25.sqlite';
process.env.VAPID_SUBJECT ||= 'mailto:u2504081@student.cuet.ac.bd';

if (!process.env.CLOUDINARY_URL) console.warn('WARNING: CLOUDINARY_URL is not set. Uploads would be lost on every restart.');
if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) console.warn('WARNING: VAPID keys are not set. Push subscriptions will break on every restart.');

const COLLECTIONS = ['users', 'sessions', 'items', 'votes', 'push_subscriptions', 'push_preferences'];
const PORT = process.env.PORT || 3000;

function loadServiceAccount() {
  const raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) throw new Error('Set FIREBASE_SERVICE_ACCOUNT (service-account JSON, plain or base64).');
  return JSON.parse(raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8'));
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function documentId(table, row) {
  if (table === 'push_subscriptions') return crypto.createHash('sha256').update(row.endpoint).digest('hex');
  if (table === 'votes') return `${row.poll}_${row.uid}`;
  return String(row.id || row.token || row.endpoint || row.uid);
}
function toMap(state) {
  const entries = new Map();
  for (const table of COLLECTIONS) for (const row of state[table] || []) {
    const id = documentId(table, row);
    entries.set(`${table}/${id}`, { table, id, row, json: JSON.stringify(stable(row)) });
  }
  return entries;
}

async function main() {
  admin.initializeApp({ credential: admin.credential.cert(loadServiceAccount()) });
  const firestore = admin.firestore();
  firestore.settings({ ignoreUndefinedProperties: true });

  const backend = require('./server');
  const mirror = new Map();

  // 1. Restore everything from Firestore into the local SQLite working copy.
  for (const table of COLLECTIONS) {
    const snapshot = await firestore.collection(`app_${table}`).get();
    for (const document of snapshot.docs) {
      const row = document.data();
      mirror.set(`${table}/${document.id}`, { table, id: document.id, row, json: JSON.stringify(stable(row)) });
    }
  }
  if (mirror.size) {
    const restored = Object.fromEntries(COLLECTIONS.map(table => [table, []]));
    for (const item of mirror.values()) restored[item.table].push(item.row);
    backend.restorePersistentState(restored);
  }
  console.log(`Restored ${mirror.size} records from Firestore`);

  // 2. Write local changes back to Firestore (only what changed), one flush at a time.
  let queue = Promise.resolve();
  const flush = () => (queue = queue.then(async () => {
    const current = toMap(backend.dumpPersistentState()), writes = [];
    for (const [key, item] of current) if (mirror.get(key)?.json !== item.json) writes.push({ type: 'set', ...item });
    for (const [key, item] of mirror) if (!current.has(key)) writes.push({ type: 'delete', ...item });
    for (let offset = 0; offset < writes.length; offset += 400) {
      const batch = firestore.batch();
      for (const write of writes.slice(offset, offset + 400)) {
        const ref = firestore.collection(`app_${write.table}`).doc(write.id);
        if (write.type === 'delete') batch.delete(ref); else batch.set(ref, write.row);
      }
      await batch.commit();
    }
    mirror.clear(); for (const [key, item] of current) mirror.set(key, item);
  }).catch(error => console.error('Firestore sync failed (will retry):', error)));

  await flush(); // seeds a brand-new Firestore with the app's default data

  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (req.method !== 'GET' && req.method !== 'HEAD') res.on('finish', flush);
    return backend.handleRequest(req, res);
  });
  server.listen(PORT, () => console.log(`CUET CSE '25 running on port ${PORT}`));

  const timer = setInterval(flush, 30000); timer.unref();
  const shutdown = async () => { clearInterval(timer); server.close(); await flush(); process.exit(0); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}

main().catch(error => { console.error('Startup failed:', error); process.exit(1); });
