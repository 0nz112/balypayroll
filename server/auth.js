// Email/password login against auth.users (bcrypt via pgcrypto) + signed session cookies.
import crypto from 'node:crypto';
import { asOwner } from './db.js';

let SECRET = process.env.SESSION_SECRET;
if (!SECRET || SECRET.length < 32) {
  if (process.env.NODE_ENV === 'production') console.warn('⚠ SESSION_SECRET missing or shorter than 32 chars — using a random one; users will be signed out on every restart.');
  SECRET = crypto.randomBytes(48).toString('hex');
}
const TTL_HOURS = Number(process.env.SESSION_HOURS || 12);
export const COOKIE = 'sp_session';

const b64 = (b) => Buffer.from(b).toString('base64url');
const sign = (data) => crypto.createHmac('sha256', SECRET).update(data).digest('base64url');

export function issueToken(uid, pwStamp) {
  const body = b64(JSON.stringify({ uid, ps: pwStamp, exp: Date.now() + TTL_HOURS * 3600e3 }));
  return `${body}.${sign(body)}`;
}

export function readToken(token) {
  if (!token || typeof token !== 'string') return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  const expect = sign(body);
  if (mac.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.uid || !p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

export function cookieHeader(value, secure, maxAgeSec) {
  return `${COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

/** Validates a session: signature, expiry, and that the password hasn't changed since. */
export async function sessionUser(token) {
  const p = readToken(token);
  if (!p) return null;
  const r = await asOwner((c) => c.query("select id, extract(epoch from updated_at)::bigint::text as ps from auth.users where id = $1", [p.uid]));
  const u = r.rows[0];
  if (!u || String(u.ps) !== String(p.ps)) return null;
  return u.id;
}

const MAX_FAILS = 5, LOCK_MIN = 10;
export async function login(email, password) {
  return asOwner(async (c) => {
    const r = await c.query(`select u.id, u.locked_until > now() as locked, p.status,
        (u.encrypted_password is not null and u.encrypted_password = crypt($2, u.encrypted_password)) as ok,
        extract(epoch from u.updated_at)::bigint::text as ps
      from auth.users u left join public.profiles p on p.id = u.id where lower(u.email) = lower($1)`, [String(email || '').trim(), String(password || '')]);
    const u = r.rows[0];
    if (!u) return { error: 'LOGIN' };
    if (u.locked === true || u.locked === 't') return { error: 'LOCKED' };
    const ok = u.ok === true || u.ok === 't';
    if (!ok) {
      await c.query(`update auth.users set failed_logins = failed_logins + 1,
        locked_until = case when failed_logins + 1 >= ${MAX_FAILS} then now() + interval '${LOCK_MIN} minutes' else locked_until end where id = $1`, [u.id]);
      return { error: 'LOGIN' };
    }
    if (u.status !== 'active') return { error: 'ACCOUNT_INACTIVE' };
    // failed_logins/last_sign_in changes must not bump updated_at (it stamps sessions)
    await c.query('update auth.users set failed_logins = 0, locked_until = null, last_sign_in_at = now() where id = $1', [u.id]);
    return { uid: u.id, ps: u.ps };
  });
}

export function validPassword(pw) { return typeof pw === 'string' && pw.length >= 8 && pw.length <= 128; }

export async function setPassword(uid, password) {
  await asOwner((c) => c.query("update auth.users set encrypted_password = crypt($2, gen_salt('bf', 10)), updated_at = now(), failed_logins = 0, locked_until = null where id = $1", [uid, password]));
}

export async function createAccount({ email, password, full_name, phone, role = 'manager' }, actor) {
  return asOwner(async (c) => {
    const exists = await c.query('select 1 from auth.users where lower(email) = lower($1)', [email]);
    if (exists.rows.length) { const e = new Error('DUPLICATE_EMAIL'); e.status = 400; throw e; }
    const meta = JSON.stringify({ role, status: 'active', full_name, phone: phone || null });
    const r = await c.query(`insert into auth.users (email, encrypted_password, email_confirmed_at, aud, role, raw_app_meta_data)
      values (lower($1), crypt($2, gen_salt('bf', 10)), now(), 'authenticated', 'authenticated', $3::jsonb) returning id`, [email, password, meta]);
    const id = r.rows[0].id;
    await c.query(`insert into public.audit_log (actor, action, table_name, row_id, new_data, reason)
      values ($1, 'ADMIN_CREATE', 'auth.users', $2, $3::jsonb, 'create account')`, [actor, id, JSON.stringify({ email, full_name, role })]);
    return id;
  });
}
