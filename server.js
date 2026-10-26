'use strict';
// Artemis Dashboard — password-protected ops terminal. No secrets are ever logged.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const PORT = parseInt(process.env.PORT || '8080', 10);
const COOKIE = 'artemis_sess';
const SESSION_TTL_S = 12 * 3600;
const HISTORY_DAYS = 30;
const MAX_BODY = 4 * 1024 * 1024;
const SECURE_COOKIE = process.env.INSECURE_COOKIE === '1' ? '' : '; Secure';

// ---- required secrets -------------------------------------------------------
if (!process.env.DASHBOARD_PASSWORD) {
  console.error('FATAL: DASHBOARD_PASSWORD is not set; refusing to start.');
  process.exit(1);
}
if (!process.env.INGEST_TOKEN || process.env.INGEST_TOKEN.length < 32) {
  console.error('FATAL: INGEST_TOKEN missing or too short; refusing to start.');
  process.exit(1);
}
const PW_HASH = bcrypt.hashSync(process.env.DASHBOARD_PASSWORD, 12);
const INGEST_HASH = crypto.createHash('sha256').update(process.env.INGEST_TOKEN).digest();
const SESSION_KEY = process.env.SESSION_SECRET && process.env.SESSION_SECRET.length >= 32
  ? process.env.SESSION_SECRET : crypto.randomBytes(32).toString('hex');
delete process.env.DASHBOARD_PASSWORD;
delete process.env.INGEST_TOKEN;
delete process.env.SESSION_SECRET;
const BLOB_SAS_URL = process.env.BLOB_SAS_URL || '';
delete process.env.BLOB_SAS_URL;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

// ---- Ops Terminal sandbox bootstrap ----------------------------------------
// Production: launch.js (root) spawned this server as an unprivileged uid and runs
// commands for us over IPC as a separate sandbox uid. Dev: optional in-process mode.
const ops = { mode: 'disabled', reason: 'no sandbox runner (start via launch.js as root with OPS_SANDBOX_UID)', info: null, limits: null, pending: new Map(), local: null };
if (process.env.OPS_TERMINAL === '0') ops.reason = 'OPS_TERMINAL=0';
else if (process.env.OPS_PARENT_RUNNER === '1' && process.send) {
  ops.mode = 'starting';
  process.on('message', m => {
    if (m && m.type === 'ready') { ops.mode = 'runner'; ops.info = m.info; ops.limits = m.limits; ops.reason = null; console.log('ops runner ready:', JSON.stringify(m.info)); }
    else if (m && m.type === 'result' && ops.pending.has(m.id)) { ops.pending.get(m.id)(m.result); ops.pending.delete(m.id); }
  });
  process.on('disconnect', () => { ops.mode = 'disabled'; ops.reason = 'runner disconnected'; process.exit(1); });
  process.send({ type: 'hello' });
} else if (process.env.OPS_ALLOW_SAME_UID === '1') {
  // Dev only: commands run as THIS uid (reduced isolation, flagged in the UI).
  ops.local = require('./ops/sandbox'); ops.mode = 'in-process (reduced isolation)'; ops.info = ops.local.info(); ops.limits = ops.local.LIMITS; ops.reason = null;
}
for (const k of ['OPS_PARENT_RUNNER', 'OPS_ALLOW_SAME_UID']) delete process.env[k];
function opsRun(command, timeout) {
  if (ops.local) return ops.local.run(command, timeout);
  if (ops.mode !== 'runner') return Promise.resolve(null);
  const id = crypto.randomBytes(8).toString('hex');
  return new Promise(resolve => { ops.pending.set(id, resolve); process.send({ type: 'run', id, command, timeout }); });
}

// ---- storage (Azure Blob via container SAS, else local dir) ----------------
function blobUrl(name, extra) {
  const u = new URL(BLOB_SAS_URL);
  if (name) u.pathname = u.pathname.replace(/\/$/, '') + '/' + name;
  if (extra) for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
  return u.toString();
}
const store = {
  async put(name, text) {
    if (!BLOB_SAS_URL) { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(path.join(DATA_DIR, name), text); return; }
    const r = await fetch(blobUrl(name), { method: 'PUT', body: text, headers: { 'x-ms-blob-type': 'BlockBlob', 'content-type': 'application/json', 'x-ms-version': '2021-08-06' } });
    if (!r.ok) throw new Error('blob put ' + r.status);
  },
  async get(name) {
    if (!BLOB_SAS_URL) { try { return fs.readFileSync(path.join(DATA_DIR, name), 'utf8'); } catch { return null; } }
    const r = await fetch(blobUrl(name), { headers: { 'x-ms-version': '2021-08-06' } });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error('blob get ' + r.status);
    return r.text();
  },
  async list() {
    if (!BLOB_SAS_URL) { try { return fs.readdirSync(DATA_DIR); } catch { return []; } }
    const r = await fetch(blobUrl('', { restype: 'container', comp: 'list' }), { headers: { 'x-ms-version': '2021-08-06' } });
    if (!r.ok) throw new Error('blob list ' + r.status);
    const xml = await r.text();
    return [...xml.matchAll(/<Name>([^<]+)<\/Name>/g)].map(m => m[1]);
  },
  async del(name) {
    if (!BLOB_SAS_URL) { try { fs.unlinkSync(path.join(DATA_DIR, name)); } catch {} return; }
    await fetch(blobUrl(name), { method: 'DELETE', headers: { 'x-ms-version': '2021-08-06' } });
  },
};

let latest = null;          // most recent snapshot object
let history = new Map();    // 'YYYY-MM-DD' (ET) -> snapshot
function etDate(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
async function loadState() {
  try {
    const names = (await store.list()).filter(n => /^day-\d{4}-\d{2}-\d{2}\.json$/.test(n)).sort().slice(-HISTORY_DAYS);
    for (const n of names) { const t = await store.get(n); if (t) history.set(n.slice(4, 14), JSON.parse(t)); }
    const l = await store.get('latest.json'); if (l) latest = JSON.parse(l);
    console.log(`state loaded: ${history.size} day(s), latest=${latest ? 'yes' : 'no'}`);
  } catch (e) { console.error('state load failed:', e.message); }
}
async function saveSnapshot(snap) {
  const day = etDate(new Date());
  latest = snap; history.set(day, snap);
  const text = JSON.stringify(snap);
  await store.put('latest.json', text);
  await store.put(`day-${day}.json`, text);
  const days = [...history.keys()].sort();
  while (days.length > HISTORY_DAYS) { const old = days.shift(); history.delete(old); await store.del(`day-${old}.json`); }
}

// ---- sessions ---------------------------------------------------------------
const b64u = b => Buffer.from(b).toString('base64url');
function sign(s) { return crypto.createHmac('sha256', SESSION_KEY).update(s).digest('base64url'); }
function makeSession() {
  const payload = b64u(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_TTL_S, n: crypto.randomBytes(12).toString('hex') }));
  return payload + '.' + sign(payload);
}
const revoked = new Set();
function validSession(req) {
  const c = parseCookies(req.headers.cookie || '')[COOKIE];
  if (!c || revoked.has(c)) return false;
  const [p, s] = c.split('.');
  if (!p || !s) return false;
  const a = Buffer.from(sign(p)), b = Buffer.from(s);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  try { return JSON.parse(Buffer.from(p, 'base64url').toString()).exp > Date.now() / 1000; } catch { return false; }
}
function sessionId(req) {
  const c = parseCookies(req.headers.cookie || '')[COOKIE] || '';
  try { return JSON.parse(Buffer.from(c.split('.')[0], 'base64url').toString()).n || ''; } catch { return ''; }
}
function parseCookies(h) {
  const o = {};
  for (const part of h.split(';')) { const i = part.indexOf('='); if (i > 0) o[part.slice(0, i).trim()] = part.slice(i + 1).trim(); }
  return o;
}

// ---- login rate limiting ----------------------------------------------------
const WINDOW_MS = 15 * 60 * 1000, PER_IP = 5, GLOBAL = 50;
const fails = new Map(); let globalFails = [];
function clientIp(req) {
  const xff = (req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean);
  return xff[0] || req.socket.remoteAddress || 'unknown';
}
function limited(ip) {
  const now = Date.now();
  globalFails = globalFails.filter(t => now - t < WINDOW_MS);
  const f = (fails.get(ip) || []).filter(t => now - t < WINDOW_MS);
  fails.set(ip, f);
  return f.length >= PER_IP || globalFails.length >= GLOBAL;
}
function recordFail(ip) { const now = Date.now(); fails.get(ip).push(now); globalFails.push(now); }

// ---- Ops Terminal: audit + per-session rate limits ---------------------------
const { createAudit } = require('./ops/audit');
const { redact } = require('./ops/policy');
const audit = createAudit(store);
const OPS_RATE = { per_minute: 20, per_day: 400, queue_max: 4 };
const opsHits = new Map(); // sid hash -> [timestamps ms] (last 24 h)
let opsQueued = 0;
const sidHash = n => crypto.createHash('sha256').update('ops-sid:' + n).digest('hex').slice(0, 12);
function opsRateCheck(h) {
  const now = Date.now();
  const arr = (opsHits.get(h) || []).filter(t => now - t < 86400000); opsHits.set(h, arr);
  if (arr.filter(t => now - t < 60000).length >= OPS_RATE.per_minute) return `rate limit: ${OPS_RATE.per_minute}/min per session`;
  if (arr.length >= OPS_RATE.per_day) return `rate limit: ${OPS_RATE.per_day}/day per session`;
  if (opsQueued >= OPS_RATE.queue_max) return 'busy: too many queued commands';
  arr.push(now); return null;
}

// ---- http helpers -----------------------------------------------------------
const SEC_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000', 'Cache-Control': 'no-store',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
function send(res, code, body, type = 'text/html; charset=utf-8', extra = {}) {
  res.writeHead(code, { ...SEC_HEADERS, 'Content-Type': type, ...extra }); res.end(body);
}
const json = (res, code, obj) => send(res, code, JSON.stringify(obj), 'application/json');
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject);
  });
}
const PUB = path.join(__dirname, 'public');
const STATIC = {
  '/static/login.css': ['login.css', 'text/css', false],
  '/static/app.css': ['app.css', 'text/css', true],
  '/static/app.js': ['app.js', 'application/javascript', true],
  '/static/favicon.svg': ['favicon.svg', 'image/svg+xml', false],
  '/static/terminal.js': ['terminal.js', 'application/javascript', true],
  '/static/ops-usage.js': ['ops-usage.js', 'application/javascript', true],
};
function loginPage(msg) {
  return fs.readFileSync(path.join(PUB, 'login.html'), 'utf8').replace('{{MSG}}', msg ? `<p class="err" role="alert">${msg}</p>` : '');
}

// ---- routes -----------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  try {
    if (p === '/healthz') return send(res, 200, 'ok', 'text/plain');
    if (STATIC[p]) {
      const [f, t, needAuth] = STATIC[p];
      if (needAuth && !validSession(req)) return send(res, 401, 'unauthorized', 'text/plain');
      return send(res, 200, fs.readFileSync(path.join(PUB, f)), t);
    }
    if (p === '/login' && req.method === 'GET') {
      if (validSession(req)) return send(res, 302, '', 'text/plain', { Location: '/' });
      return send(res, 200, loginPage(''));
    }
    if (p === '/login' && req.method === 'POST') {
      const ip = clientIp(req);
      if (limited(ip)) return send(res, 429, loginPage('Too many attempts. Try again in 15 minutes.'), undefined, { 'Retry-After': '900' });
      const pw = new URLSearchParams(await readBody(req)).get('password') || '';
      if (pw && await bcrypt.compare(pw, PW_HASH)) {
        fails.delete(ip);
        return send(res, 303, '', 'text/plain', { Location: '/', 'Set-Cookie': `${COOKIE}=${makeSession()}; Path=/; HttpOnly${SECURE_COOKIE}; SameSite=Strict; Max-Age=${SESSION_TTL_S}` });
      }
      recordFail(ip);
      console.log('login failed');
      return send(res, 401, loginPage('Incorrect password.'));
    }
    if (p === '/logout' && req.method === 'POST') {
      const c = parseCookies(req.headers.cookie || '')[COOKIE]; if (c) revoked.add(c);
      return send(res, 303, '', 'text/plain', { Location: '/login', 'Set-Cookie': `${COOKIE}=; Path=/; HttpOnly${SECURE_COOKIE}; SameSite=Strict; Max-Age=0` });
    }
    if (p === '/api/ingest' && req.method === 'POST') {
      const auth = req.headers.authorization || '';
      const tok = auth.startsWith('Bearer ') ? auth.slice(7) : '';
      const h = crypto.createHash('sha256').update(tok).digest();
      if (!tok || !crypto.timingSafeEqual(h, INGEST_HASH)) return json(res, 401, { error: 'unauthorized' });
      let snap; try { snap = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'invalid json' }); }
      if (!snap || typeof snap !== 'object' || Array.isArray(snap)) return json(res, 400, { error: 'snapshot must be an object' });
      snap._received_at = new Date().toISOString();
      await saveSnapshot(snap);
      return json(res, 200, { ok: true, days: history.size });
    }
    // everything below needs a session
    if (!validSession(req)) {
      if (p.startsWith('/api/')) return json(res, 401, { error: 'unauthorized' });
      return send(res, 302, '', 'text/plain', { Location: '/login' });
    }
    if (p === '/api/snapshot' && req.method === 'GET') {
      const days = [...history.keys()].sort();
      return json(res, 200, { latest, history: days.map(d => ({ day: d, snapshot: history.get(d) })) });
    }
    if (p === '/' && req.method === 'GET') return send(res, 200, fs.readFileSync(path.join(PUB, 'index.html')));
    if (p === '/terminal' && req.method === 'GET') return send(res, 200, fs.readFileSync(path.join(PUB, 'terminal.html')));
    if (p === '/api/ops/exec' && req.method === 'POST') {
      // CSRF: SameSite=Strict cookie + JSON content type + custom header (not settable cross-site without CORS).
      if (!/^application\/json\b/.test(req.headers['content-type'] || '') || req.headers['x-artemis-ops'] !== '1') return json(res, 400, { error: 'send JSON with header X-Artemis-Ops: 1' });
      let body; try { body = JSON.parse(await readBody(req)); } catch { return json(res, 400, { error: 'invalid json' }); }
      const command = body && typeof body.command === 'string' ? body.command : '';
      const timeout = body && Number.isFinite(body.timeout) ? body.timeout : undefined;
      const sh = sidHash(sessionId(req));
      // Optional agent bookkeeping (idea from the agent_runs / command_logs schema): a run id
      // groups an agent's commands; token counts are caller-reported and logged only if sent.
      const runId = body && typeof body.run_id === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(body.run_id) ? body.run_id : null;
      const tok = k => (body && Number.isInteger(body[k]) && body[k] >= 0 && body[k] < 1e9 ? body[k] : null);
      const base = { sid: sh, run_id: runId, command: redact(command).slice(0, 500), timeout_ms: timeout ?? null, tokens_in: tok('tokens_in'), tokens_out: tok('tokens_out') };
      if (!command.trim()) return json(res, 400, { error: 'command is required' });
      const rl = opsRateCheck(sh);
      if (rl) {
        audit.record({ ...base, status: 'rate_limited', exit_code: null, duration_ms: 0, bytes_out: 0, timed_out: false, truncated: false, blocked: rl });
        return json(res, 429, { error: rl, stdout: '', stderr: '', exit_code: null, duration_ms: 0, timed_out: false, truncated: false, blocked: rl });
      }
      opsQueued++;
      let r; try { r = await opsRun(command, timeout); } finally { opsQueued--; }
      if (!r) {
        audit.record({ ...base, status: 'unavailable', exit_code: null, duration_ms: 0, bytes_out: 0, timed_out: false, truncated: false, blocked: 'sandbox unavailable: ' + ops.reason });
        return json(res, 503, { error: 'sandbox unavailable', detail: ops.reason });
      }
      const status = r.blocked ? 'blocked' : r.timed_out ? 'timeout' : r.exit_code === 0 ? 'ok' : 'failed';
      audit.record({ ...base, status, exit_code: r.exit_code, duration_ms: r.duration_ms, bytes_out: (r.stdout_bytes || 0) + (r.stderr_bytes || 0), stdout_bytes: r.stdout_bytes || 0, stderr_bytes: r.stderr_bytes || 0, cpu_user_ms: r.cpu_user_ms ?? null, cpu_sys_ms: r.cpu_sys_ms ?? null, timed_out: r.timed_out, truncated: r.truncated, blocked: r.blocked });
      return json(res, r.blocked ? 403 : 200, { stdout: r.stdout, stderr: r.stderr, exit_code: r.exit_code, duration_ms: r.duration_ms, timed_out: r.timed_out, truncated: r.truncated, blocked: r.blocked, run_id: runId, stdout_bytes: r.stdout_bytes || 0, stderr_bytes: r.stderr_bytes || 0, cpu_user_ms: r.cpu_user_ms ?? null, cpu_sys_ms: r.cpu_sys_ms ?? null });
    }
    if (p === '/api/ops/usage' && req.method === 'GET') {
      const days = Math.max(1, Math.min(30, parseInt(url.searchParams.get('days') || '14', 10) || 14));
      return json(res, 200, { ...audit.usage(days, 50), sandbox: { mode: ops.mode, reason: ops.reason, isolation: ops.info, limits: ops.limits }, rate_limits: OPS_RATE, you: sidHash(sessionId(req)) });
    }
    return send(res, 404, 'not found', 'text/plain');
  } catch (e) {
    console.error('request error:', e.message);
    if (!res.headersSent) json(res, 500, { error: 'server error' });
  }
});

process.on('SIGTERM', async () => { try { await audit.flushNow(); } catch {} process.exit(0); });
Promise.all([loadState(), audit.load()]).then(() => server.listen(PORT, () => console.log(`artemis-dashboard listening on :${PORT} (storage=${BLOB_SAS_URL ? 'blob' : 'local'}, ops=${ops.mode})`)));
