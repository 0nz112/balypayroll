// HTTP server: JSON API + static frontend (dist/). No framework, one dependency (pg).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { asUser, asOwner, pool } from './db.js';
import { callRpc, runQuery } from './api.js';
import { COOKIE, cookieHeader, createAccount, issueToken, login, parseCookies, sessionUser, setPassword, validPassword } from './auth.js';
import { migrate } from './migrate.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, process.env.STATIC_DIR || 'dist');
const PORT = Number(process.env.PORT || 3000);
const MAX_BODY = 8 * 1024 * 1024;
const SESSION_MAX_AGE = Number(process.env.SESSION_HOURS || 12) * 3600;

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain' };
const SECURITY = {
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin', 'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' data: https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...SECURITY, ...headers });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(Object.assign(new Error('VALIDATION'), { status: 413, detail: 'body too large' })); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!chunks.length) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(Object.assign(new Error('VALIDATION'), { status: 400, detail: 'json' })); } });
    req.on('error', reject);
  });
}

function sendError(res, e) {
  const code = e.code === 'P0001' || /^[A-Z_]+$/.test(e.message) ? e.message : e.code === '42501' ? 'FORBIDDEN' : e.code === '23505' ? 'DUPLICATE' : 'SERVER_ERROR';
  const status = e.status || (code === 'NOT_AUTHENTICATED' ? 401 : code === 'FORBIDDEN' ? 403 : code === 'NOT_FOUND' ? 404 : code === 'SERVER_ERROR' ? 500 : 400);
  if (status >= 500) console.error(e);
  send(res, status, { error: code, detail: code === 'SERVER_ERROR' ? '' : e.detail || '' });
}

// simple per-IP throttle for login
const hits = new Map();
function throttled(ip) {
  const now = Date.now(); const h = (hits.get(ip) || []).filter((t) => now - t < 60_000);
  h.push(now); hits.set(ip, h); return h.length > 20;
}

async function handleApi(req, res, url) {
  const route = url.pathname.slice(5); // after /api/
  const secure = req.headers['x-forwarded-proto'] === 'https' || process.env.COOKIE_SECURE === 'true';
  if (route === 'health') {
    try { await pool.query('select 1'); return send(res, 200, { ok: true }); } catch { return send(res, 503, { ok: false }); }
  }
  if (req.method !== 'POST') return send(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  // CSRF: a custom header cannot be sent cross-site without a CORS preflight (none is allowed)
  if (req.headers['x-requested-with'] !== 'salesapp') return send(res, 403, { error: 'FORBIDDEN', detail: 'csrf' });
  const body = await readBody(req);

  if (route === 'auth/login') {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    if (throttled(ip)) return send(res, 429, { error: 'LOCKED' });
    const r = await login(body.email, body.password);
    if (r.error) return send(res, r.error === 'LOGIN' ? 401 : 403, { error: r.error });
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader(issueToken(r.uid, r.ps), secure, SESSION_MAX_AGE) });
  }
  if (route === 'auth/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', secure, 0) });

  const uid = await sessionUser(parseCookies(req.headers.cookie)[COOKIE]);
  if (!uid) return send(res, 401, { error: 'NOT_AUTHENTICATED' });

  if (route === 'auth/me') return send(res, 200, await asUser(uid, (c) => runQuery(c, 'me')));
  if (route.startsWith('rpc/')) return send(res, 200, { data: await asUser(uid, (c) => callRpc(c, route.slice(4), body.args || {})) });
  if (route.startsWith('q/')) return send(res, 200, { data: await asUser(uid, (c) => runQuery(c, route.slice(2), body.args || {})) });

  if (route === 'prefs') {
    await asUser(uid, (c) => c.query(`insert into public.user_preferences (user_id, prefs) values (auth.uid(), $1::jsonb)
      on conflict (user_id) do update set prefs = excluded.prefs`, [JSON.stringify(body.prefs || {})]));
    return send(res, 200, { ok: true });
  }
  if (route === 'auth/password') {
    if (!validPassword(body.next)) return send(res, 400, { error: 'VALIDATION', detail: 'password' });
    const ok = await asOwner((c) => c.query('select (encrypted_password = crypt($2, encrypted_password)) as ok from auth.users where id = $1', [uid, String(body.current || '')]));
    if (!(ok.rows[0]?.ok === true || ok.rows[0]?.ok === 't')) return send(res, 403, { error: 'LOGIN' });
    await setPassword(uid, body.next);
    return send(res, 200, { ok: true }, { 'Set-Cookie': cookieHeader('', secure, 0) });
  }

  // --- Super Admin account management
  if (route.startsWith('admin/')) {
    const isAdmin = await asUser(uid, async (c) => (await c.query('select public.is_admin() as a')).rows[0].a);
    if (!(isAdmin === true || isAdmin === 't')) return send(res, 403, { error: 'FORBIDDEN' });
    if (route === 'admin/create-manager') {
      const email = String(body.email || '').trim().toLowerCase();
      const full_name = String(body.full_name || '').trim();
      const phone = String(body.phone || '').replace(/[^0-9+]/g, '');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !validPassword(body.password) || full_name.length < 2 || (phone && !/^\+?[0-9]{7,15}$/.test(phone))) {
        return send(res, 400, { error: 'VALIDATION', detail: 'manager' });
      }
      return send(res, 200, { id: await createAccount({ email, password: body.password, full_name, phone }, uid) });
    }
    if (route === 'admin/reset-password') {
      if (!validPassword(body.password)) return send(res, 400, { error: 'VALIDATION', detail: 'password' });
      const t = await asOwner((c) => c.query("select 1 from public.profiles where id = $1 and role = 'manager'", [body.id]));
      if (!t.rows.length || body.id === uid) return send(res, 404, { error: 'NOT_FOUND' });
      await setPassword(body.id, body.password);
      await asOwner((c) => c.query("insert into public.audit_log (actor, action, table_name, row_id, reason) values ($1, 'ADMIN_RESET_PASSWORD', 'auth.users', $2, 'reset password')", [uid, body.id]));
      return send(res, 200, { ok: true });
    }
  }
  return send(res, 404, { error: 'NOT_FOUND' });
}

function serveStatic(req, res, url) {
  let p = decodeURIComponent(url.pathname);
  if (p === '/') p = '/index.html';
  const file = path.normalize(path.join(DIST, p));
  if (!file.startsWith(DIST)) return send(res, 403, 'forbidden', { 'Content-Type': 'text/plain' });
  fs.stat(file, (err, st) => {
    const target = !err && st.isFile() ? file : path.join(DIST, 'index.html');
    const ext = path.extname(target);
    const immutable = /\/assets\//.test(target) && target !== path.join(DIST, 'index.html');
    fs.readFile(target, (e2, data) => {
      if (e2) return send(res, 404, 'Not built yet — run npm run build', { 'Content-Type': 'text/plain' });
      res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', ...SECURITY,
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' });
      res.end(data);
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) await handleApi(req, res, url);
    else serveStatic(req, res, url);
  } catch (e) { sendError(res, e); }
});

if (process.env.MIGRATE !== 'false') {
  try { await migrate(); } catch (e) { console.error('✗', e.message); process.exit(1); }
}
server.listen(PORT, () => console.log(`✓ listening on :${PORT}`));
for (const s of ['SIGTERM', 'SIGINT']) process.on(s, () => { server.close(); pool.end().finally(() => process.exit(0)); });
