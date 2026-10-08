'use strict';

const crypto = require('node:crypto');
const admin = require('firebase-admin');
const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');

const cloudinaryUrl = defineSecret('CLOUDINARY_URL');
const vapidPublicKey = defineSecret('VAPID_PUBLIC_KEY');
const vapidPrivateKey = defineSecret('VAPID_PRIVATE_KEY');
const COLLECTIONS = ['users', 'sessions', 'items', 'votes', 'push_subscriptions', 'push_preferences'];
let runtime;

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
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
    const id = documentId(table, row);
    entries.set(`${table}/${id}`, { table, id, row, json: JSON.stringify(stable(row)) });
  }
  return entries;
}

async function initializeRuntime() {
  if (runtime) return runtime;
  process.env.DB_FILE = '/tmp/cuetcse25.sqlite';
  process.env.CLOUDINARY_URL = cloudinaryUrl.value();
  process.env.VAPID_PUBLIC_KEY = vapidPublicKey.value();
  process.env.VAPID_PRIVATE_KEY = vapidPrivateKey.value();
  process.env.VAPID_SUBJECT ||= 'mailto:u2504081@student.cuet.ac.bd';
  if (!admin.apps.length) admin.initializeApp();
  const backend = require('./server');
  const firestore = admin.firestore();
  const mirror = new Map();

  for (const table of COLLECTIONS) {
    const snapshot = await firestore.collection(`app_${table}`).get();
    for (const document of snapshot.docs) { const row = document.data(); mirror.set(`${table}/${document.id}`, { table, id: document.id, row, json: JSON.stringify(stable(row)) }); }
  }

  if (mirror.size) {
    const restored = Object.fromEntries(COLLECTIONS.map(table => [table, []]));
    for (const item of mirror.values()) restored[item.table].push(item.row);
    backend.restorePersistentState(restored);
  }

  const flush = async () => {
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
  };

  await flush();
  runtime = { backend, flush };
  return runtime;
}

exports.app = onRequest({
  region: 'asia-south1',
  maxInstances: 1,
  concurrency: 1,
  memory: '1GiB',
  timeoutSeconds: 120,
  secrets: [cloudinaryUrl, vapidPublicKey, vapidPrivateKey]
}, async (req, res) => {
  try {
    const active = await initializeRuntime();
    await active.backend.handleRequest(req, res);
    await active.flush();
  } catch (error) {
    console.error('Firebase request failed:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Server error' });
    else res.end();
  }
});
