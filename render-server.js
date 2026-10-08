'use strict';
// Runs the CUET CSE '25 server as a normal long-lived Node process (Render free web service, etc.)
// without a credit card. SQLite lives in /tmp and is mirrored to Firestore (free Spark plan),
// so accounts, marks, chat and everything else survive Render's sleeping and redeploys.
// Uploaded files should go to Cloudinary (free, no card): set CLOUDINARY_URL.
//
// Firestore layout is identical to firebase-function.js / scripts/migrate-to-firebase.js
// (collections app_users, app_items, ...), so data migrated with that script is picked up.
const http = require('node:http');
const crypto = require('node:crypto');
const path = require('node:path');
const os = require('node:os');
const admin = require('firebase-admin');

const COLLECTIONS = ['users', 'sessions', 'items', 'votes', 'push_subscriptions', 'push_preferences'];
const FLUSH_DELAY_MS = +process.env.FLUSH_DELAY_MS || 3000;     // save this long after a change
const FLUSH_EVERY_MS = +process.env.FLUSH_EVERY_MS || 60000;    // safety-net save (GET requests can purge expired data)
const log = (...a) => console.log(new Date().toISOString(), ...a);

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])]));
  return value;
}
function documentId(table, row) {
  if (table === 'push_subscriptions') return crypto.createHash('sha256').update(row.endpoint).digest('hex');
  if (table === 'votes') return `${row.poll}_${row.uid}`;
  return row.id || row.token || row.endpoint || row.uid;
}
function toMap(state) {
  const entries = new Map();
  for (const table of COLLECTIONS) for (const row of state[table] || []) {
    const id = String(documentId(table, row));
    entries.set(`${table}/${id}`, { table, id, row, json: JSON.stringify(stable(row)) });
  }
  return entries;
}

function credential() {
  let raw = (process.env.FIREBASE_SERVICE_ACCOUNT || '').trim();
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT is not set. Paste the service-account JSON key into this environment variable (see DEPLOY-RENDER.md).');
  if (raw[0] !== '{') raw = Buffer.from(raw, 'base64').toString('utf8');      // also accept a base64-encoded key
  let key;
  try { key = JSON.parse(raw); } catch { throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON.'); }
  if (typeof key.private_key === 'string') key.private_key = key.private_key.replace(/\\n/g, '\n');
  return admin.credential.cert(key);
}

async function main() {
  admin.initializeApp({ credential: credential() });
  const firestore = admin.firestore();

  // 1. Read everything from Firestore FIRST. If this fails we exit instead of starting empty,
  //    otherwise the first save would overwrite the real data with a fresh database.
  const mirror = new Map();
  for (const table of COLLECTIONS) {
    const snap = await firestore.collection(`app_${table}`).get();
    for (const doc of snap.docs) mirror.set(`${table}/${doc.id}`, { table, id: doc.id, row: doc.data(), json: JSON.stringify(stable(doc.data())) });
  }
  log(`Loaded ${mirror.size} records from Firestore`);

  // 2. Point the server at a scratch SQLite file, then load it.
  process.env.DB_FILE = process.env.DB_FILE || path.join(os.tmpdir(), 'cuetcse25.sqlite');
  if (!process.env.CLOUDINARY_URL) log('WARNING: CLOUDINARY_URL is not set. Gallery photos and resource files are stored on the temporary disk and are LOST on restart.');
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) log('WARNING: VAPID keys are not set. Push keys will change on every restart and existing push subscriptions will stop working. Run: npm run vapid');
  const backend = require('./server');
  if (mirror.size) {
    const restored = Object.fromEntries(COLLECTIONS.map(t => [t, []]));
    for (const item of mirror.values()) restored[item.table].push(item.row);
    backend.restorePersistentState(restored);
  }

  // 3. Save changes back to Firestore (only documents that changed).
  let running = null, again = false, timer = null;
  async function flushOnce() {
    const current = toMap(backend.dumpPersistentState()), writes = [];
    for (const [key, item] of current) if (mirror.get(key)?.json !== item.json) writes.push({ type: 'set', ...item });
    for (const [key, item] of mirror) if (!current.has(key)) writes.push({ type: 'delete', ...item });
    for (let i = 0; i < writes.length; i += 400) {
      const batch = firestore.batch(), part = writes.slice(i, i + 400);
      for (const w of part) {
        const ref = firestore.collection(`app_${w.table}`).doc(w.id);
        w.type === 'delete' ? batch.delete(ref) : batch.set(ref, w.row);
      }
      await batch.commit();
      for (const w of part) { const key = `${w.table}/${w.id}`; w.type === 'delete' ? mirror.delete(key) : mirror.set(key, current.get(key)); }
    }
    if (writes.length) log(`Saved ${writes.length} change(s) to Firestore`);
  }
  function flush() {
    if (running) { again = true; return running; }
    running = (async () => {
      try { do { again = false; await flushOnce(); } while (again); }
      catch (e) { log('Firestore save failed (will retry):', e.message || e); }
      finally { running = null; }
    })();
    return running;
  }
  const schedule = () => { if (!timer) timer = setTimeout(() => { timer = null; flush(); }, FLUSH_DELAY_MS); };
  await flush();                                       // stores the seeded sample data on the very first run
  setInterval(flush, FLUSH_EVERY_MS).unref();

  // 4. Web server.
  const server = http.createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
    if (req.method !== 'GET' && req.method !== 'HEAD') res.on('finish', schedule);
    backend.handleRequest(req, res);
  });
  server.listen(process.env.PORT || 3000, () => log(`CUET CSE '25 listening on port ${process.env.PORT || 3000}`));

  // Render sends SIGTERM before it stops or replaces the service: save first.
  let closing = false;
  const stop = async () => {
    if (closing) return; closing = true; log('Shutting down, saving data...');
    if (timer) { clearTimeout(timer); timer = null; }
    server.close();
    await Promise.race([flush(), new Promise(r => setTimeout(r, 15000))]);
    process.exit(0);
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

main().catch(e => { console.error('Startup failed:', e.message || e); process.exit(1); });
