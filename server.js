'use strict';
// CUET CSE '25 — backend. Zero dependencies: Node >= 22.5 (built-in node:sqlite).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto'), webpush = require('web-push');
const { DatabaseSync } = require('node:sqlite');
const cloudinary = process.env.CLOUDINARY_URL ? require('cloudinary').v2 : null;
if (cloudinary) cloudinary.config({ secure: true });
const PORT = process.env.PORT || 3000, PUB = path.join(__dirname, 'public'), DB_PATH = process.env.DB_FILE || path.join(__dirname, 'data.db');
const db = new DatabaseSync(DB_PATH);
db.exec(`PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,name TEXT NOT NULL,pw TEXT NOT NULL,role TEXT NOT NULL,profile TEXT NOT NULL DEFAULT '{}');
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,uid TEXT NOT NULL,exp INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS items(id TEXT PRIMARY KEY,kind TEXT NOT NULL,owner TEXT,data TEXT NOT NULL,ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS items_kind ON items(kind);
CREATE TABLE IF NOT EXISTS votes(poll TEXT,uid TEXT,opt INTEGER,PRIMARY KEY(poll,uid));
CREATE TABLE IF NOT EXISTS push_subscriptions(endpoint TEXT PRIMARY KEY,uid TEXT NOT NULL,data TEXT NOT NULL,created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS push_subscriptions_uid ON push_subscriptions(uid);
CREATE TABLE IF NOT EXISTS push_preferences(uid TEXT PRIMARY KEY,data TEXT NOT NULL);`);
const all_ = (s, ...a) => db.prepare(s).all(...a), one = (s, ...a) => db.prepare(s).get(...a), run = (s, ...a) => db.prepare(s).run(...a);
const uploadCloudBuffer = (buffer, options) => new Promise((resolve, reject) => {
  if (!cloudinary) return reject(new Error('Cloudinary is not configured'));
  const stream = cloudinary.uploader.upload_stream({ resource_type: 'image', ...options }, (error, result) => error ? reject(error) : resolve(result));
  stream.end(buffer);
});
const cloudAsset = result => ({ publicId: result.public_id, secureUrl: result.secure_url, resourceType: result.resource_type, deliveryType: result.type || 'upload', format: result.format || '' });
const deleteCloudAsset = async asset => { if (cloudinary && asset?.publicId) await cloudinary.uploader.destroy(asset.publicId, { resource_type: asset.resourceType || 'image', type: asset.deliveryType || 'upload', invalidate: true }); };
const cloudPrivateUrl = (asset, attachment = false) => cloudinary.utils.private_download_url(asset.publicId, asset.format || 'bin', {
  resource_type: asset.resourceType || 'raw', type: asset.deliveryType || 'private', expires_at: Math.floor(Date.now() / 1000) + 300, attachment
});
const vapidFile = path.join(path.dirname(DB_PATH), 'push-vapid.json');
const PUSH_DEFAULTS = { notices: true, tests: true, resources: true, polls: true, chat: true };
const pushPreferences = uid => { const row = one('SELECT data FROM push_preferences WHERE uid=?', uid); return { ...PUSH_DEFAULTS, ...(row ? JSON.parse(row.data) : {}) }; };
let vapid;
if (!!process.env.VAPID_PUBLIC_KEY !== !!process.env.VAPID_PRIVATE_KEY) throw new Error('Set both VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY, or leave both unset.');
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) vapid = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
else {
  try { vapid = JSON.parse(fs.readFileSync(vapidFile, 'utf8')); }
  catch { vapid = webpush.generateVAPIDKeys(); fs.writeFileSync(vapidFile, JSON.stringify(vapid, null, 2), { mode: 0o600 }); }
}
webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:u2504081@student.cuet.ac.bd', vapid.publicKey, vapid.privateKey);
const pushAlert = (owner, kind, data, id) => {
  let title, body;
  if (kind === 'notice') { title = 'New notice: ' + data.t; body = data.b; }
  else if (kind === 'ct') { title = (data.x ? 'Test cancelled: ' : 'New test: ') + data.c; body = (data.ty || 'CT') + ' · ' + data.t + ' · ' + data.d + (data.tm ? ' ' + data.tm : ''); }
  else if (kind === 'ctstart') { title = (data.ty || 'CT') + ' starts now: ' + data.c; body = data.t + ' · ' + (data.tm || ctDefaultTime(data)); }
  else if (kind === 'poll') { title = 'New poll'; body = data.q; }
  else if (kind === 'pollres') { title = 'Poll results: ' + data.q; body = data.res; }
  else if (kind === 'cancel' && !data.rm) { title = (data.k === 'Lab' ? 'Lab' : 'Class') + ' cancelled: ' + data.c; body = data.d + ' · ' + data.s + '-' + data.e; }
  else if (kind === 'event' && 'x' in data) { title = (data.x ? 'Cancelled: ' : 'Restored: ') + data.t; body = data.d + (data.s ? ' · ' + data.s : ''); }
  else if (kind === 'node' && data.ty !== 'folder') { title = data.ty === 'link' ? 'New link' : 'New file'; body = data.t; }
  else if (kind === 'msg') { const sn = one('SELECT name FROM users WHERE id=?', owner); const room = data.r === 'U' ? 'Everyone' : data.r; title = (sn && sn.name || owner) + ' · Chat (' + room + ')'; body = data.img ? (data.t ? 'Photo: ' + data.t : 'Sent a photo') : ('fn' in data && (data.fn || data.once)) ? 'File: ' + (data.once ? 'view-once file' : data.fn) + (data.t ? ': ' + data.t : '') : data.t; }
  else return;
  const category = ({ msg: 'chat', notice: 'notices', ct: 'tests', ctstart: 'tests', poll: 'polls', pollres: 'polls', node: 'resources', cancel: 'notices', event: 'notices' })[kind];
  const target = data.for || 'All';
  const recipients = all_('SELECT id,role FROM users WHERE id<>?', owner).filter(u => {
    if (kind === 'msg') return roomOk(data.r, u);
    if (target === 'All' || !target) return true;
    const loc = place(u.id);
    return loc.sec === target || loc.g === target;
  }).map(u => u.id).filter(id => pushPreferences(id)[category] !== false);
  if (!recipients.length) return;
  const payload = JSON.stringify({ title, body: String(body || '').slice(0, 240), id, url: kind === 'msg' ? '/chat' : '/' });
  for (const sub of all_('SELECT endpoint,data FROM push_subscriptions WHERE uid IN (' + recipients.map(() => '?').join(',') + ')', ...recipients)) {
    webpush.sendNotification(JSON.parse(sub.data), payload, { TTL: 86400 }).catch(err => {
      if (err.statusCode === 404 || err.statusCode === 410) run('DELETE FROM push_subscriptions WHERE endpoint=?', sub.endpoint);
      else console.warn('Web Push delivery failed:', err.statusCode || err.message);
    });
  }
};
// ---- time-based alerts: test start + poll results (Bangladesh time, UTC+6, no DST) ----
const ctDefaultTime = d => ((d.ty || 'CT') === 'CT' ? '08:10' : '09:00');
const ctStartMs = d => Date.parse(d.d + 'T' + (d.tm && /^\d\d:\d\d$/.test(d.tm) ? d.tm : ctDefaultTime(d)) + ':00+06:00');
const pollCloseMs = (ts, d) => ts + (+d.cl || 24) * 36e5;
function pollResultText(d) {
  const n = (d.o || []).map(() => 0);
  all_('SELECT opt FROM votes WHERE poll=?', d.__id).forEach(v => { if (n[v.opt] != null) n[v.opt]++; });
  const tot = n.reduce((a, b) => a + b, 0); if (!tot) return 'Closed with no votes.';
  const top = Math.max(...n), win = d.o.filter((_, i) => n[i] === top);
  return (win.length > 1 ? 'Tie: ' + win.join(' / ') : 'Winner: ' + win[0]) + ' (' + top + ' of ' + tot + ' vote' + (tot === 1 ? '' : 's') + ')';
}
function timedAlerts() {
  const now = Date.now();
  for (const r of all_("SELECT id,owner,data,ts,kind FROM items WHERE kind IN ('ct','poll')")) {
    let d; try { d = JSON.parse(r.data); } catch { continue; }
    if (r.kind === 'ct') {
      if (d.sn || d.done) continue;
      const at = ctStartMs(d); if (!(now >= at)) continue;
      d.sn = 1; run('UPDATE items SET data=? WHERE id=?', JSON.stringify(d), r.id);
      if (!d.x && now < at + 90 * 6e4) pushAlert('', 'ctstart', d, r.id + 's');
    } else {
      if (d.rn || !(now >= pollCloseMs(r.ts, d))) continue;
      d.rn = 1; run('UPDATE items SET data=? WHERE id=?', JSON.stringify(d), r.id);
      if (now < pollCloseMs(r.ts, d) + 12 * 36e5) pushAlert('', 'pollres', { ...d, res: pollResultText({ ...d, __id: r.id }) }, r.id + 'r');
    }
  }
}
setTimeout(() => { try { timedAlerts(); } catch (e) { console.warn('timedAlerts:', e.message); } const t = setInterval(() => { try { timedAlerts(); } catch (e) { console.warn('timedAlerts:', e.message); } }, 60000); t.unref && t.unref(); }, 90000).unref?.();
const settings = () => { const r = one("SELECT data FROM items WHERE kind='settings'"); return r ? JSON.parse(r.data) : {}; };
// Roll 2504xxx -> Section A: 001..aEnd, Section B: aEnd+1..bEnd; each section split into two groups (first half = 1, rest = 2)
function place(id) {
  const st = settings(), a = st.aEnd || 66, b = st.bEnd || 132, n = /^2504\d{3}$/.test(id) ? +id.slice(4) : 0;
  if (n < 1 || n > b) return { sec: '', g: '' };
  const A = n <= a, size = A ? a : b - a, pos = A ? n : n - a;
  return { sec: A ? 'A' : 'B', g: (A ? 'A' : 'B') + (pos <= Math.ceil(size / 2) ? 1 : 2) };
}
const zlib = require('zlib'), UP = path.join(path.dirname(process.env.DB_FILE || path.join(__dirname, 'data.db')), 'uploads'); fs.mkdirSync(UP, { recursive: true });
const rid = () => crypto.randomBytes(5).toString('hex');
// Roles: 'student' | 'admin' | 'cr' | 'admin+cr'. Admins and CRs have the same edit rights. Only the developer (2504081) assigns roles; the developer is always an admin.
const CID = '2504081', ID_MIN = 1, ID_MAX = 132;
const devFallbackPhoto = () => ['developer.jpg', 'creator.jpg'].map(f => fs.existsSync(path.join(PUB, f)) ? '/' + f : '').find(Boolean) || '';
const inRange = id => /^2504\d{3}$/.test(id) && +id.slice(4) >= ID_MIN && +id.slice(4) <= ID_MAX;
const flags = r => ({ adm: /admin/.test(r || ''), cr: /cr/.test(r || '') });
const mkRole = (adm, cr) => adm && cr ? 'admin+cr' : adm ? 'admin' : cr ? 'cr' : 'student';
const isStaff = u => !!u && (u.id === CID || u.role !== 'student');
const put = (kind, owner, data) => { const id = rid(); run('INSERT INTO items VALUES(?,?,?,?,?)', id, kind, owner, JSON.stringify(data), Date.now()); return id; };

// ---- official Level-1 Term-I routine (Batch 2025, from the department PDF) ----------
// Periods: 1 CT 08:10-09:00 | 2 09:00-09:45 | 3 09:45-10:30 | (break) | 4 10:45-11:30 | 5 11:30-12:15 | 6 12:15-13:00 | (lunch) | 7 13:45-14:30 | 8 14:30-15:15 | 9 15:15-16:00
const PER = { 1: ['08:10', '09:00'], 2: ['09:00', '09:45'], 3: ['09:45', '10:30'], 4: ['10:45', '11:30'], 5: ['11:30', '12:15'], 6: ['12:15', '13:00'], 7: ['13:45', '14:30'], 8: ['14:30', '15:15'], 9: ['15:15', '16:00'] };
const OFFICIAL = {
  ss: '2026-07-05', se: '2026-11-22', term: 'Level-1, Term-I',
  courses: [ // code, title, credit, teachers
    ['CSE-141', 'Structured Programming', 3, 'Dr. Md Monjur Ul Hasan, Abir Hassan'],
    ['EE-181', 'Basic Electrical Engineering', 3, 'Md. Mynul Hasan, Atiya Masuda Siddika'],
    ['MATH-141', 'Differential and Integral Calculus', 3, 'Prof. Dr. Musammet Tahmina Akter, Ms. Nurun Nahar'],
    ['PHY-141', 'Physics', 3, 'Prof. Dr. Nusrat Jahan, Mr. Md. Nadim Mahamud Nobin'],
    ['HUM-141', 'English', 2, 'Prof. Dr. Kamrul Hassan, Rigan Mazumder'],
    ['CSE-100', 'Computer Fundamentals and Ethics Lab', 0.75, 'Prof. Dr. Kaushik Deb, Maisha Fahmida'],
    ['CSE-142', 'Structured Programming Lab (Compiler Lab A / Multimedia Lab B)', 1.5, 'Dr. Md Monjur Ul Hasan, Abir Hassan, Symom Hossain Shohan'],
    ['EE-182', 'Basic Electrical Engineering Lab (Microprocessor and Interfacing)', 1.5, 'Md. Mynul Hasan, Atiya Masuda Siddika'],
    ['PHY-142', 'Physics Lab', 1.5, 'Prof. Dr. H. M. A. R. Maruf, Prof. Dr. Nusrat Jahan, Dr. Shaiful Kabir, Mr. Md. Abdul Aziz']],
  // day (0=Sun..4=Thu), first period, last period, course, section/group, kind
  routine: [
    [0, 2, 2, 'MATH-141', 'A'], [0, 3, 3, 'EE-181', 'A'], [0, 4, 6, 'PHY-142', 'A2', 'Lab'], [0, 7, 9, 'CSE-100', 'A', 'Lab'],
    [1, 2, 2, 'EE-181', 'A'], [1, 3, 3, 'PHY-141', 'A'], [1, 4, 6, 'EE-182', 'A1', 'Lab'], [1, 7, 9, 'PHY-142', 'A1', 'Lab'], [1, 7, 9, 'EE-182', 'A2', 'Lab'],
    [2, 2, 2, 'HUM-141', 'A'], [2, 3, 3, 'CSE-141', 'A'], [2, 4, 4, 'EE-181', 'A'], [2, 5, 5, 'PHY-141', 'A'], [2, 7, 9, 'CSE-142', 'A2', 'Lab'],
    [3, 2, 2, 'CSE-141', 'A'], [3, 3, 3, 'HUM-141', 'A'], [3, 4, 4, 'MATH-141', 'A'], [3, 5, 5, 'PHY-141', 'A'], [3, 7, 9, 'CSE-142', 'A1', 'Lab'],
    [4, 2, 2, 'CSE-141', 'A'], [4, 3, 3, 'MATH-141', 'A'],
    [0, 2, 2, 'EE-181', 'B'], [0, 3, 3, 'MATH-141', 'B'], [0, 4, 6, 'CSE-100', 'B', 'Lab'], [0, 7, 9, 'PHY-142', 'B2', 'Lab'],
    [1, 2, 2, 'PHY-141', 'B'], [1, 3, 3, 'EE-181', 'B'], [1, 4, 6, 'CSE-142', 'B1', 'Lab'], [1, 7, 9, 'CSE-142', 'B2', 'Lab'],
    [2, 2, 2, 'CSE-141', 'B'], [2, 3, 3, 'HUM-141', 'B'], [2, 4, 4, 'PHY-141', 'B'], [2, 5, 5, 'EE-181', 'B'],
    [3, 2, 2, 'HUM-141', 'B'], [3, 3, 3, 'CSE-141', 'B'], [3, 4, 4, 'PHY-141', 'B'], [3, 5, 5, 'MATH-141', 'B'],
    [4, 2, 2, 'MATH-141', 'B'], [4, 3, 3, 'CSE-141', 'B'], [4, 4, 6, 'PHY-142', 'B1', 'Lab'], [4, 4, 6, 'EE-182', 'B2', 'Lab'], [4, 7, 9, 'EE-182', 'B1', 'Lab']],
  // class tests (held in period 1, 08:10-09:00): course, day, weeks since commencement
  cts: [['CSE-141', 1, [4, 6, 9, 11]], ['EE-181', 2, [4, 6, 9, 11]], ['MATH-141', 4, [4, 6, 9, 11]], ['PHY-141', 1, [3, 5, 8, 10]], ['HUM-141', 4, [3]], ['HUM-141', 2, [8]], ['HUM-141', 4, [12]]]
};
function loadOfficial() {
  run("DELETE FROM items WHERE kind IN ('course','routine','ct','att')");
  OFFICIAL.courses.forEach(c => put('course', null, { code: c[0], t: c[1], cr: c[2], th: c[3], ty: /lab/i.test(c[1]) ? 'Sessional' : 'Theory' }));
  OFFICIAL.routine.forEach(r => put('routine', null, { d: r[0], s: PER[r[1]][0], e: PER[r[2]][1], c: r[3], k: r[5] || 'Class', for: r[4] }));
  const today = new Date().toISOString().slice(0, 10), n = {};
  OFFICIAL.cts.forEach(([c, day, weeks]) => weeks.forEach(w => {
    const d = new Date(OFFICIAL.ss + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + (w - 1) * 7 + day);
    const iso = d.toISOString().slice(0, 10); n[c] = (n[c] || 0) + 1;
    put('ct', null, { c, t: 'CT-' + w + ' (Week ' + w + ', 08:10-09:00)', d: iso, m: '', for: 'All', done: iso < today ? 1 : 0 });
  }));
  const row = one("SELECT id FROM items WHERE kind='settings'"), st = settings();
  const data = JSON.stringify({ ...st, ss: OFFICIAL.ss, se: st.se && st.se > OFFICIAL.ss ? st.se : OFFICIAL.se, term: OFFICIAL.term });
  row ? run('UPDATE items SET data=? WHERE id=?', data, row.id) : put('settings', null, JSON.parse(data));
}

if (!one('SELECT 1 x FROM items')) { // first run: sample data (all editable by the admin)
  put('settings', null, { ss: OFFICIAL.ss, se: OFFICIAL.se, term: OFFICIAL.term, aEnd: 66, bEnd: 132 });
  loadOfficial();
  put('vac', null, { t: 'Victory Day', f: '2026-12-16', to: '2026-12-16' });
  put('notice', null, { t: 'Welcome', b: 'The first account to register becomes the class admin. Only admins can change shared content.', d: new Date().toISOString().slice(0, 10), pin: 1 });
  put('poll', null, { q: 'Best day for a makeup class?', o: ['Sunday', 'Tuesday', 'Wednesday'] });
  [['Student Portal', 'Web', 'Completed', 'Centralized web management platform for the batch.'], ['Smart Attendance', 'Embedded', 'In progress', 'IoT attendance tracking with microcontrollers.'],
   ['Study Buddy Bot', 'AI', 'Idea', 'Assistant trained on course materials and past exam questions.'], ['Maze Runner', 'Game', 'Completed', 'Graphics engine and maze solver for a lab assessment.']]
    .forEach(p => put('project', null, { t: p[0], c: p[1], s: p[2], d: p[3], a: 'CSE \'25', y: '2026', u: '' }));
}

db.prepare("UPDATE users SET role=? WHERE id=? AND role NOT LIKE '%admin%'").run('admin', CID);
const nodes = () => all_("SELECT * FROM items WHERE kind='node'").map(r => ({ id: r.id, ts: r.ts, ...JSON.parse(r.data) }));
if (!one("SELECT 1 x FROM items WHERE kind='node'")) { // folder tree: Level > Term > Course
  const mk = (t, p) => put('node', null, { t, ty: 'folder', p: p || '', sz: 0 });
  for (let l = 1; l <= 4; l++) { const L = mk('Level-' + l); ['Term-I', 'Term-II'].forEach(tm => { const T = mk(tm, L); if (l === 1 && tm === 'Term-I') OFFICIAL.courses.forEach(c => mk(c[0] + ' · ' + c[1].split(' (')[0], T)); }); }
}
async function zip(es) { const out = [], cd = []; let off = 0;
  for (const e of es) { const nm = Buffer.from(e.name); let d = Buffer.alloc(0);
    if (e.id) { const row = one('SELECT data FROM items WHERE id=? AND kind=\'node\'', e.id), cloud = row && JSON.parse(row.data).cloud;
      if (cloud) { const response = await fetch(cloudPrivateUrl(cloud)); if (!response.ok) throw { code: 502, error: 'Could not retrieve a resource from Cloudinary' }; d = Buffer.from(await response.arrayBuffer()); }
      else if (fs.existsSync(path.join(UP, e.id))) d = fs.readFileSync(path.join(UP, e.id)); }
    const c = zlib.crc32(d), h = Buffer.alloc(30), g = Buffer.alloc(46);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x800, 6); h.writeUInt32LE(c, 14); h.writeUInt32LE(d.length, 18); h.writeUInt32LE(d.length, 22); h.writeUInt16LE(nm.length, 26);
    g.writeUInt32LE(0x02014b50, 0); g.writeUInt16LE(20, 4); g.writeUInt16LE(20, 6); g.writeUInt16LE(0x800, 8); g.writeUInt32LE(c, 16); g.writeUInt32LE(d.length, 20); g.writeUInt32LE(d.length, 24); g.writeUInt16LE(nm.length, 28); g.writeUInt32LE(off, 42);
    out.push(h, nm, d); cd.push(g, nm); off += 30 + nm.length + d.length; }
  const cb = Buffer.concat(cd), eo = Buffer.alloc(22); eo.writeUInt32LE(0x06054b50, 0); eo.writeUInt16LE(es.length, 8); eo.writeUInt16LE(es.length, 10); eo.writeUInt32LE(cb.length, 12); eo.writeUInt32LE(off, 16);
  return Buffer.concat([...out, cb, eo]); }
const ROOMS = ['U', 'A', 'B', 'A1', 'A2', 'B1', 'B2'];
// Admins can read and post in every room; students only in the batch room and their own section / group.
const roomOk = (r, u) => { if (isStaff(u)) return ROOMS.includes(r); const pl = place(u.id); return r === 'U' || (r !== '' && (r === pl.sec || r === pl.g)); };
// ---- chat attachments (any file type, optional "view once") -----------------------------
// Files are never public: they are streamed through /api/chatfile/:id after the room check.
// View once: every recipient can open it a single time; only the developer (CID) can open it again and again.
const CHAT_MAX = (+process.env.CHAT_FILE_MAX_MB || 10) * 1048576;
const INLINE_OK = /^(image\/(jpeg|png|gif|webp)|video\/(mp4|webm)|audio\/(mpeg|mp4|ogg|wav|webm)|application\/pdf)$/;
const dropMsg = row => { try { const d = JSON.parse(row.data);
  if (d.imgAsset) deleteCloudAsset(d.imgAsset).catch(e => console.warn('Cloudinary chat cleanup failed:', e.message));
  if (d.file) { if (d.file.cloud) deleteCloudAsset(d.file.cloud).catch(e => console.warn('Cloudinary chat cleanup failed:', e.message)); try { fs.unlinkSync(path.join(UP, 'm_' + row.id)); } catch {} } } catch {} };
const msgPub = (raw, u) => { const o = JSON.parse(raw), seen = o.seen || {}; delete o.seen;
  if (o.file) { o.file = { n: o.file.n, sz: o.file.sz, ty: o.file.ty }; if (o.once) { o.vw = seen[u.id] ? 1 : 0; if (u.id === CID) o.vc = Object.keys(seen).length; } }
  return o; };
async function chatUpload(req, res) {
  const U = me(req); if (!U) throw { code: 401, error: 'Please log in' };
  const q = new URL(req.url, 'http://x').searchParams, room = q.get('room') || '', t = (q.get('t') || '').trim().slice(0, 500), once = q.get('once') === '1';
  const n = (q.get('n') || 'file').replace(/[\\/\x00-\x1f]+/g, '-').slice(0, 120) || 'file';
  if (!roomOk(room, U)) throw { code: 403, error: 'Not your room' };
  const ch = req.rawBody ? [req.rawBody] : []; let sz = ch.length ? req.rawBody.length : 0; // rawBody: Firebase Functions has already read the stream
  if (!ch.length) for await (const c of req) { sz += c.length; if (sz > CHAT_MAX) { req.destroy(); throw { code: 413, error: 'Max file size is ' + Math.round(CHAT_MAX / 1048576) + ' MB' }; } ch.push(c); }
  if (sz > CHAT_MAX) throw { code: 413, error: 'Max file size is ' + Math.round(CHAT_MAX / 1048576) + ' MB' };
  const buf = Buffer.concat(ch); if (!buf.length) bad('Empty file');
  let ty = String(q.get('ty') || '').toLowerCase().slice(0, 80); if (!INLINE_OK.test(ty)) ty = 'application/octet-stream';
  const file = { n, sz: buf.length, ty };
  if (cloudinary) file.cloud = cloudAsset(await uploadCloudBuffer(buf, { resource_type: 'raw', type: 'authenticated', public_id: 'cuet-cse25/chat/' + rid() + '_' + n.replace(/[^\w.\-]+/g, '_') }));
  const mid = put('msg', U.id, { r: room, t, file, ...(once ? { once: 1, seen: {} } : {}) });
  if (!cloudinary) fs.writeFileSync(path.join(UP, 'm_' + mid), buf);
  pushAlert(U.id, 'msg', { r: room, t, img: false, fn: once ? '' : n, once }, mid); return send(res, 200, { ok: 1 });
}
async function chatDownload(req, res, id, U) {
  const row = one("SELECT id,owner,data FROM items WHERE kind='msg' AND id=?", id); if (!row) throw { code: 404, error: 'Message not found (it may have expired)' };
  const d = JSON.parse(row.data); if (!d.file) throw { code: 404, error: 'No file' }; if (!roomOk(d.r, U)) throw { code: 403, error: 'Not your room' };
  const dev = U.id === CID; let marked = false;
  if (d.once && !dev) {
    if (row.owner === U.id) throw { code: 403, error: 'You sent this view-once file. Only the people you sent it to can open it.' };
    d.seen = d.seen || {}; if (d.seen[U.id]) throw { code: 410, error: 'You already opened this view-once file' };
    d.seen[U.id] = Date.now(); run('UPDATE items SET data=? WHERE id=?', JSON.stringify(d), row.id); marked = true; // marked before any await, so two quick taps can't both succeed
  }
  let buf;
  try {
    if (d.file.cloud) { // try the signed delivery URL first, then the download API that the Resources tab already uses
      const urls = [() => cloudinary.url(d.file.cloud.publicId, { resource_type: 'raw', type: d.file.cloud.deliveryType || 'authenticated', sign_url: true, secure: true }), () => cloudPrivateUrl(d.file.cloud)]; let last = 'no url';
      for (const mk of urls) { try { const r = await fetch(mk()); if (r.ok) { buf = Buffer.from(await r.arrayBuffer()); break; } last = 'storage ' + r.status; } catch (e) { last = e.message; } }
      if (!buf) throw new Error(last); }
    else buf = fs.readFileSync(path.join(UP, 'm_' + row.id));
  } catch (e) {
    if (marked) { delete d.seen[U.id]; run('UPDATE items SET data=? WHERE id=?', JSON.stringify(d), row.id); }
    console.warn('chat file read failed:', e.message); throw { code: 502, error: 'Could not load the file. Try again.' };
  }
  const dl = new URL(req.url, 'http://x').searchParams.get('dl') === '1', inline = INLINE_OK.test(d.file.ty) && !dl;
  res.writeHead(200, { 'Content-Type': d.file.ty, 'Content-Length': buf.length, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Disposition': (inline ? 'inline' : 'attachment') + "; filename*=UTF-8''" + encodeURIComponent(d.file.n) });
  return res.end(buf);
}
async function upload(req, res) {
  const U = me(req); if (!U) throw { code: 401, error: 'Please log in' }; if (!isStaff(U)) throw { code: 403, error: 'Only the class admin can do this' };
  const q = new URL(req.url, 'http://x').searchParams, p = q.get('p') || '', n = (q.get('n') || 'file').replace(/[\\/]+/g, '-').slice(0, 120);
  if (p && !one("SELECT 1 x FROM items WHERE kind='node' AND id=?", p)) bad('Bad folder');
  const ch = []; let sz = 0; for await (const c of req) { sz += c.length; if (sz > 25e6) { req.destroy(); throw { code: 413, error: 'Max file size is 25 MB' }; } ch.push(c); }
  const buffer = Buffer.concat(ch), id = rid(), data = { t: n, ty: 'file', p, sz };
  if (cloudinary) data.cloud = cloudAsset(await uploadCloudBuffer(buffer, { resource_type: 'raw', type: 'authenticated', public_id: 'cuet-cse25/resources/' + id + '_' + n }));
  const itemId = put('node', U.id, data);
  if (!cloudinary) fs.writeFileSync(path.join(UP, itemId), buffer);
  pushAlert(U.id, 'node', data, itemId); return send(res, 200, { id: itemId });
}
async function gupload(req, res) {
  const U = me(req); if (!U) throw { code: 401, error: 'Please log in' };
  const q = new URL(req.url, 'http://x').searchParams, cap = (q.get('cap') || '').trim().slice(0, 140), al = (q.get('al') || 'General').trim().slice(0, 30) || 'General';
  const ch = []; let sz = 0; for await (const c of req) { sz += c.length; if (sz > 3e6) { req.destroy(); throw { code: 413, error: 'Photo is too large (max 3 MB)' }; } ch.push(c); }
  const buf = Buffer.concat(ch); if (buf.length < 200 || buf[0] !== 0xFF || buf[1] !== 0xD8 || buf[2] !== 0xFF) bad('Only photos (JPEG) are accepted');
  if (q.get('thumb') === '1') {
    const id = q.get('id') || '', photo = one("SELECT owner,data FROM items WHERE kind='photo' AND id=?", id);
    if (!photo || (photo.owner !== U.id && !isStaff(U))) bad('Photo not found');
    if (cloudinary && JSON.parse(photo.data).cloud) return send(res, 200, { ok: 1 });
    fs.writeFileSync(path.join(UP, id + '.thumb.jpg'), buf); return send(res, 200, { ok: 1 });
  }
  if (all_("SELECT 1 x FROM items WHERE kind='photo'").length >= 400) bad('The gallery is full. Ask an admin to delete old photos.');
  const data = { cap, al };
  if (cloudinary) data.cloud = cloudAsset(await uploadCloudBuffer(buf, { folder: 'cuet-cse25/gallery', public_id: rid(), resource_type: 'image' }));
  const id = put('photo', U.id, data); if (!cloudinary) fs.writeFileSync(path.join(UP, id), buf); return send(res, 200, { id });
}
// ---- validation -------------------------------------------------------
const FIELDS = { course: ['code', 't', 'cr', 'th', 'ty'], routine: ['d', 's', 'e', 'c', 'k', 'for'], ct: ['c', 't', 'd', 'm', 'sy', 'ty', 'for', 'tm', 'n'], cancel: ['d', 'rid', 'rm'], vac: ['t', 'f', 'to'], notice: ['t', 'b', 'd', 'for'],
  res: ['t', 'u', 'c', 'p'], project: ['t', 'c', 's', 'd', 'u'], event: ['d', 't', 'for', 'k', 's', 'e'], poll: ['q', 'o', 'cl'], fb: ['t', 'c', 'an'], node: ['t', 'p', 'ty', 'u'] };
// Only admins may change shared content (including calendar events). Students only touch their own data (attendance, profile) and may vote.
const ADMIN = new Set(['node', 'course', 'routine', 'ct', 'vac', 'notice', 'res', 'project', 'poll', 'event', 'cancel']);
const DR = /^\d{4}-\d\d-\d\d$/, TR = /^\d\d:\d\d$/;
const bad = m => { throw { code: 400, error: m }; };
const normUrl = u => { u = String(u || '').trim(); if (!/^https?:\/\//i.test(u)) u = 'https://' + u; try { return new URL(u).href; } catch { return bad('Invalid URL'); } };
// ---- test rules: theory = credits + 1 CTs; sessional = 1 quiz + 1 lab test; cancelled tests don't count. Applies to Tests items and Calendar "Test" events.
const normT = z => String(z || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const courseByTitle = t => { const n = normT(t); return all_("SELECT data FROM items WHERE kind='course'").map(r => JSON.parse(r.data)).sort((a, b) => b.code.length - a.code.length).find(c => n.includes(normT(c.code))); };
const isSess = c => c.ty ? c.ty === 'Sessional' : (c.cr < 2 || /lab|sessional/i.test(c.t));
const inferTy = (t, c) => /quiz/i.test(t) ? 'Quiz' : /lab\s*test|lab\s*final/i.test(t) ? 'Lab test' : /term\s*final|final/i.test(t) ? 'Term final' : (c && isSess(c) ? 'Quiz' : 'CT');
const ctMax = c => Math.floor(c.cr) + 1;
const testsOf = (code, ty, selfId) => { const out = []; all_("SELECT id,kind,data FROM items WHERE kind IN ('ct','event')").forEach(r => { if (r.id === selfId) return; const d = JSON.parse(r.data); if (d.x) return;
  if (r.kind === 'ct') { if (d.c === code && (d.ty || 'CT') === ty) out.push(d); } else if (d.k === 'ct') { const c = courseByTitle(d.t); if (c && c.code === code && inferTy(d.t, c) === ty) out.push(d); } }); return out; };
const checkLimit = (c, ty, selfId, restoring) => { const me = selfId && one('SELECT data FROM items WHERE id=?', selfId); if (!restoring && me && JSON.parse(me.data).x) return; const n = testsOf(c.code, ty, selfId).length;
  if (ty === 'CT') { if (n >= ctMax(c)) bad(c.code + ' has ' + c.cr + ' credits, so it gets ' + ctMax(c) + ' CTs and all ' + ctMax(c) + ' are already added'); } else if (n >= 1) bad(c.code + ' already has a ' + ty); };
const checkEventTest = (o, selfId, restoring) => { const c = courseByTitle(o.t); if (!c) return; const ty = inferTy(o.t, c), sess = isSess(c);
  if (sess && !['Quiz', 'Lab test'].includes(ty)) bad(c.code + ' is sessional: it only has one Quiz and one Lab test'); if (!sess && ['Quiz', 'Lab test'].includes(ty)) bad(c.code + ' is a theory course: quizzes and lab tests are only for sessional courses'); checkLimit(c, ty, selfId, restoring); };
function clean(kind, d, selfId) {
  const o = {};
  for (const f of FIELDS[kind]) { const v = d[f]; if (v == null) continue; o[f] = Array.isArray(v) ? v.slice(0, 8).map(x => String(x).trim().slice(0, 80)).filter(Boolean) : String(v).trim().slice(0, 400); }
  const need = (...f) => f.forEach(x => { if (!o[x]) bad('Missing field: ' + x); });
  if (kind === 'routine') { need('d', 's', 'e', 'c'); o.d = +o.d; if (!(o.d >= 0 && o.d <= 4) || !TR.test(o.s) || !TR.test(o.e) || o.e <= o.s) bad('Invalid day or time'); o.k = o.k === 'Lab' ? 'Lab' : 'Class'; }
  if (kind === 'course') { need('code', 't'); o.code = o.code.toUpperCase(); o.cr = Math.min(6, Math.max(0, +o.cr || 0)); o.th = o.th || ''; o.ty = o.ty === 'Sessional' ? 'Sessional' : 'Theory'; }
  if (kind === 'ct') { need('c', 't', 'd'); if (!DR.test(o.d)) bad('Invalid date'); o.m = o.m || ''; o.done = 0; o.tm = TR.test(o.tm || '') ? o.tm : ''; }
  if (kind === 'cancel') { need('d', 'rid'); if (!DR.test(o.d)) bad('Invalid date');
    const rr = one("SELECT data FROM items WHERE kind='routine' AND id=?", o.rid); if (!rr) bad('Unknown class');
    const ro = JSON.parse(rr.data); if (new Date(o.d + 'T00:00:00Z').getUTCDay() !== +ro.d) bad('That class does not meet on this date');
    o.rm = o.rm === '1' || o.rm === 'true' || o.rm === 1 ? 1 : 0;
    const dup = all_("SELECT id,data FROM items WHERE kind='cancel'").find(x => { const y = JSON.parse(x.data); return y.rid === o.rid && y.d === o.d; });
    if (dup) { if (o.rm && !JSON.parse(dup.data).rm) o.__upg = dup.id; else bad('Already cancelled'); }
    o.c = ro.c; o.s = ro.s; o.e = ro.e; o.k = ro.k || 'Class'; o.for = ro.for || 'All'; }
  if (kind === 'vac') { need('t', 'f', 'to'); if (!DR.test(o.f) || !DR.test(o.to) || o.to < o.f) bad('Invalid dates'); }
  if (kind === 'notice') { need('t', 'b'); if (!DR.test(o.d || '')) o.d = new Date().toISOString().slice(0, 10); o.pin = 0; }
  if (kind === 'res') { need('t', 'u'); o.u = normUrl(o.u); o.c = o.c || ''; }
  if (kind === 'project') { need('t', 'c', 's'); o.u = o.u ? normUrl(o.u) : ''; o.d = o.d || ''; o.y = String(new Date().getFullYear()); }
  if (kind === 'event') { need('d', 't'); if (!DR.test(o.d)) bad('Invalid date'); o.sh = 1; o.k = ['class', 'sess', 'ct', 'ev', 'hol'].includes(o.k) ? o.k : 'ev'; if (o.s && !TR.test(o.s)) bad('Invalid start time'); if (o.e && !TR.test(o.e)) bad('Invalid end time'); if (o.s && o.e && o.e <= o.s) bad('End time must be after start'); if (o.k === 'hol') { o.s = ''; o.e = ''; } if (o.k === 'ct') checkEventTest(o, selfId); }
  if (kind === 'poll') { need('q'); if (!o.o || o.o.length < 2) bad('A poll needs at least 2 options'); }
  if (kind === 'ct') { // CT and Term final -> theory courses; Quiz -> sessional courses. One Quiz per sessional, one Term final per theory.
    const cr = all_("SELECT data FROM items WHERE kind='course'").map(r => JSON.parse(r.data)).find(c => c.code === o.c.toUpperCase() || c.code === o.c); if (!cr) bad('Unknown course');
    const sess = cr.ty ? cr.ty === 'Sessional' : (cr.cr < 2 || /lab|sessional/i.test(cr.t)), ty = ['Quiz', 'Lab test', 'Term final'].includes(o.ty) ? o.ty : 'CT';
    if (sess && !['Quiz', 'Lab test'].includes(ty)) bad('Sessional courses only have a Quiz and Lab tests'); if (!sess && ['Quiz', 'Lab test'].includes(ty)) bad('Quizzes and lab tests are only for sessional courses');
    o.c = cr.code; o.ty = ty; checkLimit(cr, ty, selfId);
    // CT number: 1..max (credits + 1); blank = lowest free number
    if (ty !== 'CT') o.n = ''; else { const max = ctMax(cr), used = testsOf(cr.code, 'CT', selfId).map(d => +d.n || 0), nn = Math.floor(+o.n);
      if (nn >= 1 && nn <= max) o.n = String(nn); else { let f = 1; while (used.includes(f)) f++; o.n = String(Math.min(max, f)); } } }
  if (kind === 'node') { need('t'); o.t = o.t.replace(/[\\/]+/g, '-'); o.ty = o.ty === 'link' ? 'link' : 'folder'; o.p = o.p || ''; if (o.p && !one("SELECT 1 x FROM items WHERE kind='node' AND id=?", o.p)) bad('Bad folder'); if (o.ty === 'link') { need('u'); o.u = normUrl(o.u); } o.sz = 0; }
  if (kind === 'res') o.p = o.p || '';
  if (kind === 'poll') o.cl = Math.min(168, Math.max(1, +o.cl || 24));
  if (kind === 'fb') { need('t'); o.c = ['Suggestion', 'Bug', 'Request', 'Praise', 'Other'].includes(o.c) ? o.c : 'Other'; o.an = o.an === '1' || o.an === 'on' ? 1 : 0; }
  if (['routine', 'ct', 'notice', 'event'].includes(kind)) o.for = ['A', 'B', 'A1', 'A2', 'B1', 'B2'].includes(o.for) ? o.for : 'All';
  return o;
}

// ---- auth ---------------------------------------------------------------
const hash = (p, s = crypto.randomBytes(16).toString('hex')) => s + ':' + crypto.scryptSync(p, s, 32).toString('hex');
const verify = (p, h) => { try { const [s, x] = String(h || '').split(':'); if (!s || !/^[0-9a-f]{64}$/i.test(x || '')) return false; return crypto.timingSafeEqual(Buffer.from(hash(p, s).split(':')[1], 'hex'), Buffer.from(x, 'hex')); } catch { return false; } };
const tries = new Map(), regTries = new Map();
function regThrottle(ip) { const t = regTries.get(ip) || { n: 0, at: Date.now() }; if (Date.now() - t.at > 36e5) { t.n = 0; t.at = Date.now(); } regTries.set(ip, t); if (t.n >= 30) throw { code: 429, error: 'Too many sign-ups from this network. Try again later.' }; t.n++; }
function throttle(ip) { const t = tries.get(ip) || { n: 0, at: Date.now() }; if (Date.now() - t.at > 3e5) { t.n = 0; t.at = Date.now(); } tries.set(ip, t); if (t.n >= 10) throw { code: 429, error: 'Too many attempts. Try again in a few minutes.' }; return t; }
const cookieOf = (req, k) => (req.headers.cookie || '').split(';').map(s => s.trim().split('=')).find(x => x[0] === k)?.[1];
const me = req => { const t = cookieOf(req, 'sid'), u = t ? one('SELECT u.* FROM sessions s JOIN users u ON u.id=s.uid WHERE s.token=? AND s.exp>?', t, Date.now()) : null; return u && inRange(u.id) ? u : null; };
function startSession(req, res, uid) {
  const t = crypto.randomBytes(24).toString('hex'), days = 7;
  run('DELETE FROM sessions WHERE exp<?', Date.now()); run('INSERT INTO sessions VALUES(?,?,?)', t, uid, Date.now() + days * 864e5);
  res.setHeader('Set-Cookie', `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${days * 86400}` + (req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : ''));
}

// ---- state sent to the dashboard ---------------------------------------------
function state(u) {
  const expiredMsgs = all_("SELECT id,data FROM items WHERE kind='msg' AND ts<?", Date.now() - 6048e5);
  expiredMsgs.forEach(dropMsg);
  run("DELETE FROM items WHERE kind='msg' AND ts<?", Date.now() - 6048e5);
  all_("SELECT id,data,ts FROM items WHERE kind='poll'").forEach(r => { if (Date.now() > r.ts + ((+JSON.parse(r.data).cl || 24) + 72) * 36e5) { run('DELETE FROM items WHERE id=?', r.id); run('DELETE FROM votes WHERE poll=?', r.id); } });
  const items = all_("SELECT * FROM items WHERE kind NOT IN ('msg','rd') ORDER BY ts,rowid").map(r => ({ id: r.id, kind: r.kind, owner: r.owner, ts: r.ts, ...JSON.parse(r.data) }));
  const of = k => items.filter(x => x.kind === k), st = of('settings')[0] || {}, pr = JSON.parse(u.profile || '{}');
  const names = Object.fromEntries(all_('SELECT id,name FROM users').map(x => [x.id, x.name])), att = of('att').filter(a => a.owner === u.id), votes = all_('SELECT * FROM votes');
  const cu = one('SELECT id,name,profile FROM users WHERE id=?', CID), cp = cu ? JSON.parse(cu.profile || '{}') : {};
  const creator = { id: CID, name: cu ? cu.name : '', reg: !!cu, ...place(CID), photo: cp.photo || devFallbackPhoto(), fb: cp.fb || '', ig: cp.ig || '', li: cp.li || '', ot: cp.ot || '', school: cp.school || '', college: cp.college || '', dist: cp.dist || '', town: cp.town || '' };
  const rdRow = all_("SELECT data FROM items WHERE kind='rd' AND owner=?", u.id)[0], rdd = rdRow ? JSON.parse(rdRow.data) : null;
  return { creator, role: isStaff(u) ? 'admin' : 'student', isCreator: u.id === CID, tier: { ...flags(u.id === CID ? mkRole(true, flags(u.role).cr) : u.role) }, read: rdd ? { set: 1, base: rdd.base, ids: rdd.ids } : { set: 0, base: 0, ids: {} }, ...place(u.id), users: all_('SELECT id,name,role,profile FROM users ORDER BY id').map(x => { const q = JSON.parse(x.profile || '{}'); const fl = flags(x.id === CID ? mkRole(true, flags(x.role).cr) : x.role); return { id: x.id, name: x.name, role: x.id === CID || x.role !== 'student' ? 'admin' : 'student', adm: fl.adm, cr: fl.cr, ...place(x.id), fb: q.fb || '', school: q.school || '', college: q.college || '', dist: q.dist || '', town: q.town || '', ...(q.photo ? { ph: crypto.createHash('sha1').update(q.photo).digest('hex').slice(0, 8) } : {}) }; }), profile: { ...pr, name: u.name, email: pr.email || '', phone: pr.phone || '', blood: pr.blood || '', term: st.term || '', aEnd: st.aEnd || 66, bEnd: st.bEnd || 132, ss: st.ss || '', se: st.se || '' },
    courses: of('course').map(c => { const a = att.find(x => x.c === c.id) || {}; return { id: c.id, code: c.code, t: c.t, cr: c.cr, th: c.th, ty: c.ty || '', p: a.p || 0, h: a.h || 0 }; }),
    routine: of('routine'), nodes: of('node'), marks: of('mark').filter(m => m.owner === u.id), fb: isStaff(u) ? of('fb').map(f => ({ ...f, by: f.an ? 'Anonymous' : (names[f.owner] || f.owner), ...(f.an && u.id === CID ? { real: (names[f.owner] || '') + ' (' + f.owner + ')' } : {}), owner: undefined })) : [],
    gallery: of('photo').map(g => ({ id: g.id, ts: g.ts, cap: g.cap || '', al: g.al || 'General', by: names[g.owner] || g.owner, mine: g.owner === u.id })), cts: of('ct'), cancels: of('cancel'), res: of('res'), vac: of('vac'), notices: of('notice'), events: of('event').filter(e => e.sh || e.owner === u.id),
    projects: of('project').map(p => ({ ...p, a: p.a || names[p.owner] || '—' })),
    chat: (() => { const pl = place(u.id), rooms = isStaff(u) ? ROOMS : ['U', pl.sec, pl.g].filter(Boolean); // newest chat messages from others, shown in Alerts
      return all_("SELECT id,owner,data,ts FROM items WHERE kind='msg' AND owner<>? AND ts>? ORDER BY ts DESC LIMIT 150", u.id, Date.now() - 3 * 864e5).map(r => ({ r, d: JSON.parse(r.data) })).filter(x => rooms.includes(x.d.r)).slice(0, 15)
        .map(x => ({ id: x.r.id, ts: x.r.ts, r: x.d.r, n: names[x.r.owner] || x.r.owner, t: x.d.once ? 'View-once file' : x.d.file ? 'File: ' + x.d.file.n : x.d.img ? 'Photo' : String(x.d.t || '').slice(0, 90), c: x.d.t && (x.d.file || x.d.img) && !x.d.once ? String(x.d.t).slice(0, 60) : '' })); })(),
    polls: of('poll').map(p => { const vs = votes.filter(v => v.poll === p.id), mine = vs.find(v => v.uid === u.id); return { id: p.id, ow: p.owner, q: p.q, ts: p.ts, cl: p.cl || 24, o: p.o.map((t, i) => ({ t, v: vs.filter(v => v.opt === i).length })), my: mine ? mine.opt : -1 }; }) };
}

// ---- API ------------------------------------------------------------------
const send = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const readBody = req => new Promise((ok, no) => { let s = ''; req.on('data', c => { s += c; if (s.length > 3e5) { req.destroy(); no({ code: 413, error: 'Too large' }); } }); req.on('end', () => { try { ok(s ? JSON.parse(s) : {}); } catch { no({ code: 400, error: 'Bad JSON' }); } }); });

async function api(req, res, m, p) {
  if (m === 'PUT' && p === '/api/up') return upload(req, res);
  if (m === 'PUT' && p === '/api/gup') return gupload(req, res);
  if (m === 'PUT' && p === '/api/chatfile') return chatUpload(req, res);
  let b = {};
  if (m !== 'GET') { if (!/application\/json/.test(req.headers['content-type'] || '')) bad('JSON only'); b = await readBody(req); }
  const U = me(req), auth = () => { if (!U) throw { code: 401, error: 'Please log in' }; return U; };
  const admin = () => { if (!isStaff(auth())) throw { code: 403, error: 'Only the class admin can do this' }; };
  const ip = String(req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress; // behind a host's proxy, use the client address it appends
  let x;

  if (m === 'GET' && p === '/api/students') return send(res, 200, all_('SELECT id,name,profile FROM users ORDER BY id').map(u => { const ph = (JSON.parse(u.profile || '{}').photo || ''); return { n: u.name, r: u.id, ...place(u.id), ...(ph ? { ph: crypto.createHash('sha1').update(ph).digest('hex').slice(0, 8) } : {}) }; }));
  if (m === 'GET' && p.startsWith('/api/avatar/')) {
    const t = one('SELECT id,profile FROM users WHERE id=?', decodeURIComponent(p.slice('/api/avatar/'.length))); if (!t || !inRange(t.id)) throw { code: 404, error: 'Not found' };
    const ph = JSON.parse(t.profile || '{}').photo || '', cache = 'public, max-age=86400';
    if (/^https:\/\//.test(ph)) { res.writeHead(302, { Location: ph, 'Cache-Control': cache }); return res.end(); }
    const mm = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+\/=]+)$/.exec(ph); if (!mm) throw { code: 404, error: 'No photo' };
    res.writeHead(200, { 'Content-Type': mm[1], 'Cache-Control': cache }); return res.end(Buffer.from(mm[2], 'base64'));
  }
  if (m === 'GET' && p.startsWith('/api/public/user/')) {
    const pid = decodeURIComponent(p.slice('/api/public/user/'.length)), t = one('SELECT id,name,profile FROM users WHERE id=?', pid); if (!t || !inRange(t.id)) throw { code: 404, error: 'Not found' };
    const q = JSON.parse(t.profile || '{}');
    return send(res, 200, { id: t.id, name: t.name, ...place(t.id), photo: q.photo || '', fb: q.fb || '', ig: q.ig || '', li: q.li || '', school: q.school || '', college: q.college || '', dist: q.dist || '', town: q.town || '', email: q.email || '', phone: q.phone || '' }); }

  // public developer card (site developer = roll CID). Email/phone come from the developer's Profile; env vars or the defaults below fill in if the Profile is empty.
  if (m === 'GET' && p === '/api/developer') {
    const t = one('SELECT id,name,profile FROM users WHERE id=?', CID), q = t ? JSON.parse(t.profile || '{}') : {}, ph = q.photo || '';
    return send(res, 200, { id: CID, name: (t && t.name) || '', ...place(CID), photo: ph ? '/api/avatar/' + CID + '?v=' + crypto.createHash('sha1').update(ph).digest('hex').slice(0, 8)   : devFallbackPhoto(), fb: q.fb || '', ig: q.ig || '', li: q.li || '', ot: q.ot || '', school: q.school || '', college: q.college || '', dist: q.dist || '', town: q.town || '', email: q.email || process.env.DEVELOPER_EMAIL || 'u2504081@student.cuet.ac.bd', phone: q.phone || process.env.DEVELOPER_PHONE || '' }); }

  if (m === 'GET' && p === '/api/projects') { const names = Object.fromEntries(all_('SELECT id,name FROM users').map(u => [u.id, u.name]));
    return send(res, 200, all_("SELECT * FROM items WHERE kind='project' ORDER BY ts,rowid").map(r => { const d = JSON.parse(r.data); return { t: d.t, c: d.c, s: d.s, d: d.d, y: d.y, u: d.u || '', a: d.a || names[r.owner] || '—' }; })); }
  if (m === 'GET' && p === '/api/gallery') { const viewer = me(req); return send(res, 200, all_("SELECT * FROM items WHERE kind='photo' ORDER BY ts DESC,rowid DESC").map(r => { const d = JSON.parse(r.data); return { id: r.id, cap: d.cap || '', al: d.al || 'General', ts: r.ts, canThumb: !!viewer && (r.owner === viewer.id || isStaff(viewer)) }; })); }
  if (m === 'GET' && p === '/api/me') { if (!U) return send(res, 401, { error: 'Not logged in' }); const pr = JSON.parse(U.profile || '{}'); return send(res, 200, { id: U.id, name: U.name, role: isStaff(U) ? 'admin' : 'student', photo: pr.photo || '' }); }
  if (m === 'GET' && p === '/api/push/key') return send(res, 200, { key: vapid.publicKey });
  if (m === 'GET' && p === '/api/push/preferences') return send(res, 200, pushPreferences(auth().id));
  if (m === 'PUT' && p === '/api/push/preferences') {
    const u = auth(), current = pushPreferences(u.id), next = { ...current };
    for (const k of Object.keys(PUSH_DEFAULTS)) if (k in b) { if (typeof b[k] !== 'boolean') bad('Notification preferences must be boolean'); next[k] = b[k]; }
    run('INSERT INTO push_preferences(uid,data) VALUES(?,?) ON CONFLICT(uid) DO UPDATE SET data=excluded.data', u.id, JSON.stringify(next));
    return send(res, 200, next);
  }
  if (m === 'POST' && p === '/api/push/subscribe') {
    const u = auth(), s = b.subscription || b;
    let endpoint; try { endpoint = new URL(String(s.endpoint || '')); } catch { bad('Invalid push endpoint'); }
    if (endpoint.protocol !== 'https:' || !s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') bad('Invalid push subscription');
    const data = JSON.stringify({ endpoint: endpoint.href, expirationTime: s.expirationTime || null, keys: { p256dh: s.keys.p256dh.slice(0, 200), auth: s.keys.auth.slice(0, 100) } });
    run('INSERT INTO push_subscriptions(endpoint,uid,data,created) VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET uid=excluded.uid,data=excluded.data', endpoint.href, u.id, data, Date.now());
    return send(res, 200, { ok: 1 });
  }
  if (m === 'POST' && p === '/api/push/test') {
    const u = auth(), subs = all_('SELECT endpoint,data FROM push_subscriptions WHERE uid=?', u.id);
    if (!subs.length) throw { code: 409, error: 'This device is not subscribed yet. Tap the bell to enable push alerts.' };
    const payload = JSON.stringify({ title: 'CUET CSE 25 test alert', body: 'Push notifications are working on this device.', url: '/' });
    const results = await Promise.allSettled(subs.map(s => webpush.sendNotification(JSON.parse(s.data), payload, { TTL: 60 })));
    results.forEach((r, i) => { if (r.status === 'rejected' && (r.reason.statusCode === 404 || r.reason.statusCode === 410)) run('DELETE FROM push_subscriptions WHERE endpoint=?', subs[i].endpoint); });
    if (results.every(r => r.status === 'rejected')) {
      const statuses = [...new Set(results.map(r => r.reason.statusCode || 'network error'))].join(', ');
      const authFailure = results.some(r => [401, 403].includes(r.reason.statusCode));
      throw { code: 502, error: authFailure ? `Push service rejected the server key (HTTP ${statuses}). Re-enable push after the server VAPID keys are made persistent.` : `Push service rejected delivery (HTTP ${statuses}). Re-enable push alerts on this device.` };
    }
    return send(res, 200, { ok: 1 });
  }
  if (m === 'DELETE' && p === '/api/push/subscribe') { const u = auth(); run('DELETE FROM push_subscriptions WHERE endpoint=? AND uid=?', String(b.endpoint || ''), u.id); return send(res, 200, { ok: 1 }); }

  if (m === 'POST' && (p === '/api/register' || p === '/api/login')) {
    const t = throttle(ip), id = String(b.id || '').trim(), pw = String(b.password || '');
    if (p === '/api/register') {
      regThrottle(ip);
      if (!/^[A-Za-z0-9_-]{3,20}$/.test(id)) bad('ID must be 3-20 letters, digits, - or _');
      if (pw.length < 8) bad('Password must be at least 8 characters');
      if (!inRange(id)) bad('Only roll numbers 2504001 to 2504132 can register');
      if (one('SELECT 1 x FROM users WHERE id=?', id)) throw { code: 409, error: 'That ID is already registered' };
      run('INSERT INTO users(id,name,pw,role) VALUES(?,?,?,?)', id, String(b.name || id).trim().slice(0, 60) || id, hash(pw), id === CID ? 'admin' : 'student');
    } else { if (!inRange(id)) { t.n++; throw { code: 401, error: 'Only roll numbers 2504001 to 2504132 can log in' }; } const u = one('SELECT * FROM users WHERE id=?', id); if (!u || !verify(pw, u.pw)) { t.n++; throw { code: 401, error: 'Wrong ID or password' }; } }
    startSession(req, res, id); const u = one('SELECT * FROM users WHERE id=?', id); return send(res, 200, { id: u.id, name: u.name, role: isStaff(u) ? 'admin' : 'student' });
  }
  if (m === 'POST' && p === '/api/logout') { const t = cookieOf(req, 'sid'); if (t) run('DELETE FROM sessions WHERE token=?', t); res.setHeader('Set-Cookie', 'sid=; Max-Age=0; Path=/'); return send(res, 200, { ok: 1 }); }

  if (m === 'GET' && p === '/api/state') return send(res, 200, state(auth()));
  if (m === 'PUT' && p === '/api/profile') {
    const u = auth(), pr = { ...JSON.parse(u.profile || '{}'), email: String(b.email || '').slice(0, 80), phone: String(b.phone || '').slice(0, 30), blood: String(b.blood || '').slice(0, 3) };
    run('UPDATE users SET name=?,profile=? WHERE id=?', String(b.name || '').trim().slice(0, 60) || u.name, JSON.stringify(pr), u.id);
    if (isStaff(u)) { const patch = {}; if ('term' in b) patch.term = String(b.term || '').slice(0, 30);
      if (DR.test(b.ss || '') && DR.test(b.se || '')) { if (b.se <= b.ss) bad('Session end must be after start'); patch.ss = b.ss; patch.se = b.se; }
      if (b.aEnd || b.bEnd) { const a = +b.aEnd || settings().aEnd || 66, e = +b.bEnd || settings().bEnd || 132; if (!(a >= 1 && e > a && e <= 999)) bad('Section A end must be below Section B end (max 999)'); patch.aEnd = a; patch.bEnd = e; }
      if (Object.keys(patch).length) { const s = one("SELECT id FROM items WHERE kind='settings'"); run('UPDATE items SET data=? WHERE id=?', JSON.stringify({ ...settings(), ...patch }), s.id); } }
    return send(res, 200, { ok: 1 });
  }
  if (m === 'POST' && p === '/api/att') {
    const u = auth(), c = one("SELECT id FROM items WHERE kind='course' AND id=?", String(b.c)); if (!c) bad('Unknown course');
    const row = all_("SELECT * FROM items WHERE kind='att' AND owner=?", u.id).find(r => JSON.parse(r.data).c === c.id), d = row ? JSON.parse(row.data) : { c: c.id, p: 0, h: 0 };
    if (b.k === 'z') d.p = d.h = 0; else { d.h++; if (b.k === 'p') d.p++; }
    row ? run('UPDATE items SET data=? WHERE id=?', JSON.stringify(d), row.id) : put('att', u.id, d); return send(res, 200, { ok: 1 });
  }
  if (m === 'POST' && p === '/api/vote') {
    const u = auth(), row = one("SELECT * FROM items WHERE kind='poll' AND id=?", String(b.poll)), opt = +b.opt; if (!row) bad('Unknown poll'); if (Date.now() > row.ts + (+JSON.parse(row.data).cl || 24) * 36e5) bad('This poll has closed');
    if (!(opt >= 0 && opt < JSON.parse(row.data).o.length)) bad('Bad option');
    const cur = one('SELECT opt FROM votes WHERE poll=? AND uid=?', row.id, u.id);
    cur && cur.opt === opt ? run('DELETE FROM votes WHERE poll=? AND uid=?', row.id, u.id) : run('INSERT OR REPLACE INTO votes VALUES(?,?,?)', row.id, u.id, opt); return send(res, 200, { ok: 1 });
  }
  if (m === 'POST' && p === '/api/role') { // only the creator assigns admins and CRs
    if (auth().id !== CID) throw { code: 403, error: 'Only the site developer can change roles' };
    const t = one('SELECT id,role FROM users WHERE id=?', String(b.id)); if (!t) bad('Unknown user'); const f = flags(t.role);
    const adm = t.id === CID ? true : 'adm' in b ? !!b.adm : f.adm, cr = 'cr' in b ? !!b.cr : f.cr;
    run('UPDATE users SET role=? WHERE id=?', mkRole(adm, cr), t.id); return send(res, 200, { ok: 1 });
  }
  if (m === 'POST' && p === '/api/alertread') { // per-account read marks, so the alert number is the same on every device
    const u = auth(), row = all_("SELECT id,data FROM items WHERE kind='rd' AND owner=?", u.id)[0], d = row ? JSON.parse(row.data) : { base: Date.now() - 3 * 864e5, ids: {} };
    if (b.base && !row && +b.base > 0) d.base = Math.min(Date.now(), +b.base);
    const ok = i => /^\w{1,40}$/.test(String(i));
    if (b.imp && typeof b.imp === 'object') Object.keys(b.imp).filter(ok).slice(0, 400).forEach(k => d.ids[k] = 1);
    if (Array.isArray(b.read)) b.read.filter(ok).slice(0, 400).forEach(k => d.ids[k] = 1);
    if (Array.isArray(b.unread)) b.unread.filter(ok).forEach(k => delete d.ids[k]);
    const keys = Object.keys(d.ids); if (keys.length > 600) keys.slice(0, keys.length - 600).forEach(k => delete d.ids[k]);
    row ? run('UPDATE items SET data=? WHERE id=?', JSON.stringify(d), row.id) : put('rd', u.id, d); return send(res, 200, { ok: 1 });
  }
  if (m === 'GET' && (x = p.match(/^\/api\/photo\/(\w+)(?:\/(thumb))?$/))) { const g = one("SELECT id,data FROM items WHERE kind='photo' AND id=?", x[1]); if (!g) throw { code: 404, error: 'Not found' };
    const asset = JSON.parse(g.data).cloud;
    if (asset?.secureUrl) { const url = x[2] ? asset.secureUrl.replace('/upload/','/upload/c_limit,w_360,h_360,q_auto,f_auto/') : asset.secureUrl; res.writeHead(302, { Location: url, 'Cache-Control': 'public, max-age=3600' }); return res.end(); }
    if (!fs.existsSync(path.join(UP, g.id))) throw { code: 404, error: 'Not found' };
    const thumb = x[2] && fs.existsSync(path.join(UP, g.id + '.thumb.jpg')), file = thumb ? path.join(UP, g.id + '.thumb.jpg') : path.join(UP, g.id);
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': thumb ? 'public, max-age=604800, immutable' : x[2] ? 'no-store' : 'public, max-age=86400' }); return fs.createReadStream(file).pipe(res); }
  if (m === 'POST' && p === '/api/official') { admin(); loadOfficial(); return send(res, 200, { ok: 1 }); }
  if (m === 'PUT' && p === '/api/profile2') { const u = auth(), pr = JSON.parse(u.profile || '{}'), L = { dob: 10, fb: 200, ig: 200, li: 200, ot: 200, dist: 40, town: 80, school: 80, college: 80 };
    for (const k in L) if (k in b) pr[k] = String(b[k] || '').trim().slice(0, L[k]);
  if ('photo' in b) {
    const photo = String(b.photo || '');
    if (cloudinary && /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(photo) && photo.length < 2.5e5) {
      const old = pr.photoAsset, result = await uploadCloudBuffer(Buffer.from(photo.slice(photo.indexOf(',') + 1), 'base64'), { folder: 'cuet-cse25/profiles', public_id: u.id, overwrite: true, resource_type: 'image' });
      pr.photo = result.secure_url; pr.photoAsset = cloudAsset(result); if (old?.publicId && old.publicId !== pr.photoAsset.publicId) await deleteCloudAsset(old);
    } else { pr.photo = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+\/=]+$/.test(photo) && photo.length < 2.5e5 ? photo : ''; delete pr.photoAsset; }
  }
    run('UPDATE users SET profile=? WHERE id=?', JSON.stringify(pr), u.id); return send(res, 200, { ok: 1 }); }
  if (m === 'POST' && p === '/api/password') { const u = auth(), pw = String(b.n || ''); if (!verify(String(b.o || ''), u.pw)) bad('Current password is wrong'); if (pw.length < 8) bad('New password needs 8+ characters'); run('UPDATE users SET pw=? WHERE id=?', hash(pw), u.id); return send(res, 200, { ok: 1 }); }
  if (m === 'POST' && p === '/api/resetpw') { // admin resets a student's password to a one-time temporary one; admins reset students only, the developer resets anyone but themselves
    const u = auth(); if (u.id !== CID && !flags(u.role).adm) throw { code: 403, error: 'Only an admin can reset passwords' };
    const t = one('SELECT id,role FROM users WHERE id=?', String(b.id || '')); if (!t) bad('Unknown user');
    if (t.id === u.id) bad('Change your own password from your profile');
    if (u.id !== CID && (t.id === CID || flags(t.role).adm)) throw { code: 403, error: 'Only the site developer can reset an admin\'s password' };
    const A = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789', temp = Array.from(crypto.randomBytes(10), c => A[c % A.length]).join('');
    run('UPDATE users SET pw=? WHERE id=?', hash(temp), t.id); run('DELETE FROM sessions WHERE uid=?', t.id);
    return send(res, 200, { ok: 1, id: t.id, temp });
  }
  if (m === 'POST' && p === '/api/mark') { const u = auth(), c = one("SELECT id FROM items WHERE kind IN ('ct','event') AND id=?", String(b.ct)); if (!c) bad('Unknown test'); const v = String(b.v ?? '').trim().slice(0, 6); if (v !== '' && !(+v >= 0)) bad('Marks must be a number');
    let owner = u.id; const want = String(b.uid || '').trim(); if (want && want !== u.id) { if (!isStaff(u)) throw { code: 403, error: 'Only the class admin can add marks for others' }; if (!one('SELECT 1 x FROM users WHERE id=?', want)) bad('No student with ID ' + want); owner = want; }
    all_("SELECT id,data FROM items WHERE kind='mark' AND owner=?", owner).filter(r => JSON.parse(r.data).ct === c.id).forEach(r => run('DELETE FROM items WHERE id=?', r.id)); if (v !== '') put('mark', owner, { ct: c.id, v }); return send(res, 200, { ok: 1 }); }
  if (m === 'GET' && (x = p.match(/^\/api\/chatfile\/(\w+)$/))) return chatDownload(req, res, x[1], auth());
  if (m === 'GET' && (x = p.match(/^\/api\/chat\/(\w+)$/))) { const u = auth(), r = x[1]; if (!roomOk(r, u)) throw { code: 403, error: 'Not your room' };
    all_("SELECT id,data FROM items WHERE kind='msg' AND ts<?", Date.now() - 6048e5).forEach(dropMsg); run("DELETE FROM items WHERE kind='msg' AND ts<?", Date.now() - 6048e5); const nm = Object.fromEntries(all_('SELECT id,name FROM users').map(y => [y.id, y.name])), ad = Object.fromEntries(all_('SELECT id,role FROM users').map(y => [y.id, y.id === CID ? 'admin' : y.role === 'student' ? '' : /admin/.test(y.role) ? 'admin' : 'cr']));
    return send(res, 200, all_("SELECT * FROM items WHERE kind='msg' ORDER BY ts DESC LIMIT 400").map(y => ({ ...msgPub(y.data, u), id: y.id, ts: y.ts, u: y.owner, n: nm[y.owner] || y.owner, a: ad[y.owner] || '' })).filter(y => y.r === r).slice(0, 80).reverse()); }
  if (m === 'POST' && p === '/api/chat') { const u = auth(), r = String(b.room), t = String(b.t || '').trim().slice(0, 500); let img = /^data:image\/jpeg;base64,[A-Za-z0-9+\/=]+$/.test(b.img || '') && b.img.length < 2e5 ? b.img : '', imgAsset;
    if (!roomOk(r, u)) throw { code: 403, error: 'Not your room' }; if (!t && !img) bad('Empty message');
    if (cloudinary && img) { const result = await uploadCloudBuffer(Buffer.from(img.slice(img.indexOf(',') + 1), 'base64'), { folder: 'cuet-cse25/chat', resource_type: 'image' }); imgAsset = cloudAsset(result); img = result.secure_url; }
    const mid = put('msg', u.id, { r, t, img, ...(imgAsset ? { imgAsset } : {}) }); pushAlert(u.id, 'msg', { r, t, img: !!img }, mid); return send(res, 200, { ok: 1 }); }
  if (m === 'POST' && p === '/api/chatclear') { admin(); const r = String(b.room); if (!ROOMS.includes(r)) bad('Unknown room'); for (const y of all_("SELECT id,data FROM items WHERE kind='msg'")) if (JSON.parse(y.data).r === r) { dropMsg(y); run('DELETE FROM items WHERE id=?', y.id); } return send(res, 200, { ok: 1 }); }
  if (m === 'GET' && (x = p.match(/^\/api\/user\/([A-Za-z0-9_-]+)$/))) { const u = auth(), t = one('SELECT id,name,role,profile FROM users WHERE id=?', x[1]); if (!t) throw { code: 404, error: 'Not found' }; const q = JSON.parse(t.profile || '{}'), priv = isStaff(u) || u.id === t.id;
    const fl = flags(t.id === CID ? mkRole(true, flags(t.role).cr) : t.role); return send(res, 200, { id: t.id, name: t.name, role: t.id === CID || t.role !== 'student' ? 'admin' : 'student', adm: fl.adm, cr: fl.cr, creator: t.id === CID, ...place(t.id), photo: q.photo || '', fb: q.fb || '', ig: q.ig || '', li: q.li || '', ot: q.ot || '', school: q.school || '', college: q.college || '', dist: q.dist || '', town: q.town || '', bday: /^\d{4}-\d\d-\d\d$/.test(q.dob || '') ? q.dob.slice(5) : '', ...(priv ? { email: q.email || '', phone: q.phone || '', blood: q.blood || '' } : {}) }); }
  if (m === 'GET' && (x = p.match(/^\/api\/dl\/(\w+)$/))) { auth(); const ns = nodes(), n = ns.find(y => y.id === x[1]); if (!n || n.ty === 'link') throw { code: 404, error: 'Not found' };
    if (n.ty === 'file') { res.setHeader('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(n.t));
      if (n.cloud) { res.writeHead(302, { Location: cloudPrivateUrl(n.cloud, true), 'Cache-Control': 'private, no-store' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return fs.createReadStream(path.join(UP, n.id)).pipe(res); }
    const es = [{ name: n.t + '/' }], walk = (id, pre) => ns.filter(y => y.p === id).forEach(y => { if (y.ty === 'folder') { es.push({ name: pre + y.t + '/' }); walk(y.id, pre + y.t + '/'); } else if (y.ty === 'file') es.push({ name: pre + y.t, id: y.id }); }); walk(n.id, n.t + '/');
    res.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(n.t) + '.zip' }); return res.end(await zip(es)); }
  if (m === 'GET' && p === '/api/directory') { auth(); return send(res, 200, all_('SELECT id,name,profile FROM users ORDER BY id').map(y => { const q = JSON.parse(y.profile || '{}'); return { id: y.id, n: y.name, ...place(y.id), fb: q.fb || '', school: q.school || '', college: q.college || '', dist: q.dist || '', town: q.town || '' }; })); }
  if (m === 'POST' && (x = p.match(/^\/api\/(\w+)$/)) && FIELDS[x[1]]) {
    const kind = x[1], u = auth(); if (ADMIN.has(kind)) admin(); const d = clean(kind, b);
    if (d.__upg) { const rw = one('SELECT data FROM items WHERE id=?', d.__upg), y = JSON.parse(rw.data); y.rm = 1; run('UPDATE items SET data=? WHERE id=?', JSON.stringify(y), d.__upg); return send(res, 200, { id: d.__upg }); }
    if (kind === 'course' && all_("SELECT data FROM items WHERE kind='course'").some(r => JSON.parse(r.data).code === d.code)) throw { code: 409, error: 'Course already exists' };
    const id = put(kind, u.id, d); pushAlert(u.id, kind, d, id); return send(res, 200, { id });
  }
  if ((m === 'PATCH' || m === 'PUT' || m === 'DELETE') && (x = p.match(/^\/api\/items\/(\w+)$/))) {
    const u = auth(), row = one('SELECT * FROM items WHERE id=?', x[1]); if (!row) throw { code: 404, error: 'Not found' };
    if (m === 'PUT') { admin(); if (!['event', 'ct', 'vac', 'routine'].includes(row.kind)) bad('Not editable'); const old = JSON.parse(row.data), o = clean(row.kind, { ...old, ...b }, row.id), nd = { ...old, ...o };
      if (row.kind === 'ct') nd.done = old.done || 0; if (row.kind === 'event') nd.sh = old.sh || 1;
      run('UPDATE items SET data=? WHERE id=?', JSON.stringify(nd), row.id); return send(res, 200, { ok: 1 }); }
    if (m === 'PATCH') { admin(); const d = JSON.parse(row.data), wasCancelled = !!d.x; if (row.kind === 'ct') { if ('done' in b) d.done = b.done ? 1 : 0; if ('x' in b) { if (!b.x && wasCancelled) { const cc = all_("SELECT data FROM items WHERE kind='course'").map(r => JSON.parse(r.data)).find(c => c.code === d.c); if (cc) checkLimit(cc, d.ty || 'CT', row.id, true); } d.x = b.x ? 1 : 0; d.xt = Date.now(); } } else if (row.kind === 'event') { if ('done' in b) d.done = b.done ? 1 : 0; if ('x' in b) { if (!b.x && wasCancelled && d.k === 'ct') checkEventTest(d, row.id, true); d.x = b.x ? 1 : 0; d.xt = Date.now(); } } else if (row.kind === 'notice' || row.kind === 'msg') d.pin = b.pin ? 1 : 0; else bad('Not editable'); run('UPDATE items SET data=? WHERE id=?', JSON.stringify(d), row.id); if (row.kind === 'ct' && wasCancelled !== !!d.x) pushAlert(u.id, 'ct', d, row.id + (d.x ? 'x' : 'r')); if (row.kind === 'event' && wasCancelled !== !!d.x) pushAlert(u.id, 'event', d, row.id + (d.x ? 'x' : 'r')); return send(res, 200, { ok: 1 }); }
    // legacy personal calendar events (created before the calendar became admin-only) can still be removed by their owner
    const legacy = row.kind === 'event' && row.owner === u.id && !JSON.parse(row.data).sh;
    if (!legacy) { if (row.kind === 'msg') { if (!isStaff(u) && row.owner !== u.id) throw { code: 403, error: 'You can only delete your own messages' }; } else if (row.kind === 'photo') { if (!isStaff(u) && row.owner !== u.id) throw { code: 403, error: 'You can only delete your own photos' }; } else if (ADMIN.has(row.kind) || row.kind === 'fb') admin(); else throw { code: 403, error: 'Not allowed' }; }
    await deleteCloudAsset(JSON.parse(row.data).cloud);
    run('DELETE FROM items WHERE id=?', row.id);
    if (row.kind === 'msg') dropMsg(row);
    if (row.kind === 'node') { const ns = nodes(), dead = [row.id]; for (let i = 0; i < dead.length; i++) ns.filter(y => y.p === dead[i]).forEach(y => dead.push(y.id)); for (const id of dead) { const child = ns.find(y => y.id === id); await deleteCloudAsset(child?.cloud); run('DELETE FROM items WHERE id=?', id); try { fs.unlinkSync(path.join(UP, id)); } catch {} } }
    if (row.kind === 'photo') { try { fs.unlinkSync(path.join(UP, row.id + '.thumb.jpg')); } catch {} }
    if (row.kind === 'photo') { try { fs.unlinkSync(path.join(UP, row.id)); } catch {} }
    if (row.kind === 'poll') run('DELETE FROM votes WHERE poll=?', row.id);
    if (row.kind === 'course') run("DELETE FROM items WHERE kind='att' AND json_extract(data,'$.c')=?", row.id);
    return send(res, 200, { ok: 1 });
  }
  throw { code: 404, error: 'No such endpoint' };
}

// ---- static files + server ----------------------------------------------------
const MT = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
async function handleRequest(req, res) {
  try {
    res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Content-Security-Policy', "frame-ancestors 'none'"); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    const p = new URL(req.url, 'http://x').pathname;
    if (p.startsWith('/api/')) return await api(req, res, req.method, p);
    let f = path.join(PUB, p === '/' ? 'index.html' : decodeURIComponent(p));
    // clean URLs (/tests, /courses, /developer ...): paths without a file extension that match no real file get the app shell
    const inPub = x => x === PUB || x.startsWith(PUB + path.sep);
    if (!path.extname(p) && (!inPub(f) || !fs.existsSync(f) || fs.statSync(f).isDirectory())) f = path.join(PUB, 'index.html');
    if (!inPub(f) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('Not found'); }
    if (path.basename(f) === 'index.html') { // fill in absolute URLs for link previews (WhatsApp, Telegram, ...)
      const origin = (process.env.SITE_URL || ((req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim() + '://' + (req.headers['x-forwarded-host'] || req.headers.host || 'localhost'))).replace(/\/+$/, '');
      const html = fs.readFileSync(f, 'utf8').split('%%ORIGIN%%').join(origin.replace(/[<>"&]/g, ''));
      res.writeHead(200, { 'Content-Type': MT['.html'] }); return res.end(html);
    }
    res.writeHead(200, { 'Content-Type': MT[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  } catch (e) { if (!e.code) console.error(e); res.headersSent ? res.end() : send(res, e.code || 500, { error: e.error || 'Server error' }); }
}

function dumpPersistentState() {
  return {
    users: all_('SELECT id,name,pw,role,profile FROM users'),
    sessions: all_('SELECT token,uid,exp FROM sessions'),
    items: all_('SELECT id,kind,owner,data,ts FROM items'),
    votes: all_('SELECT poll,uid,opt FROM votes'),
    push_subscriptions: all_('SELECT endpoint,uid,data,created FROM push_subscriptions'),
    push_preferences: all_('SELECT uid,data FROM push_preferences')
  };
}
function restorePersistentState(state) {
  const lists = state || {};
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const table of ['votes','push_subscriptions','push_preferences','sessions','items','users']) db.exec(`DELETE FROM ${table}`);
    const insert = {
      users: db.prepare('INSERT INTO users(id,name,pw,role,profile) VALUES(?,?,?,?,?)'),
      sessions: db.prepare('INSERT INTO sessions(token,uid,exp) VALUES(?,?,?)'),
      items: db.prepare('INSERT INTO items(id,kind,owner,data,ts) VALUES(?,?,?,?,?)'),
      votes: db.prepare('INSERT INTO votes(poll,uid,opt) VALUES(?,?,?)'),
      push_subscriptions: db.prepare('INSERT INTO push_subscriptions(endpoint,uid,data,created) VALUES(?,?,?,?)'),
      push_preferences: db.prepare('INSERT INTO push_preferences(uid,data) VALUES(?,?)')
    };
    for (const row of lists.users || []) insert.users.run(row.id,row.name,row.pw,row.role,row.profile || '{}');
    for (const row of lists.sessions || []) insert.sessions.run(row.token,row.uid,row.exp);
    for (const row of lists.items || []) insert.items.run(row.id,row.kind,row.owner ?? null,row.data,row.ts);
    for (const row of lists.votes || []) insert.votes.run(row.poll,row.uid,row.opt);
    for (const row of lists.push_subscriptions || []) insert.push_subscriptions.run(row.endpoint,row.uid,row.data,row.created);
    for (const row of lists.push_preferences || []) insert.push_preferences.run(row.uid,row.data);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

if (require.main === module) http.createServer(handleRequest).listen(PORT, () => console.log(`CUET CSE '25 running at http://localhost:${PORT}`));
module.exports = { timedAlerts, handleRequest, dumpPersistentState, restorePersistentState, cloudinaryEnabled: !!cloudinary };
