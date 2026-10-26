// DebtKiller — tiny no-dependency Node server.
// Debt data comes from the DEBT_DATA env var (base64 gzip JSON) so it never lives in the repo.
// Progress is saved to $DATA_DIR/state.json (mount a Railway volume at /data).
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const PIN = String(process.env.PIN || '');
const SECRET = process.env.SECRET || crypto.createHash('sha256').update('dk:' + PIN).digest('hex');
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, '.data'));
const STATE_FILE = path.join(DATA_DIR, 'state.json');

function loadDebtData() {
  if (process.env.DEBT_DATA) {
    return JSON.parse(zlib.gunzipSync(Buffer.from(process.env.DEBT_DATA, 'base64')).toString('utf8'));
  }
  const local = path.join(__dirname, 'data.local.json'); // for local dev only (gitignored)
  if (fs.existsSync(local)) return JSON.parse(fs.readFileSync(local, 'utf8'));
  return null;
}
const DEBT = loadDebtData();

fs.mkdirSync(DATA_DIR, { recursive: true });
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { done: {}, log: [] }; }
}
function writeState(s) {
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, STATE_FILE); // atomic replace so a crash never corrupts progress
}

const token = () => crypto.createHmac('sha256', SECRET).update('ok:' + PIN).digest('hex');
function authed(req) {
  if (!PIN) return true;
  const m = /(?:^|;\s*)dk=([a-f0-9]+)/.exec(req.headers.cookie || '');
  return !!m && m[1].length === token().length &&
    crypto.timingSafeEqual(Buffer.from(m[1]), Buffer.from(token()));
}

const tries = new Map(); // simple brute-force guard per IP
function limited(ip) {
  const now = Date.now(), t = (tries.get(ip) || []).filter(x => now - x < 15 * 60e3);
  tries.set(ip, t);
  return t.length >= 8;
}

function send(res, code, body, type = 'application/json', extra = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...extra });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req) {
  return new Promise((ok, bad) => {
    let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { bad(e); } });
  });
}

const INDEX = fs.readFileSync(path.join(__dirname, 'public', 'index.html'));

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html'))
      return send(res, 200, INDEX, 'text/html; charset=utf-8');
    if (url.pathname === '/health') return send(res, 200, { ok: true });

    if (req.method === 'POST' && url.pathname === '/api/login') {
      const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
      if (limited(ip)) return send(res, 429, { error: 'Too many tries. Wait 15 minutes.' });
      const { pin } = await readBody(req);
      if (PIN && String(pin) !== PIN) { tries.get(ip).push(Date.now()); return send(res, 401, { error: 'Wrong PIN' }); }
      return send(res, 200, { ok: true }, 'application/json', {
        'Set-Cookie': `dk=${token()}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${60 * 60 * 24 * 120}`,
      });
    }

    if (url.pathname.startsWith('/api/')) {
      if (!authed(req)) return send(res, 401, { error: 'locked' });
      if (!DEBT) return send(res, 500, { error: 'DEBT_DATA is not configured' });

      if (req.method === 'GET' && url.pathname === '/api/state')
        return send(res, 200, { debt: DEBT, state: readState(), now: new Date().toISOString() });

      if (req.method === 'POST' && url.pathname === '/api/toggle') {
        const { id } = await readBody(req);
        if (!DEBT.enemies.some(e => e.id === id)) return send(res, 400, { error: 'unknown id' });
        const s = readState();
        if (s.done[id]) { delete s.done[id]; s.log.push({ id, undo: true, at: new Date().toISOString() }); }
        else { s.done[id] = new Date().toISOString(); s.log.push({ id, at: s.done[id] }); }
        s.log = s.log.slice(-500);
        writeState(s);
        return send(res, 200, { state: s });
      }

      if (req.method === 'POST' && url.pathname === '/api/income') {
        const { amount } = await readBody(req);
        const a = Math.round(Number(amount));
        if (!Number.isFinite(a) || a === 0 || Math.abs(a) > 1e9) return send(res, 400, { error: 'bad amount' });
        const s = readState();
        s.income = (s.income || 0) + a;
        s.log.push({ income: a, at: new Date().toISOString() });
        s.log = s.log.slice(-500);
        writeState(s);
        return send(res, 200, { state: s });
      }
    }
    send(res, 404, { error: 'not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'server error' });
  }
}).listen(PORT, () => console.log(`DebtKiller on :${PORT} · state at ${STATE_FILE} · data ${DEBT ? 'loaded' : 'MISSING'}`));
