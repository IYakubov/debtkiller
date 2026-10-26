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
  const local = path.join(__dirname, 'data.local.json'); // local dev only (gitignored)
  if (fs.existsSync(local)) return JSON.parse(fs.readFileSync(local, 'utf8'));
  return null;
}
const DEBT = loadDebtData();
const DEBT_IDS = new Set(DEBT ? DEBT.debts.map(d => d.id) : []);

fs.mkdirSync(DATA_DIR, { recursive: true });
function readState() {
  let s;
  try { s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { s = {}; }
  s.payments = s.payments || [];
  s.balances = s.balances || {};
  s.income = s.income || 0;
  s.incomeLog = s.incomeLog || [];
  // v1 → v2: per-contract ticks become Tezcoin payments
  if (s.done && !s.migrated) {
    for (const [id, v] of Object.entries(s.done)) {
      if (!id.startsWith('TZ-') && id !== 'BNPL' && !id.startsWith('TBC-')) continue;
      const amount = v && typeof v === 'object' && v.amount ? v.amount : 0;
      const at = v && typeof v === 'object' ? v.at : v;
      if (amount) s.payments.push({ id: crypto.randomUUID(), debt: id.startsWith('TZ-') ? 'TZ' : id, amount, at });
    }
    s.migrated = true;
  }
  return s;
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

const tries = new Map(); // brute-force guard per IP
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
const money = v => { const a = Math.round(Number(v)); return Number.isFinite(a) && a > 0 && a < 1e10 ? a : null; };

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

    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    if (!authed(req)) return send(res, 401, { error: 'locked' });
    if (!DEBT) return send(res, 500, { error: 'DEBT_DATA is not configured' });

    if (req.method === 'GET' && url.pathname === '/api/state')
      return send(res, 200, { debt: DEBT, state: readState() });

    if (req.method !== 'POST') return send(res, 404, { error: 'not found' });
    const body = await readBody(req);
    const s = readState();
    const at = new Date().toISOString();

    if (url.pathname === '/api/pay') {
      const amount = money(body.amount);
      if (!DEBT_IDS.has(body.debt) || !amount) return send(res, 400, { error: 'bad payment' });
      s.payments.push({ id: crypto.randomUUID(), debt: body.debt, amount, at });
    } else if (url.pathname === '/api/undo') {
      const before = s.payments.length;
      s.payments = s.payments.filter(p => p.id !== body.id);
      if (s.payments.length === before) return send(res, 404, { error: 'payment not found' });
    } else if (url.pathname === '/api/balance') {
      // "the app says I still owe X" — correct drift (interest, markup, regular payments)
      const left = Math.round(Number(body.left));
      if (!DEBT_IDS.has(body.debt) || !Number.isFinite(left) || left < 0 || left > 1e10) return send(res, 400, { error: 'bad balance' });
      s.balances[body.debt] = { left, at };
    } else if (url.pathname === '/api/income') {
      const amount = money(body.amount);
      if (!amount) return send(res, 400, { error: 'bad amount' });
      s.income += amount;
      s.incomeLog.push({ amount, at });
    } else return send(res, 404, { error: 'not found' });

    writeState(s);
    return send(res, 200, { state: s });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'server error' });
  }
}).listen(PORT, () => console.log(`DebtKiller on :${PORT} · state at ${STATE_FILE} · data ${DEBT ? 'loaded' : 'MISSING'}`));
